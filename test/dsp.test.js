// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Run: node --test
//
// Stereo/channel regression vectors. The headline case is opposite-polarity
// stereo, which the old (L+R)/2 meter read as silence.

const test = require("node:test");
const assert = require("node:assert/strict");
const DSP = require("../dsp.js");

const SR = 48000;

// Build one channel of a 1 kHz sine (passes the 40 Hz high-pass, sits near
// unity on the high-shelf) so weighted energy is non-trivial.
function sine(nSamples, amp = 0.5, freq = 1000, phase = 0) {
  const a = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) a[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / SR);
  return a;
}

// Feed a fixed block and return settled-ish momentary energy.
function measure(channels) {
  const m = DSP.createMeter(SR, { momSec: 0.05, shortSec: 0.2 });
  // ~0.5 s is plenty for the short windows above to settle.
  for (let k = 0; k < 10; k++) DSP.process(m, channels);
  return DSP.momentary(m);
}

const N = 2400; // 50 ms per block

test("mono produces non-trivial loudness", () => {
  const e = measure([sine(N)]);
  assert.ok(DSP.toDb(e) > -30, `mono too quiet: ${DSP.toDb(e).toFixed(1)} dB`);
});

test("opposite-polarity stereo does NOT read as silence (the old bug)", () => {
  const L = sine(N, 0.5, 1000, 0);
  const R = sine(N, 0.5, 1000, Math.PI); // inverted
  const e = measure([L, R]);
  assert.ok(DSP.toDb(e) > -30, `anti-phase read as near-silence: ${DSP.toDb(e).toFixed(1)} dB`);
});

test("anti-phase stereo reads about the same as mono", () => {
  const mono = measure([sine(N)]);
  const anti = measure([sine(N, 0.5, 1000, 0), sine(N, 0.5, 1000, Math.PI)]);
  const diffDb = Math.abs(DSP.toDb(mono) - DSP.toDb(anti));
  assert.ok(diffDb < 0.5, `mono vs anti-phase differ by ${diffDb.toFixed(2)} dB`);
});

test("identical (dual-mono) stereo matches mono level", () => {
  const mono = measure([sine(N)]);
  const dual = measure([sine(N), sine(N)]);
  const diffDb = Math.abs(DSP.toDb(mono) - DSP.toDb(dual));
  assert.ok(diffDb < 0.5, `mono vs dual-mono differ by ${diffDb.toFixed(2)} dB`);
});

test("left-only sits ~3 dB below dual-mono (mean-of-channels handling)", () => {
  const dual = DSP.toDb(measure([sine(N), sine(N)]));
  const left = DSP.toDb(measure([sine(N), new Float32Array(N)]));
  const drop = dual - left;
  assert.ok(drop > 2 && drop < 4, `expected ~3 dB drop, got ${drop.toFixed(2)} dB`);
});

test("right-only matches left-only by symmetry", () => {
  const left = DSP.toDb(measure([sine(N), new Float32Array(N)]));
  const right = DSP.toDb(measure([new Float32Array(N), sine(N)]));
  assert.ok(Math.abs(left - right) < 0.2, `L/R asymmetry ${Math.abs(left - right).toFixed(2)} dB`);
});

test("silence reads at the floor", () => {
  const e = measure([new Float32Array(N), new Float32Array(N)]);
  assert.ok(DSP.toDb(e) < -80, `silence not at floor: ${DSP.toDb(e).toFixed(1)} dB`);
});

test("reset returns the meter to the floor", () => {
  const m = DSP.createMeter(SR, { momSec: 0.05, shortSec: 0.2 });
  for (let k = 0; k < 10; k++) DSP.process(m, [sine(N)]);
  assert.ok(m.msShort > 0);
  DSP.reset(m);
  assert.equal(m.msShort, 0);
  assert.equal(m.msMom, 0);
  assert.equal(m.wShort, 0);
  assert.equal(m.wMom, 0);
  assert.ok(m.z.every(v => v === 0), "filter state not cleared");
});

test("cold start after reset does not fabricate a large lift (normalised EMA)", () => {
  const AGC = require("../agc.js");
  const m = DSP.createMeter(SR, {}); // real 0.4 s / 3 s windows
  const block = () => DSP.process(m, [sine(SR / 10)]); // 100 ms per metering tick

  for (let i = 0; i < 80; i++) block();               // settle ~8 s
  const settledDb = DSP.toDb(DSP.shortTerm(m));

  DSP.reset(m);                                        // simulate a source change
  const c = AGC.createController(() => ({ targetDb: settledDb, maxBoostDb: 12, maxCutDb: 12 }));
  c.reset(0, 8);                                       // WARMUP_STEPS

  let maxGain = -Infinity;
  for (let i = 0; i < 20; i++) {
    block();
    const d = c.step({
      momentaryDb: DSP.toDb(DSP.momentary(m)),
      shortTermDb: DSP.toDb(DSP.shortTerm(m))
    });
    maxGain = Math.max(maxGain, d.gainDb);
  }
  // With a zero-filled EMA this used to command roughly +5–6 dB.
  assert.ok(maxGain < 2, `cold-start produced a spurious lift of +${maxGain.toFixed(1)} dB`);
});
