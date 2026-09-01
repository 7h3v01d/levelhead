// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// jsdom integration harness.
//
// Loads the REAL agc.js / eligibility.js / lifecycle.js / content.js into a
// jsdom window with a controllable mock of Web Audio and chrome.*, so the
// actual content-script lifecycle (discovery, eligibility, tap, source
// generations, park/revive, reclassify, gain-authority boundaries) runs and
// can be asserted against the resulting audio graph.
//
// This is NOT a real browser: DOM/events/MutationObserver are real (jsdom),
// but Web Audio is mocked. It verifies Levelhead's OWN decisions and graph
// construction — not Chromium's audio behaviour (e.g. that a real cross-origin
// source outputs silence). Browser-level behaviour is covered by the Puppeteer
// tier in test/integration/browser/.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => readFileSync(join(ROOT, f), "utf8");

// Read the real source once; each env re-evaluates it for fresh module state.
const SRC = {
  agc: read("agc.js"),
  eligibility: read("eligibility.js"),
  lifecycle: read("lifecycle.js"),
  content: read("content.js")
};

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const dbToLin = db => Math.pow(10, db / 20);

export function createEnv({ url = "https://site.example/page", initialSettings = {} } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url, runScripts: "outside-only", pretendToBeVisual: true
  });
  const win = dom.window;

  // ---- mock Web Audio ----------------------------------------------------
  const instances = [];
  let addModuleMode = "resolve"; // or "reject"

  class FakeParam {
    constructor(v = 1) { this.value = v; this.calls = []; }
    setValueAtTime(v, t) { this.value = v; this.calls.push(["setValueAtTime", v, t]); return this; }
    setTargetAtTime(v, t, tc) { this.value = v; this.calls.push(["setTargetAtTime", v, t, tc]); return this; }
    cancelAndHoldAtTime(t) { this.calls.push(["cancelAndHoldAtTime", t]); return this; }
    cancelScheduledValues(t) { this.calls.push(["cancelScheduledValues", t]); return this; }
    lastOp() { return this.calls.length ? this.calls[this.calls.length - 1][0] : null; }
  }
  class FakeNode {
    constructor(type) { this.type = type; this.outs = new Set(); }
    connect(dest) { this.outs.add(dest); return dest; }
    disconnect(dest) { if (dest === undefined) this.outs.clear(); else this.outs.delete(dest); }
  }
  class FakeGain extends FakeNode { constructor() { super("gain"); this.gain = new FakeParam(1); } }
  class FakeComp extends FakeNode {
    constructor() {
      super("comp");
      for (const k of ["threshold", "knee", "ratio", "attack", "release"]) this[k] = new FakeParam(0);
    }
  }
  class FakeWorklet extends FakeNode {
    constructor() { super("worklet"); this.port = { onmessage: null, postMessage() {} }; }
  }
  class FakeSource extends FakeNode { constructor(el) { super("source"); this.el = el; } }

  class FakeAudioContext {
    constructor() {
      this.state = "running"; this.currentTime = 0; this.sampleRate = 48000;
      this.destination = new FakeNode("destination");
      this._sources = new Map(); this.closed = false; this.closeCount = 0;
      this.audioWorklet = { addModule: () => addModuleMode === "reject"
        ? Promise.reject(new Error("addModule blocked")) : Promise.resolve() };
      instances.push(this);
    }
    createGain() { return new FakeGain(); }
    createDynamicsCompressor() { return new FakeComp(); }
    createMediaElementSource(el) {
      if (this._sources.has(el)) throw new Error("HTMLMediaElement already connected");
      const s = new FakeSource(el); this._sources.set(el, s); return s;
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.closed = true; this.closeCount++; return Promise.resolve(); }
  }
  function FakeAudioWorkletNode() { return new FakeWorklet(); }

  win.AudioContext = FakeAudioContext;
  win.webkitAudioContext = FakeAudioContext;
  win.AudioWorkletNode = FakeAudioWorkletNode;

  // ---- mock chrome.* -----------------------------------------------------
  const store = { ...initialSettings };
  const changeListeners = [];
  const msgListeners = [];
  win.chrome = {
    storage: {
      local: {
        get(defaults, cb) {
          const out = { ...defaults };
          for (const k of Object.keys(store)) out[k] = store[k];
          // Real chrome.storage.get is async; deferring lets content.js finish
          // evaluating (all bindings initialised) before its initial scan runs.
          Promise.resolve().then(() => cb(out));
        },
        set(obj) {
          const changes = {};
          for (const k of Object.keys(obj)) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; }
          changeListeners.forEach(l => { try { l(changes, "local"); } catch (e) { /* surface via test */ throw e; } });
          return Promise.resolve();
        },
        clear() {
          const changes = {};
          for (const k of Object.keys(store)) { changes[k] = { oldValue: store[k], newValue: undefined }; delete store[k]; }
          changeListeners.forEach(l => l(changes, "local"));
          return Promise.resolve();
        }
      },
      onChanged: { addListener(l) { changeListeners.push(l); } }
    },
    runtime: {
      getURL(p) { return "chrome-extension://fake/" + p; },
      onMessage: { addListener(l) { msgListeners.push(l); } }
    }
  };

  // ---- load the real code into the window --------------------------------
  win.eval(SRC.agc);
  win.eval(SRC.eligibility);
  win.eval(SRC.lifecycle);
  win.eval(SRC.content);

  // ---- helpers -----------------------------------------------------------
  const Event = win.Event;

  function addMedia({ tag = "video", src = "", readyState = 4, crossOrigin = null, mediaKeys = null } = {}) {
    const el = win.document.createElement(tag);
    let _src = src, _rs = readyState;
    Object.defineProperty(el, "currentSrc", { configurable: true, get: () => _src });
    Object.defineProperty(el, "readyState", { configurable: true, get: () => _rs });
    if (crossOrigin != null) el.crossOrigin = crossOrigin;
    if (mediaKeys != null) el.mediaKeys = mediaKeys;
    el.__set = (ns, nr) => { if (ns != null) _src = ns; if (nr != null) _rs = nr; };
    win.document.body.appendChild(el);
    return el;
  }

  const fire = (el, type) => el.dispatchEvent(new Event(type));

  function setSource(el, src, { readyState = 4 } = {}) {
    el.__set(src, readyState);
    fire(el, "loadstart");
    fire(el, "loadedmetadata");
    fire(el, "canplay");
  }

  const detach = el => el.remove();
  const attach = el => win.document.body.appendChild(el);

  function fireWindow(type, props = {}) {
    const ev = new Event(type);
    Object.assign(ev, props);
    win.dispatchEvent(ev);
  }

  const ctx = () => instances[0] || null;
  const sourceOf = el => { const c = ctx(); return c ? c._sources.get(el) || null : null; };
  const wasTapped = el => !!sourceOf(el);
  function agcGainOf(el) {
    const s = sourceOf(el); if (!s) return null;
    const g = [...s.outs].find(n => n && n.type === "gain");
    return g ? g.gain : null;
  }
  function meterOf(el) {
    const s = sourceOf(el); if (!s) return null;
    return [...s.outs].find(n => n && n.type === "worklet") || null;
  }
  function meterTick(el, momentaryDb, shortTermDb) {
    const m = meterOf(el);
    if (m && m.port.onmessage) m.port.onmessage({ data: { momentaryDb, shortTermDb } });
  }
  const sourceGoesToDestination = el => { const s = sourceOf(el); const c = ctx(); return !!(s && c && s.outs.has(c.destination)); };
  const sourceGoesToGain = el => { const s = sourceOf(el); return !!(s && [...s.outs].some(n => n && n.type === "gain")); };

  function getStats() {
    let res = null;
    for (const l of msgListeners) l({ type: "getStats" }, {}, x => { res = x; });
    return res;
  }

  const settingsSet = obj => win.chrome.storage.local.set(obj);
  const settingsClear = () => win.chrome.storage.local.clear();
  const setAddModule = mode => { addModuleMode = mode; };

  return {
    window: win, document: win.document,
    addMedia, setSource, fire, fireWindow, detach, attach,
    ctx, sourceOf, wasTapped, agcGainOf, meterOf, meterTick,
    sourceGoesToDestination, sourceGoesToGain,
    getStats, settingsSet, settingsClear, setAddModule,
    sleep, dbToLin,
    DEBOUNCE: 340 // MutationObserver scan debounce (300ms) + async tap slack
  };
}
