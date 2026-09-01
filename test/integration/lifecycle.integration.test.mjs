// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Run: node --test test/integration/
//
// Drives the REAL content.js through the browser lifecycle events the unit
// tests can't reach, asserting against the resulting (mock) audio graph.

import test from "node:test";
import assert from "node:assert/strict";
import { createEnv } from "./harness.mjs";

const SAME = "https://site.example/clip.mp4";
const BLOB = "blob:https://site.example/uuid";
const CROSS = "https://cdn.other/clip.mp4";

test("same-origin media is tapped and processed", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  assert.ok(env.wasTapped(el), "should have tapped");
  assert.ok(env.sourceGoesToGain(el), "should route through processing");
  assert.equal(env.getStats().tapped, 1);
});

test("MSE blob (same-origin) is tapped", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: BLOB });
  await env.sleep(env.DEBOUNCE);
  assert.ok(env.wasTapped(el));
});

test("cross-origin without CORS is skipped, native path untouched", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: CROSS });
  await env.sleep(env.DEBOUNCE);
  assert.ok(!env.wasTapped(el), "must NOT tap cross-origin");
  assert.ok(env.getStats().skips.cors >= 1);
});

test("cross-origin WITH crossorigin=anonymous is tapped", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: CROSS, crossOrigin: "anonymous" });
  await env.sleep(env.DEBOUNCE);
  assert.ok(env.wasTapped(el));
});

test("DRM (mediaKeys) is skipped", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME, mediaKeys: {} });
  await env.sleep(env.DEBOUNCE);
  assert.ok(!env.wasTapped(el));
  assert.ok(env.getStats().skips.drm >= 1);
});

test("an 'encrypted' event before commitment prevents the tap", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME, readyState: 0 }); // not classifiable yet
  await env.sleep(env.DEBOUNCE);                          // listeners attach, verdict = wait
  env.fire(el, "encrypted");                              // DRM observed for THIS generation
  el.__set(SAME, 4);                                      // same source, now metadata-ready
  env.fire(el, "canplay");                                // (no loadstart → same generation)
  await env.sleep(20);
  assert.ok(!env.wasTapped(el), "encrypted source must not be tapped");
  assert.ok(env.getStats().skips.drm >= 1);
});

test("source replacement: eligible → cross-origin (compromised) → eligible (recovered)", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  assert.ok(env.sourceGoesToGain(el));

  env.setSource(el, CROSS);                 // unsafe source on the SAME element
  await env.sleep(20);
  assert.ok(env.getStats().compromised >= 1, "cross-origin replacement must be flagged");
  assert.ok(env.sourceGoesToDestination(el), "compromised → transparent passthrough");

  env.setSource(el, SAME);                  // back to a safe source
  await env.sleep(20);
  assert.equal(env.getStats().compromised, 0, "must recover when source is safe again");
  assert.ok(env.sourceGoesToGain(el));
});

test("detach parks the chain; reattach revives it", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  assert.equal(env.getStats().tapped, 1);
  const src = env.sourceOf(el);

  env.detach(el);
  await env.sleep(env.DEBOUNCE);
  assert.equal(env.getStats().tapped, 0, "detached chain should be parked (not live)");
  assert.equal(src.outs.size, 0, "parked source disconnected");

  env.attach(el);
  await env.sleep(env.DEBOUNCE);
  assert.equal(env.getStats().tapped, 1, "reattached chain should be revived");
  assert.ok(env.sourceGoesToGain(el));
});

test("master OFF before discovery does not tap; enabling then taps", async () => {
  const env = createEnv({ initialSettings: { enabled: false } });
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  assert.ok(!env.wasTapped(el), "OFF must not tap untapped media");

  env.settingsSet({ enabled: true });
  await env.sleep(env.DEBOUNCE);
  assert.ok(env.wasTapped(el), "enabling should tap");
});

test("worklet load failure degrades to tracked passthrough (still owned)", async () => {
  const env = createEnv();
  env.setAddModule("reject");
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  assert.ok(env.wasTapped(el), "element is owned even when the worklet fails");
  assert.ok(env.sourceGoesToDestination(el), "degraded chain is a passthrough");
  assert.ok(env.getStats().degraded >= 1);
});

test("BFCache: pagehide[persisted] does NOT close; pageshow re-warms; real unload closes", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  const ctx = env.ctx();

  env.fireWindow("pagehide", { persisted: true });
  assert.equal(ctx.closeCount, 0, "BFCache entry must not close the context");

  env.fireWindow("pageshow", { persisted: true });
  const g = env.agcGainOf(el);
  assert.equal(g.lastOp(), "setValueAtTime", "restore must hard-set the gain (no glide)");
  assert.ok(g.value <= 1 + 1e-9, "restored gain must be <= unity");
  assert.equal(ctx.closeCount, 0);

  env.fireWindow("pagehide", { persisted: false });
  assert.equal(ctx.closeCount, 1, "real unload closes the context");
});

test("source change hard-resets gain immediately (no glide, <= unity)", async () => {
  const env = createEnv(); // default compression medium (makeup +3)
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);

  for (let i = 0; i < 14; i++) env.meterTick(el, -40, -40); // quiet → drive lift toward +12
  const g = env.agcGainOf(el);
  assert.ok(g.value > 1, "should have boosted on quiet material");

  env.fire(el, "loadstart"); // new source generation → hard safety reset
  assert.equal(g.lastOp(), "setValueAtTime", "boundary must hard-set, not ease");
  assert.ok(g.value <= 1 + 1e-9, "physical AGC node must be <= unity at the boundary");
});

test("lowering Max boost while boosted is immediately authoritative (no meter needed)", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);

  for (let i = 0; i < 14; i++) env.meterTick(el, -40, -40);
  const g = env.agcGainOf(el);
  assert.ok(g.value > 1);

  env.settingsSet({ maxBoostDb: 0 }); // settings authority boundary, during "silence"
  assert.equal(g.lastOp(), "setValueAtTime");
  assert.ok(g.value <= 1 + 1e-9, "net authority must drop to <= 0 immediately");
});

test("clearing storage mid-session does not throw and keeps stats working", async () => {
  const env = createEnv();
  const el = env.addMedia({ src: SAME });
  await env.sleep(env.DEBOUNCE);
  assert.doesNotThrow(() => env.settingsClear());
  assert.ok(env.getStats(), "stats still respond after a storage clear");
});
