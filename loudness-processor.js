// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — loudness meter worklet.
//
// Thin wrapper around dsp.js (loaded into this global scope by a prior
// addModule call). Posts weight-normalised momentary (~400 ms) and short-term
// (~3 s) loudness. A { type: "reset" } port message clears meter state on
// source changes so stale level can't leak into a new source.

class LoudnessProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const DSP = globalThis.LevelheadDSP;
    const hz = (options.processorOptions && options.processorOptions.updateHz) || 10;
    this._postEvery = Math.max(1, Math.round(sampleRate / 128 / hz));
    this._q = 0;
    this._state = DSP.createMeter(sampleRate, {});
    this.port.onmessage = e => {
      if (e.data && e.data.type === "reset") DSP.reset(this._state);
    };
  }

  process(inputs) {
    const DSP = globalThis.LevelheadDSP;
    const input = inputs[0];
    if (input && input.length) DSP.process(this._state, input);
    if (++this._q >= this._postEvery) {
      this._q = 0;
      this.port.postMessage({
        momentaryDb: DSP.toDb(DSP.momentary(this._state)),
        shortTermDb: DSP.toDb(DSP.shortTerm(this._state))
      });
    }
    return true;
  }
}

registerProcessor("loudness-processor", LoudnessProcessor);
