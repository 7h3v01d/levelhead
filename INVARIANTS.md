<!-- SPDX-License-Identifier: Apache-2.0 -->
# Levelhead — Safety Invariants

These are the laws the implementation must not violate. Each names where it is
enforced. They exist because tapping a media element via Web Audio is
irreversible, so getting authority wrong can degrade playback the user can't
easily undo.

**LH-INV-01 — An untapped source classified unsafe must never be tapped.**
Enforced by the eligibility gate (`eligibility.js`, `tryTap`): only an `ok`
verdict reaches `createMediaElementSource`.

**LH-INV-02 — Positive gain must never cross a source-generation boundary.**
On every source change (`loadstart`/`emptied`) `hardSafetyReset` runs, which
calls `controller.safetyReset` (`gainDb = min(gainDb, 0)`) and writes the
GainNode immediately.

**LH-INV-03 — Positive gain must never cross an ownership-resumption boundary**
(BFCache restore, park→revive, OFF→ON, site-enable). Same `hardSafetyReset` at
each: `pageshow[persisted]`, `revive`, and the inactive→active branch of
`applyChain`.

**LH-INV-04 — Negative (protective) gain MAY cross those boundaries.**
`safetyReset` keeps `min(gainDb, 0)`, so a cut survives while a boost does not.
Proven in `test/agc.test.js`.

**LH-INV-05 — An owned element must always have a recoverable ownership record.**
The ownership record (`chain`) is created immediately after a successful
`createMediaElementSource`, before the worklet await; detach parks (not
destroys) it, keeping it recoverable via the per-element record.

**LH-INV-06 — An unclassified/uncertain source must never receive positive gain.**
Warmup after every `hardSafetyReset` blocks lift until fresh measurements
accumulate; ducking stays available. The physical GainNode is set to `≤ unity`
*before* the processing graph is (re)connected.

**LH-INV-07 — A failed processing chain must degrade to tracked passthrough,**
never disappear from lifecycle authority. Worklet-load and graph-construction
failures both route through `degrade`, leaving an owned, source-tracking,
park/revive-capable passthrough chain.

**LH-INV-08 — Gain authority is whole-graph, not per-node.** The sum of all
fixed positive-gain stages (AGC node + compressor makeup) must never make the
effective commanded gain exceed `maxBoostDb`, and must be `<= 0` at every
uncertainty boundary. Enforced by treating the controller's gain as the TOTAL
commanded gain and rendering the physical AGC node as `commanded - makeupDb`
(`renderPhysicalDb`), so net gain always equals commanded. `Max boost = 0`
therefore means zero amplification, makeup included. Changing compression or
Max boost is a settings authority boundary: `reconcileGainAuthority` caps
existing authority and re-renders the physical node for the new makeup before
the new graph produces audio, so a live change never transiently exceeds the
limit.

## Physical-vs-logical authority

The controller's `gainDb` is advisory; the **GainNode is authoritative**. At
every boundary the node is hard-set with `setValueAtTime` (after
`cancelAndHoldAtTime`), never eased with `setTargetAtTime`. The boundaries are: source change, revive,
OFF→ON / site re-enable, BFCache restore, and settings change (compression /
Max boost). At none of them can the graph briefly amplify beyond what the
controller authorises.
