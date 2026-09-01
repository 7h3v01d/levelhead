// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — per-tab stats aggregation (pure).
//
// Content scripts run in every frame and each report their own stats to the
// service worker. This folds all live frames of a tab into one deterministic
// tab-level view for the popup, so an empty top frame can't hide the real
// player in a child frame (and vice-versa). Stale frames (navigated away, not
// reporting) are pruned by age.

(function () {
  "use strict";

  // entries: [{ frameId, ts, stats }]; stats as built by content.js.
  function aggregate(entries, now, maxAgeMs = 4000) {
    const live = (entries || []).filter(e => e && now - e.ts <= maxAgeMs);
    const out = {
      frames: live.length,
      tapped: 0, compromised: 0, degraded: 0,
      skips: { drm: 0, cors: 0, inuse: 0, unknown: 0 },
      loudnessDb: null, gainDb: null,
      enabled: true, siteDisabled: false, host: null, observe: false
    };

    let best = null; // frame contributing the representative loudness/gain
    for (const e of live) {
      const s = e.stats || {};
      out.tapped += s.tapped || 0;
      out.compromised += s.compromised || 0;
      out.degraded += s.degraded || 0;
      if (s.skips) for (const k of Object.keys(out.skips)) out.skips[k] += s.skips[k] || 0;
      if ((s.tapped || 0) > 0 && typeof s.loudnessDb === "number") {
        if (!best || (s.tapped || 0) > (best.stats.tapped || 0)) best = e;
      }
    }
    if (best) { out.loudnessDb = best.stats.loudnessDb; out.gainDb = best.stats.gainDb; }

    // Settings are global to the tab; take the top frame's view (else any).
    const top = live.find(e => e.frameId === 0) || live[0];
    if (top) {
      out.enabled = !!top.stats.enabled;
      out.siteDisabled = !!top.stats.siteDisabled;
      out.observe = !!top.stats.observe;
      out.host = top.stats.host || null;
    }
    return out;
  }

  const api = { aggregate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.LevelheadStats = api;
  else if (typeof globalThis !== "undefined") globalThis.LevelheadStats = api;
})();
