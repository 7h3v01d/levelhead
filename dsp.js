// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — loudness DSP (pure).
//
// Per-channel K-weighting + weight-normalised mean-square metering, extracted
// so it can be unit-tested in Node and loaded into the AudioWorklet scope.
//
// Channel handling follows ITU-R BS.1770 in the way that matters: each channel
// is weighted and squared INDEPENDENTLY, then combined. We take the MEAN of
// per-channel energies (not the BS.1770 weighted SUM) on purpose, so dual-mono
// stereo reads the same level as mono and the AGC doesn't lurch on mono/stereo
// switches. The critical property — anti-phase L/R must NOT read as silence —
// holds regardless.
//
// The EMAs are weight-normalised (energy/weight), so immediately after a reset
// the estimate reflects only the samples actually observed instead of treating
// the missing history as silence. This removes the cold-start bias that would
// otherwise make a source read too quiet for seconds and provoke a false lift.

(function () {
  "use strict";

  function normBiquad(b0, b1, b2, a0, a1, a2) {
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function highpass(f0, Q, sr) {
    const w0 = (2 * Math.PI * f0) / sr;
    const c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * Q);
    return normBiquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }
  function highshelf(f0, Q, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / sr;
    const c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * Q);
    const tsa = 2 * Math.sqrt(A) * alpha;
    return normBiquad(
      A * ((A + 1) + (A - 1) * c + tsa),
      -2 * A * ((A - 1) + (A + 1) * c),
      A * ((A + 1) + (A - 1) * c - tsa),
      (A + 1) - (A - 1) * c + tsa,
      2 * ((A - 1) - (A + 1) * c),
      (A + 1) - (A - 1) * c - tsa
    );
  }
  function tick(coef, z, off, x) {
    const y = coef.b0 * x + z[off];
    z[off] = coef.b1 * x - coef.a1 * y + z[off + 1];
    z[off + 1] = coef.b2 * x - coef.a2 * y;
    return y;
  }
  function toDb(ms) {
    return ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  }

  function createMeter(sampleRate, opts) {
    const momSec = (opts && opts.momSec) || 0.4;
    const shortSec = (opts && opts.shortSec) || 3.0;
    return {
      sampleRate,
      hp: highpass(40, 0.707, sampleRate),
      hs: highshelf(1800, 0.707, 4, sampleRate),
      z: [],
      msMom: 0, wMom: 0,
      msShort: 0, wShort: 0,
      aMom: Math.exp(-1 / (momSec * sampleRate)),
      aShort: Math.exp(-1 / (shortSec * sampleRate))
    };
  }

  function reset(state) {
    state.msMom = 0; state.wMom = 0;
    state.msShort = 0; state.wShort = 0;
    for (let i = 0; i < state.z.length; i++) state.z[i] = 0;
  }

  function process(state, channels) {
    const chs = channels.length;
    if (!chs) return;
    const n = channels[0].length;
    while (state.z.length < chs * 4) state.z.push(0);
    const aM = state.aMom, aS = state.aShort;
    for (let i = 0; i < n; i++) {
      let energy = 0;
      for (let c = 0; c < chs; c++) {
        const base = c * 4;
        let s = channels[c][i];
        s = tick(state.hp, state.z, base, s);
        s = tick(state.hs, state.z, base + 2, s);
        energy += s * s;          // square PER CHANNEL
      }
      energy /= chs;              // mean per-channel energy
      state.msMom = aM * state.msMom + (1 - aM) * energy;
      state.wMom = aM * state.wMom + (1 - aM);
      state.msShort = aS * state.msShort + (1 - aS) * energy;
      state.wShort = aS * state.wShort + (1 - aS);
    }
  }

  // Weight-normalised energies (debiased for the samples seen since reset).
  function momentary(state) { return state.wMom > 0 ? state.msMom / state.wMom : 0; }
  function shortTerm(state) { return state.wShort > 0 ? state.msShort / state.wShort : 0; }

  const api = { createMeter, reset, process, momentary, shortTerm, toDb, tick };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.LevelheadDSP = api;
})();
