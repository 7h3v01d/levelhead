// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — AGC controller (pure).
//
// No Web Audio, no DOM: given a loudness measurement and the live settings,
// it decides the next commanded gain and the time constant to reach it. This
// keeps the leveling logic unit-testable in Node; content.js applies the
// decision to an AudioParam via setTargetAtTime().
//
// Key behaviour: ducking (turning gain DOWN) reacts to the fast MOMENTARY
// window so a loud next scene/video is caught quickly, while lifting (turning
// gain UP) rides the slow SHORT-TERM window so quiet passages come up
// smoothly without pumping.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LevelheadAGC = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GATE_DB = -55;   // below this a window carries no usable level info
  const DUCK_TC = 0.06;  // fast: protect ears on loud jumps
  const LIFT_TC = 0.40;  // slow: raise quiet material without audible pumping

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dbToLin = db => Math.pow(10, db / 20);

  // Pure decision function. `prevGainDb` is the last commanded gain; returns
  // the next commanded gain, its linear form, the glide time constant, and a
  // label ("duck" | "lift" | "hold") that's handy for tests and the readout.
  // opts.allowLift=false (warmup after a source change) permits ducking but
  // blocks lift until fresh measurements have accumulated.
  function decide(prevGainDb, settings, meas, opts) {
    const allowLift = !opts || opts.allowLift !== false;
    const targetDb = settings.targetDb;
    const maxBoostDb = settings.maxBoostDb;
    const maxCutDb = settings.maxCutDb;

    const mom = meas.momentaryDb;
    const sh = meas.shortTermDb;
    const momValid = Number.isFinite(mom) && mom >= GATE_DB;
    const shValid = Number.isFinite(sh) && sh >= GATE_DB;

    if (!momValid && !shValid) {
      return { gainDb: prevGainDb, gainLin: dbToLin(prevGainDb), tc: LIFT_TC, action: "hold" };
    }

    let gainDb = prevGainDb;
    let tc = LIFT_TC;
    let action = "hold";

    // Duck first, on the fast window. Always allowed, even during warmup.
    if (momValid) {
      const duckTarget = clamp(targetDb - mom, -maxCutDb, maxBoostDb);
      if (duckTarget < prevGainDb) {
        gainDb = duckTarget;
        tc = DUCK_TC;
        action = "duck";
      }
    }
    // Only lift if we're not already ducking, lift is permitted, on the slow window.
    if (action === "hold" && allowLift && shValid) {
      const liftTarget = clamp(targetDb - sh, -maxCutDb, maxBoostDb);
      if (liftTarget > prevGainDb) {
        gainDb = liftTarget;
        tc = LIFT_TC;
        action = "lift";
      }
    }

    return { gainDb, gainLin: dbToLin(gainDb), tc, action };
  }

  // Thin stateful wrapper for content.js. `getSettings` is called per step so
  // slider changes take effect immediately without rewiring.
  function createController(getSettings) {
    let gainDb = 0;
    let warmup = 0; // steps remaining during which lift is blocked
    return {
      get gainDb() { return gainDb; },
      get warmup() { return warmup; },
      // Called on source change. Keeps any protective CUT (never carries a
      // positive boost into an unknown source) and blocks lift for
      // `warmupSteps` measurements while the meter re-establishes the level.
      reset(toDb = 0, warmupSteps = 0) {
        gainDb = toDb;
        warmup = Math.max(0, warmupSteps | 0);
      },
      // Authority boundary (source change, revive, re-enable, BFCache restore):
      // revoke any positive boost immediately, keep a protective cut, and arm a
      // warmup. Returns the kept gain (<= 0) so the caller can hard-set the
      // physical GainNode to exactly this value. See INVARIANTS.md.
      safetyReset(warmupSteps = 0) {
        gainDb = Math.min(gainDb, 0);
        warmup = Math.max(0, warmupSteps | 0);
        return gainDb;
      },
      // Settings boundary: an existing positive command may not exceed a newly
      // lowered Max boost. Lowers excess authority immediately (never raises,
      // never touches a protective cut or the warmup). Returns the new command.
      capPositiveAuthority(maxBoostDb) {
        if (gainDb > maxBoostDb) gainDb = maxBoostDb;
        return gainDb;
      },
      step(meas) {
        const d = decide(gainDb, getSettings(), meas, { allowLift: warmup <= 0 });
        gainDb = d.gainDb;
        if (warmup > 0) warmup--;
        return d;
      }
    };
  }

  // Render the total commanded gain into the physical AGC GainNode, accounting
  // for a fixed downstream makeup stage, so the graph's NET gain equals the
  // commanded gain (never commanded + makeup). See INVARIANTS.md (LH-INV-08).
  function renderPhysicalDb(commandedDb, makeupDb) {
    return commandedDb - (makeupDb || 0);
  }

  return { decide, createController, dbToLin, renderPhysicalDb, GATE_DB, DUCK_TC, LIFT_TC };
});
