// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — content engine.
//
// Safety-first loudness governor built on a per-element record with a SOURCE
// GENERATION (lifecycle.js). Ownership of a media element is irreversible, so:
//   * classification is re-run on every source change; DRM/skip decisions are
//     scoped to the generation, so a later safe source recovers;
//   * a successful tap creates an ownership record BEFORE the worklet loads, so
//     a worklet failure leaves a DEGRADED (owned, passthrough) chain that still
//     tracks source changes rather than vanishing;
//   * detach PARKS the chain (ownership kept); reattach REVIVES it;
//   * BFCache is honoured — the context is only closed on real teardown.

(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true, targetDb: -24, maxBoostDb: 12, maxCutDb: 12,
    compression: "medium", disabledHosts: [], debug: false
  };
  const COMP = {
    off: null,
    gentle: { threshold: -30, knee: 30, ratio: 2, attack: 0.010, release: 0.30, makeupDb: 2 },
    medium: { threshold: -28, knee: 25, ratio: 3, attack: 0.008, release: 0.25, makeupDb: 3 },
    strong: { threshold: -26, knee: 20, ratio: 5, attack: 0.005, release: 0.18, makeupDb: 5 }
  };
  const LIMITER = { threshold: -1.5, knee: 0, ratio: 20, attack: 0.003, release: 0.08 };
  const METER_HZ = 10;
  const WARMUP_STEPS = 8;

  const LC = () => globalThis.LevelheadLifecycle;
  let settings = { ...DEFAULTS };
  let ctx = null;
  let workletReady = null;
  let master = null;

  const rec = new WeakMap();      // el -> lifecycle record (holds its chain)
  const liveChains = new Set();   // active/degraded chains (parked removed)
  const skips = { drm: 0, cors: 0, inuse: 0, unknown: 0 };

  const dbToLin = db => Math.pow(10, db / 20);
  const currentMakeupDb = () => { const cfg = COMP[settings.compression]; return cfg ? cfg.makeupDb : 0; };
  const log = (...a) => { if (settings.debug) console.info("[Levelhead]", ...a); };
  const recOf = el => { let r = rec.get(el); if (!r) { r = LC().newRecord(); rec.set(el, r); } return r; };

  function topHost() {
    if (window.top === window) return location.hostname;
    try { const ao = location.ancestorOrigins; if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname; } catch {}
    try { return window.top.location.hostname; } catch {}
    return location.hostname;
  }
  const TOP_HOST = topHost();
  const siteDisabled = () => settings.disabledHosts.includes(TOP_HOST);
  let settingsReady = false; // fail closed until stored settings load (LH-INV: no tap under unknown authority)
  const active = () => settingsReady && settings.enabled && !siteDisabled();

  // Early capturing DRM observation (before per-element listeners / scan debounce).
  try {
    document.addEventListener("encrypted", e => {
      if (e && e.target instanceof HTMLMediaElement) markEncryptedEl(e.target);
    }, true);
  } catch {}

  const clampNum = (v, lo, hi, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  function sanitize(s) {
    const o = { ...DEFAULTS, ...(s || {}) };
    o.enabled = !!o.enabled;
    o.debug = !!o.debug;
    o.targetDb = clampNum(o.targetDb, -60, -6, DEFAULTS.targetDb);
    o.maxBoostDb = clampNum(o.maxBoostDb, 0, 24, DEFAULTS.maxBoostDb);
    o.maxCutDb = clampNum(o.maxCutDb, 0, 24, DEFAULTS.maxCutDb);
    if (!Object.prototype.hasOwnProperty.call(COMP, o.compression)) o.compression = DEFAULTS.compression;
    if (!Array.isArray(o.disabledHosts)) o.disabledHosts = [];
    return o;
  }

  // ---- settings ----------------------------------------------------------
  chrome.storage.local.get(DEFAULTS, stored => { settings = sanitize(stored); settingsReady = true; scan(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // A storage clear delivers newValue === undefined; fall back to defaults and
    // re-sanitize so corrupt/cleared config can never make a safety path throw.
    const merged = { ...settings };
    for (const k of Object.keys(changes)) merged[k] = changes[k].newValue === undefined ? DEFAULTS[k] : changes[k].newValue;
    settings = sanitize(merged);
    for (const chain of liveChains) applyChain(chain);
    scan();
  });

  // ---- audio context + master bus ----------------------------------------
  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      log("AudioContext", ctx.sampleRate, ctx.state);
      const dspUrl = chrome.runtime.getURL("dsp.js");
      const wkUrl = chrome.runtime.getURL("loudness-processor.js");
      workletReady = ctx.audioWorklet.addModule(dspUrl)
        .then(() => ctx.audioWorklet.addModule(wkUrl))
        .then(() => log("worklet modules loaded"))
        .catch(err => { console.warn("[Levelhead] worklet load failed", err); throw err; });

      const input = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = LIMITER.threshold;
      limiter.knee.value = LIMITER.knee;
      limiter.ratio.value = LIMITER.ratio;
      limiter.attack.value = LIMITER.attack;
      limiter.release.value = LIMITER.release;
      input.connect(limiter);
      limiter.connect(ctx.destination);
      master = { input, limiter };
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  ["pointerdown", "keydown", "touchstart"].forEach(evt =>
    window.addEventListener(evt, () => {
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    }, { capture: true, passive: true })
  );

  // BFCache-aware: only tear down on real unload, not on cache entry.
  window.addEventListener("pagehide", e => {
    if (!e.persisted) { try { if (ctx) ctx.close(); } catch {} }
  });
  window.addEventListener("pageshow", e => {
    if (!e.persisted) return; // restored from BFCache with the same heap + tapped nodes
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    for (const chain of liveChains) hardSafetyReset(chain);
    scan();
  });

  // ---- classification ----------------------------------------------------
  function classifyEl(el, r) {
    return globalThis.LevelheadEligibility.classify({
      mediaKeys: !!el.mediaKeys,
      encrypted: LC().encryptedActive(r),
      src: el.currentSrc || el.src || "",
      readyState: el.readyState,
      crossOrigin: el.crossOrigin,
      pageOrigin: location.origin
    });
  }

  function markEncryptedEl(el) {
    const r = recOf(el);
    LC().markEncrypted(r);
    if (r.chain) reclassify(r.chain, r);
  }

  // One lifecycle listener set per element, kept for its whole life.
  function ensureListeners(el, r) {
    if (r.listenersAttached) return;
    r.listenersAttached = true;
    const onLoadStart = () => {
      LC().bumpGeneration(r);                 // new source generation
      if (r.chain) { hardSafetyReset(r.chain); r.chain.pendingReclassify = true; }
    };
    const onReady = () => {
      if (r.chain) { if (r.chain.pendingReclassify) { r.chain.pendingReclassify = false; reclassify(r.chain, r); } }
      else tryTap(el, r);
    };
    const onEnc = () => markEncryptedEl(el);
    const onPlay = () => { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); };
    el.addEventListener("loadstart", onLoadStart);
    el.addEventListener("loadedmetadata", onReady);
    el.addEventListener("canplay", onReady);
    el.addEventListener("emptied", onLoadStart);
    el.addEventListener("encrypted", onEnc);
    el.addEventListener("play", onPlay);
    r.listeners = [
      ["loadstart", onLoadStart], ["loadedmetadata", onReady], ["canplay", onReady],
      ["emptied", onLoadStart], ["encrypted", onEnc], ["play", onPlay]
    ];
  }

  function consider(el) { const r = recOf(el); ensureListeners(el, r); tryTap(el, r); }

  function tryTap(el, r) {
    if (r.owned || !active()) return;
    if (!LC().shouldReconsider(r)) return;    // already decided THIS generation
    const v = classifyEl(el, r);
    if (v === "wait") return;
    if (v === "ok") { tap(el, r); return; }
    LC().markSkipped(r);
    skips[v] = (skips[v] || 0) + 1;
    log("skip", v, "gen", r.gen, el.currentSrc || el.src);
  }

  // ---- tapping -----------------------------------------------------------
  async function tap(el, r) {
    const c = getCtx();
    let source;
    try {
      source = c.createMediaElementSource(el);
    } catch (e) {
      skips.inuse = (skips.inuse || 0) + 1;
      LC().markSkipped(r);
      console.warn("[Levelhead] createMediaElementSource failed", e);
      return; // native path intact — not owned
    }
    try { source.connect(c.destination); } catch {} // immediate safe passthrough
    r.owned = true;

    // Ownership record BEFORE the worklet await, so a worklet failure still
    // leaves a tracked (degraded) chain rather than an invisible owned element.
    const chain = {
      el, r, source, gain: null, comp: null, makeup: null, meter: null, silent: null,
      ctrl: globalThis.LevelheadAGC.createController(() => settings),
      degraded: false, parked: false, compromised: false, bypassed: false, wasActive: false,
      pendingReclassify: false, lastLoudness: null, lastGainDb: 0, metered: false
    };
    r.chain = chain;
    liveChains.add(chain);
    log("owned", el.tagName, "gen", r.gen);

    try {
      await (workletReady || Promise.resolve());
    } catch (e) {
      degrade(chain, r, e, "worklet load failed");
      return;
    }

    // Any failure building the graph after ownership must also degrade to a
    // tracked passthrough, never leave a half-built chain (LH-INV-07).
    try {
      const gain = c.createGain();
      const comp = c.createDynamicsCompressor();
      const makeup = c.createGain();
      const meter = new AudioWorkletNode(c, "loudness-processor", { processorOptions: { updateHz: METER_HZ } });
      const silent = c.createGain();
      silent.gain.value = 0;
      Object.assign(chain, { gain, comp, makeup, meter, silent });
      meter.port.onmessage = ev => {
        if (!chain.metered) { chain.metered = true; log("meter live", ev.data); }
        onLoudness(chain, ev.data);
      };

      // If the element detached during the await, the chain is parked: nodes are
      // built but MUST NOT be connected here. revive() is the only path allowed
      // to wire a parked chain (LH-INV-05, park is an absolute routing bar).
      if (chain.parked) { log("built while parked; deferring wiring to revive"); return; }

      source.connect(meter);
      meter.connect(silent);
      silent.connect(c.destination);
      applyChain(chain);
      if (c.state === "suspended") c.resume().catch(() => {});
      log("chain active; live streams:", liveChains.size);
    } catch (e) {
      degrade(chain, r, e, "graph construction failed");
    }
  }

  // The single authority boundary: revoke positive gain immediately (a
  // protective cut may survive), reset the meter, and HARD-set the physical
  // GainNode NOW (no glide) so controller and graph can never disagree about
  // live boost. See INVARIANTS.md (LH-INV-02..04).
  function hardSafetyReset(chain) {
    const keep = chain.ctrl.safetyReset(WARMUP_STEPS); // <= 0
    if (chain.meter) { try { chain.meter.port.postMessage({ type: "reset" }); } catch {} }
    if (chain.gain && ctx) {
      const p = chain.gain.gain;
      const now = ctx.currentTime;
      const physDb = globalThis.LevelheadAGC.renderPhysicalDb(keep, currentMakeupDb()); // <= 0 (LH-INV-08)
      try { p.cancelAndHoldAtTime(now); } catch { try { p.cancelScheduledValues(now); } catch {} }
      try { p.setValueAtTime(dbToLin(physDb), now); } catch {}
    }
    chain.lastGainDb = keep; // total commanded (honest popup readout)
  }

  // Owned but unprocessable: drop any partial nodes and fall back to a tracked
  // passthrough that still follows source changes and park/revive (LH-INV-07).
  function degrade(chain, r, e, why) {
    chain.degraded = true;
    console.warn("[Levelhead] " + why + "; degraded passthrough (owned, no leveling)", e);
    [chain.gain, chain.comp, chain.makeup, chain.meter, chain.silent].filter(Boolean)
      .forEach(n => { try { n.disconnect(); } catch {} });
    chain.gain = chain.comp = chain.makeup = chain.meter = chain.silent = null;
    reclassify(chain, r);
    if (!chain.compromised) applyChain(chain);
  }

  // Re-judge the current source of an owned element (source-generation aware).
  function reclassify(chain, r) {
    if (chain.parked) return;
    const v = classifyEl(chain.el, r);
    if (v === "wait") return;
    if (v === "ok") {
      if (chain.compromised) { chain.compromised = false; log("source recovered to eligible"); applyChain(chain); }
      return;
    }
    if (chain.compromised !== v) {
      chain.compromised = v;
      skips[v] = (skips[v] || 0) + 1;
      log("post-tap source now", v, "gen", r.gen, "— transparent best-effort");
    }
    // Transparent best effort; keep the meter branch intact so recovery is clean.
    [chain.gain, chain.comp, chain.makeup].filter(Boolean).forEach(n => { try { n.disconnect(); } catch {} });
    if (chain.gain) { try { chain.source.disconnect(chain.gain); } catch {} }
    try { chain.source.disconnect(master.input); } catch {}
    try { chain.source.connect(ctx.destination); } catch {}
    chain.bypassed = true;
  }

  function applyChain(chain) {
    if (chain.parked || chain.compromised) return; // parked/compromised own their own routing
    const source = chain.source;

    if (chain.degraded) {
      try { source.disconnect(master.input); } catch {}
      try { source.connect(ctx.destination); } catch {} // duplicate connections are ignored
      chain.bypassed = true;
      chain.wasActive = false;
      return;
    }

    const { gain, comp, makeup } = chain;
    [gain, comp, makeup].forEach(n => { try { n.disconnect(); } catch {} });
    try { source.disconnect(gain); } catch {}
    try { source.disconnect(ctx.destination); } catch {}
    try { source.disconnect(master.input); } catch {}

    const on = active();
    if (on && !chain.wasActive) hardSafetyReset(chain); // inactive -> active boundary (first tap, OFF->ON, re-enable)
    chain.bypassed = !on;
    chain.wasActive = on;
    if (!on) { try { source.connect(ctx.destination); } catch {} return; }

    const cfg = COMP[settings.compression];
    source.connect(gain);
    if (cfg) {
      comp.threshold.value = cfg.threshold;
      comp.knee.value = cfg.knee;
      comp.ratio.value = cfg.ratio;
      comp.attack.value = cfg.attack;
      comp.release.value = cfg.release;
      makeup.gain.value = dbToLin(cfg.makeupDb);
      gain.connect(comp);
      comp.connect(makeup);
      makeup.connect(master.input);
    } else {
      gain.connect(master.input);
    }
  }

  function onLoudness(chain, data) {
    if (chain.bypassed || chain.compromised || chain.parked || chain.degraded || !ctx) return;
    const d = chain.ctrl.step(data);
    const physDb = globalThis.LevelheadAGC.renderPhysicalDb(d.gainDb, currentMakeupDb());
    chain.gain.gain.setTargetAtTime(dbToLin(physDb), ctx.currentTime, d.tc);
    chain.lastGainDb = d.gainDb; // total commanded net gain
    chain.lastLoudness = Number.isFinite(data.shortTermDb) ? data.shortTermDb : chain.lastLoudness;
  }

  function park(chain) {
    if (chain.parked) return;
    chain.parked = true;
    liveChains.delete(chain);
    if (chain.meter) { try { chain.meter.port.postMessage({ type: "reset" }); } catch {} }
    [chain.gain, chain.comp, chain.makeup, chain.meter, chain.silent].filter(Boolean)
      .forEach(n => { try { n.disconnect(); } catch {} });
    try { chain.source.disconnect(); } catch {}
    log("chain parked; live streams:", liveChains.size);
  }

  function revive(chain) {
    chain.parked = false;
    liveChains.add(chain);
    // Still under construction in tap() (nodes not built, not degraded): just
    // un-park; tap()'s continuation sees parked=false and wires it.
    if (!chain.meter && !chain.degraded) { log("revive deferred to in-flight tap()"); return; }
    if (chain.meter) {
      try { chain.source.connect(chain.meter); } catch {}
      try { chain.meter.connect(chain.silent); } catch {}
      try { chain.silent.connect(ctx.destination); } catch {}
      try { chain.meter.port.postMessage({ type: "reset" }); } catch {}
    }
    chain.compromised = false;
    hardSafetyReset(chain);
    reclassify(chain, chain.r);
    if (!chain.compromised) applyChain(chain);
    log("chain revived; live streams:", liveChains.size);
  }

  // ---- discovery ---------------------------------------------------------
  let lastFound = -1;
  function scan() {
    for (const chain of liveChains) if (!chain.el.isConnected) park(chain);
    const media = document.querySelectorAll("video, audio");
    if (media.length !== lastFound) { lastFound = media.length; log("scan: media in DOM =", media.length); }
    media.forEach(el => {
      const r = recOf(el);
      if (r.chain) { if (r.chain.parked) revive(r.chain); return; }
      if (r.owned) return;
      if (!active()) return;
      consider(el);
    });
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 300);
  }
  const observer = new MutationObserver(scheduleScan);
  (function attach() {
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  })();

  // ---- popup stats -------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg && msg.type === "getStats") {
      const isTop = window.top === window;
      if (liveChains.size === 0 && !isTop) return false;

      let loudnessDb = null, gainDb = null, count = 0, compromised = 0, degraded = 0;
      for (const ch of liveChains) {
        count++;
        if (ch.compromised) compromised++;
        if (ch.degraded) degraded++;
        if (typeof ch.lastLoudness === "number") loudnessDb = ch.lastLoudness;
        gainDb = ch.lastGainDb;
      }
      send({
        host: TOP_HOST, siteDisabled: siteDisabled(), enabled: settings.enabled,
        tapped: count, compromised, degraded, skips: { ...skips }, loudnessDb, gainDb
      });
    }
    return true;
  });
})();
