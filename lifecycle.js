// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — element lifecycle record (pure).
//
// A tapped media element is owned for life, but its SOURCE changes over time.
// DRM evidence and skip decisions must belong to the current source generation,
// not the element's whole lifetime — otherwise a single 'encrypted' event or a
// single cross-origin source would sideline the element forever, even after it
// returns to a safe source.
//
// Each source change bumps the generation, which automatically expires the
// previous generation's DRM observation and skip decision.

(function () {
  "use strict";

  function newRecord() {
    return {
      gen: 0,          // current source generation
      encGen: -1,      // generation at which an 'encrypted' event was observed
      decidedGen: -1,  // generation at which we last skipped this element
      owned: false,    // createMediaElementSource has succeeded
      chain: null,     // audio chain (active, parked, or degraded), or null
      listenersAttached: false,
      listeners: null
    };
  }

  function bumpGeneration(r) { r.gen++; }        // new source → prior enc/skip go stale
  function markEncrypted(r) { r.encGen = r.gen; }
  function encryptedActive(r) { return r.encGen === r.gen; }
  function markSkipped(r) { r.decidedGen = r.gen; }
  function shouldReconsider(r) { return r.decidedGen !== r.gen; }

  const api = {
    newRecord, bumpGeneration, markEncrypted, encryptedActive, markSkipped, shouldReconsider
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.LevelheadLifecycle = api;
})();
