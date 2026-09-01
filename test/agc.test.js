// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Run: node --test
//
// Each test pins a behaviour that a naive revert of the controller logic
// would break (single-window ducking, missing gate, missing clamps, no
// source-change reset).

const test = require("node:test");
const assert = require("node:assert/strict");
const AGC = require("../agc.js");

const S = (over = {}) => ({ targetDb: -24, maxBoostDb: 12, maxCutDb: 12, ...over });

test("quiet source is lifted toward target on the short-term window", () => {
  const d = AGC.decide(0, S(), { momentaryDb: -34, shortTermDb: -34 });
  assert.equal(d.action, "lift");
  assert.ok(d.gainDb > 0, "expected positive gain");
  assert.equal(d.tc, AGC.LIFT_TC, "lift must use the slow time constant");
  assert.ok(Math.abs(d.gainDb - 10) < 1e-9); // -24 - (-34) = +10
});

test("loud momentary jump ducks fast even while short-term still reads quiet", () => {
  // Boosted from a previous quiet clip; a loud next scene hits.
  const prev = 10;
  const d = AGC.decide(prev, S(), { momentaryDb: -14, shortTermDb: -30 });
  assert.equal(d.action, "duck", "should react to momentary, not wait for short-term");
  assert.equal(d.tc, AGC.DUCK_TC, "duck must use the fast time constant");
  assert.ok(d.gainDb < prev, "gain must come down");
  assert.ok(Math.abs(d.gainDb - -10) < 1e-9); // -24 - (-14) = -10, clamped range ok
});

test("boost is clamped to maxBoostDb", () => {
  const d = AGC.decide(0, S({ maxBoostDb: 6 }), { momentaryDb: -60 + 5, shortTermDb: -50 });
  assert.ok(d.gainDb <= 6 + 1e-9, `gain ${d.gainDb} exceeded max boost`);
});

test("cut is clamped to maxCutDb", () => {
  const d = AGC.decide(0, S({ maxCutDb: 6 }), { momentaryDb: -6, shortTermDb: -6 });
  assert.ok(d.gainDb >= -6 - 1e-9, `gain ${d.gainDb} exceeded max cut`);
});

test("silence gate holds gain (no boosting hiss between lines)", () => {
  const prev = 8;
  const d = AGC.decide(prev, S(), { momentaryDb: -80, shortTermDb: -80 });
  assert.equal(d.action, "hold");
  assert.equal(d.gainDb, prev);
});

test("momentary above gate but quiet does not force a duck below current gain", () => {
  // Quiet momentary shouldn't duck; short-term drives a gentle lift instead.
  const d = AGC.decide(5, S(), { momentaryDb: -40, shortTermDb: -34 });
  assert.notEqual(d.action, "duck");
});

test("controller reset neutralises carried boost for the next source", () => {
  const c = AGC.createController(() => S());
  // Earn a big boost on a quiet clip.
  for (let i = 0; i < 5; i++) c.step({ momentaryDb: -40, shortTermDb: -36 });
  assert.ok(c.gainDb > 5, "should have boosted on the quiet clip");

  c.reset(0); // simulate loadstart on a new video
  const d = c.step({ momentaryDb: -14, shortTermDb: -30 }); // loud next video
  assert.ok(d.gainDb <= 0, "must not blast the loud next video with old boost");
  assert.notEqual(d.action, "lift");
});

test("createController exposes commanded gain and applies decisions", () => {
  const c = AGC.createController(() => S());
  const d = c.step({ momentaryDb: -34, shortTermDb: -34 });
  assert.equal(c.gainDb, d.gainDb);
});

test("reset keeps a protective cut but never carries a boost", () => {
  const c = AGC.createController(() => S());
  // Simulate a previous loud source that earned a -10 dB cut.
  c.reset(-10, 0);
  assert.equal(c.gainDb, -10);
  // A boost must never survive a reset (content.js passes min(prev,0)).
  c.reset(Math.min(8, 0), 0);
  assert.equal(c.gainDb, 0);
});

test("during warmup, lift is blocked even on a quiet short-term reading", () => {
  const c = AGC.createController(() => S());
  c.reset(0, 5); // 5 warmup steps
  const d = c.step({ momentaryDb: -34, shortTermDb: -34 }); // quiet → would normally lift
  assert.notEqual(d.action, "lift");
  assert.ok(c.gainDb <= 0, "no boost applied during warmup");
});

test("during warmup, a loud momentary can still duck (protection stays live)", () => {
  const c = AGC.createController(() => S());
  c.reset(0, 5);
  const d = c.step({ momentaryDb: -10, shortTermDb: -30 }); // loud → must duck
  assert.equal(d.action, "duck");
  assert.ok(c.gainDb < 0);
});

test("lift resumes once warmup steps are exhausted", () => {
  const c = AGC.createController(() => S());
  c.reset(0, 2);
  c.step({ momentaryDb: -34, shortTermDb: -34 }); // warmup 2 -> 1, no lift
  c.step({ momentaryDb: -34, shortTermDb: -34 }); // warmup 1 -> 0, no lift
  const d = c.step({ momentaryDb: -34, shortTermDb: -34 }); // warmup done -> lift
  assert.equal(d.action, "lift");
  assert.ok(c.gainDb > 0);
});

test("safetyReset revokes positive boost across a boundary (LH-INV-02/03)", () => {
  const c = AGC.createController(() => S());
  c.reset(12, 0);
  const keep = c.safetyReset(8);
  assert.equal(keep, 0);        // this is the value written to the physical GainNode
  assert.equal(c.gainDb, 0);
});

test("safetyReset preserves a protective cut across a boundary (LH-INV-04)", () => {
  const c = AGC.createController(() => S());
  c.reset(-8, 0);
  const keep = c.safetyReset(8);
  assert.equal(keep, -8);
  assert.equal(c.gainDb, -8);
});

test("safetyReset arms a warmup that blocks lift", () => {
  const c = AGC.createController(() => S());
  c.reset(12, 0);
  c.safetyReset(3);
  const d = c.step({ momentaryDb: -34, shortTermDb: -34 }); // quiet → would normally lift
  assert.notEqual(d.action, "lift");
  assert.ok(c.gainDb <= 0);
});

test("whole-graph authority: net gain equals commanded regardless of makeup (LH-INV-08)", () => {
  for (const mk of [0, 2, 3, 5]) {
    for (const commanded of [-8, -3, 0, 5, 12]) {
      const phys = AGC.renderPhysicalDb(commanded, mk);
      // physical AGC node + downstream makeup == total commanded gain
      assert.ok(Math.abs((phys + mk) - commanded) < 1e-9, `net ${phys + mk} != ${commanded} at makeup ${mk}`);
    }
  }
});

test("whole-graph authority: at a boundary the physical AGC node is <= unity (LH-INV-08)", () => {
  // safetyReset commands <= 0; physical = commanded - makeup <= 0 for any makeup.
  for (const mk of [0, 3, 5]) {
    for (const keep of [0, -8]) {
      assert.ok(AGC.renderPhysicalDb(keep, mk) <= 0, `physical ${AGC.renderPhysicalDb(keep, mk)} > 0`);
    }
  }
});

test("whole-graph authority: Max boost caps the whole graph, makeup can't exceed it", () => {
  const c = AGC.createController(() => ({ targetDb: -24, maxBoostDb: 0, maxCutDb: 12 }));
  const d = c.step({ momentaryDb: -60, shortTermDb: -60 }); // very quiet → wants max lift
  // commanded is clamped to maxBoost=0; net (= commanded) never exceeds 0 whatever the makeup.
  assert.ok(d.gainDb <= 0);
  assert.ok(AGC.renderPhysicalDb(d.gainDb, 5) + 5 <= 0 + 1e-9);
});

// --- Settings authority boundary: live config transitions (LH-INV-08) ---
// Model the reconcile content.js performs on a settings change: cap existing
// positive authority to the new Max boost, then render the physical AGC node
// for the new makeup. Net = physical + makeup must never exceed Max boost.
function reconciledNet(ctrl, maxBoostDb, makeupDb) {
  const commanded = ctrl.capPositiveAuthority(maxBoostDb);
  return { commanded, net: AGC.renderPhysicalDb(commanded, makeupDb) + makeupDb };
}

test("Medium → Strong with zero boost never lets net exceed 0", () => {
  const c = AGC.createController(() => S({ maxBoostDb: 0 }));
  c.reset(0, 0);                                  // commanded 0 under Medium (makeup 3)
  const r = reconciledNet(c, 0, 5);               // switch to Strong (makeup 5)
  assert.ok(r.net <= 1e-9, `net ${r.net} > 0`);
  assert.equal(r.commanded, 0);
});

test("Off → Strong at max boost never lets net exceed +12", () => {
  const c = AGC.createController(() => S({ maxBoostDb: 12 }));
  c.reset(12, 0);                                 // commanded +12 under Off (makeup 0)
  const r = reconciledNet(c, 12, 5);              // switch to Strong (makeup 5)
  assert.ok(r.net <= 12 + 1e-9, `net ${r.net} > 12`);
});

test("lowering Max boost while boosted is immediately authoritative", () => {
  const c = AGC.createController(() => S({ maxBoostDb: 0 }));
  c.reset(12, 0);                                 // legitimately earned +12
  const r = reconciledNet(c, 0, 3);               // Max boost 12 → 0
  assert.equal(c.gainDb, 0, "controller command not capped immediately");
  assert.ok(r.net <= 1e-9);
});

test("lowering Max boost during silence still caps immediately (no meter needed)", () => {
  const c = AGC.createController(() => S({ maxBoostDb: 0 }));
  c.reset(12, 0);
  const capped = c.capPositiveAuthority(0);       // no step()/measurement involved
  assert.equal(capped, 0);
  assert.equal(c.gainDb, 0);
});

test("compression change during warmup keeps net <= 0 and preserves warmup", () => {
  const c = AGC.createController(() => S({ maxBoostDb: 12 }));
  c.reset(0, 8);                                  // warmup armed, command 0
  const r = reconciledNet(c, 12, 5);              // change compression mid-warmup
  assert.ok(r.net <= 1e-9, `net ${r.net} > 0`);
  const d = c.step({ momentaryDb: -34, shortTermDb: -34 }); // quiet → must NOT lift (warmup)
  assert.notEqual(d.action, "lift");
});
