// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — eligibility classifier (pure).
//
// Decides whether a media element's CURRENT source is safe to route through
// Web Audio. Kept pure so the same logic can be applied at first discovery AND
// re-applied on every source change (an element stays tapped for life, so a
// later cross-origin/DRM source must be re-judged), and so the decision table
// is unit-testable.
//
// Returns one of:
//   "ok"      — safe to tap / keep processing
//   "drm"     — encrypted/EME; protected audio, do not tap (or stop processing)
//   "cors"    — cross-origin without a CORS request; tapping outputs silence
//   "unknown" — source string unparseable; be conservative, don't tap
//   "wait"    — source not established yet; re-check after metadata loads

(function () {
  "use strict";

  // input: { mediaKeys, encrypted, src, readyState, crossOrigin, pageOrigin }
  function classify(input) {
    if (input.mediaKeys || input.encrypted) return "drm";

    const src = input.src || "";
    if (!src) return "wait";
    if (src.startsWith("data:") || src.startsWith("mediastream:")) return "ok";

    // currentSrc is only trustworthy once metadata has loaded.
    if ((input.readyState | 0) < 1) return "wait";

    let origin;
    try { origin = new URL(src).origin; } catch { return "unknown"; }

    // Same-origin (including blob: from this origin, i.e. MSE) is safe.
    if (origin === input.pageOrigin) return "ok";

    // Cross-origin is only safe if a CORS request was made for the resource.
    if (input.crossOrigin === "anonymous" || input.crossOrigin === "use-credentials") return "ok";

    return "cors";
  }

  const api = { classify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.LevelheadEligibility = api;
})();
