<!-- SPDX-License-Identifier: Apache-2.0 -->
# Levelhead — Loudness Governor

**v0.1.5 — "Whole-Graph Gain Authority"**

A Chromium/Vivaldi (Manifest V3) extension that levels the loudness of web
audio and video so quiet dialogue and booming music sit at a consistent,
comfortable level — both *within* a video and *across* videos.

Author: Leon Priest · GitHub: 7h3v01d · Licence: Apache-2.0

## Guarantee (read this)

Tapping a media element via Web Audio is irreversible for that element's life,
so Levelhead is conservative by construction:

> Levelhead never taps a source that is **known unsafe at commitment time**
> (DRM, or cross-origin without CORS). It never increases gain without fresh,
> trustworthy evidence.

Because a tapped element stays owned for life, **every source change is
re-classified**. If a tapped element later loads a cross-origin or DRM source,
that source can't be processed: Levelhead marks it compromised and goes
transparent (best effort). Its playback may be affected until the element
returns to a safe source or the page reloads. This is a real limitation of
routing media through Web Audio, not a bug.

## How it works

```
             ┌──────────── shared master bus ─────────────┐
source A ─► AGC ─► comp ─► makeup ─┐                       │
source B ─► AGC ─► comp ─► makeup ─┼─► master input ─► protection limiter ─► output
                                   │                       │
   └─► per-channel K-weighted meter (AudioWorklet) ─► controller
```

- **Eligibility gate** (`eligibility.js`, pure/tested): classifies each source
  as ok / drm / cors / unknown / wait. Applied at first discovery *and* on
  every source change.
- **Per-channel loudness meter** (`dsp.js`): weights and squares each channel
  independently (BS.1770-style channel handling — the mean of per-channel
  energies, not the BS.1770 weighted sum), so anti-phase L/R reads its true
  loudness. EMAs are **weight-normalised**, so a source reads its real level
  immediately after a reset instead of appearing too quiet for seconds.
- **AGC controller** (`agc.js`, pure/tested): ducks on the fast momentary
  window (a fast 60 ms duck time constant), lifts on the slow short-term
  window; clamps boost/cut; gates on silence.
- **Source transitions**: meter reset, protective cut kept (never a boost),
  lift blocked during a short warmup.
- **Ownership lifecycle**: detaching an element **parks** its chain (nodes
  disconnected, source ownership retained); a reattached element is **revived**
  and re-classified rather than stranded.
- **Source generations** (`lifecycle.js`): DRM and skip decisions are scoped to
  the current source generation, so a `safe → DRM → safe` or `skipped → safe`
  element recovers instead of being sidelined for the element's lifetime.
- **Degraded chains**: if the worklet fails to load, the element is still owned
  and tracked (passthrough, source changes watched) rather than falling out of
  the lifecycle.
- **BFCache-safe**: the context is only closed on real unload (`pagehide` with
  `persisted=false`); a Back/Forward restore resumes and re-warms instead of
  leaving tapped media bound to a dead context.
- **Whole-graph gain authority**: the controller's gain is the TOTAL commanded
  gain; the physical AGC node is rendered as `commanded − makeup`, so net gain
  always equals commanded and never `commanded + makeup`. **Max boost means
  exactly what it says** — `Max boost = 0` is zero amplification, makeup
  included — and the popup **GAIN** is the honest total. At every uncertainty
  boundary the physical node is hard-set (no glide) to `≤ unity` before the
  graph reconnects, so boost can't leak across a source change, revive, OFF→ON,
  or BFCache restore. Startup **fails closed**; corrupt/cleared settings are
  sanitised on ingest. See `INVARIANTS.md`.
- **Shared per-frame master protection limiter**: all streams *in a frame* feed
  one limiter, so the summed output of that frame has a single protection stage.
  Because content scripts run per frame, each frame has its own context and
  limiter; there is no single tab-final limiter across frames yet. Also, a
  `DynamicsCompressor` is a fast finite-ratio limiter, not a true-peak brick wall.
- **OFF means off**: with the master toggle off (or the site disabled),
  untapped media is left completely untouched — no tap occurs. Already-tapped
  elements fall back to transparent bypass.

## Load it (unpacked)

1. Vivaldi → `vivaldi://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder (keep `test/` in place).
3. Reload the extension after any code change.

## Tests

```
node --test        # from the project root, no dependencies
```

- `test/agc.test.js` — controller: duck/lift, clamps, gate, keep-cut, warmup,
  and `safetyReset` (positive gain revoked, protective cut preserved).
- `test/dsp.test.js` — meter: mono, dual-mono, anti-phase, L/R-only, silence,
  reset, and the cold-start-no-false-lift safety vector (dsp + agc together).
- `test/eligibility.test.js` — classification incl. lifetime source
  replacement (eligible → cross-origin → DRM → eligible).
- `test/lifecycle.test.js` — source-generation state: DRM/skip scoped to a
  generation, `safe → DRM → safe` and `skipped → safe` recovery.

These cover the logic modules. Cross-module **browser** lifecycle (park/revive
across real detach/reattach, live CORS/DRM source swaps, worklet-init failure)
still needs a Chromium-driven harness — see "Not done yet".

## Known limitations

- **DRM (Netflix, Disney+, Prime)**: DRM present *before* commitment is skipped
  without tapping, so its playback is never touched. DRM introduced *later* into
  an already-owned element is detected and bypassed best-effort, but Web Audio
  ownership means that source's playback can't always be recovered without a
  return to a safe source or a reload.
- **Cross-origin media without CORS is skipped** (tapping would silence it);
  same-origin and MSE (YouTube/Facebook) are fine.
- **Post-tap unsafe source replacement** is surfaced and made transparent, not
  fully recoverable without the source returning to safe, or a reload.
- **Per-site disable is per top-level site**; already-tapped elements need a
  reload for a hard reset.

## Not done yet (tracked)

- **Browser integration harness** (Puppeteer/Chromium) for the lifecycle cases
  above — the highest-value next testing tier.
- **Popup stats across cross-origin child frames** aren't yet deterministic
  when the top frame has no media (service-worker aggregator is the fix).
- **Observe-only mode** and a **post-limiter output meter** are planned.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest |
| `INVARIANTS.md` | The safety laws (LH-INV-01..07) and where each is enforced |
| `content.js` | Discovery, eligibility, graph wiring, ownership lifecycle |
| `eligibility.js` | Pure source classifier (browser + Node) |
| `lifecycle.js` | Pure per-element source-generation record (browser + Node) |
| `agc.js` | Pure AGC controller (browser + Node) |
| `dsp.js` | Pure per-channel, weight-normalised loudness DSP (worklet + Node) |
| `loudness-processor.js` | AudioWorklet wrapper around `dsp.js` |
| `popup.html/.css/.js` | Controls + live readout |
| `test/*.test.js` | Unit + cross-module regression vectors |
