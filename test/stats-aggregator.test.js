// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Run: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregate } = require("../stats-aggregator.js");

const NOW = 10_000;
const frame = (frameId, stats, ageMs = 0) => ({ frameId, ts: NOW - ageMs, stats });

test("empty input yields a zeroed aggregate", () => {
  const a = aggregate([], NOW);
  assert.equal(a.frames, 0);
  assert.equal(a.tapped, 0);
  assert.equal(a.loudnessDb, null);
});

test("a child frame's player is visible even when the top frame is empty", () => {
  const a = aggregate([
    frame(0, { tapped: 0, host: "news.example", enabled: true, siteDisabled: false }),
    frame(7, { tapped: 1, loudnessDb: -22, gainDb: 3, skips: {} })
  ], NOW);
  assert.equal(a.tapped, 1, "child frame's tapped stream must count");
  assert.equal(a.loudnessDb, -22);
  assert.equal(a.gainDb, 3);
  assert.equal(a.host, "news.example", "host comes from the top frame");
});

test("counts and skip reasons sum across frames", () => {
  const a = aggregate([
    frame(0, { tapped: 1, compromised: 0, degraded: 1, skips: { cors: 1, drm: 0, inuse: 0, unknown: 0 } }),
    frame(1, { tapped: 2, compromised: 1, degraded: 0, skips: { cors: 1, drm: 2, inuse: 0, unknown: 0 } })
  ], NOW);
  assert.equal(a.tapped, 3);
  assert.equal(a.compromised, 1);
  assert.equal(a.degraded, 1);
  assert.deepEqual(a.skips, { drm: 2, cors: 2, inuse: 0, unknown: 0 });
});

test("stale frames are pruned by age", () => {
  const a = aggregate([
    frame(0, { tapped: 1, loudnessDb: -20, skips: {} }, 0),
    frame(1, { tapped: 5, loudnessDb: -10, skips: {} }, 9000) // stale → dropped
  ], NOW, 4000);
  assert.equal(a.frames, 1);
  assert.equal(a.tapped, 1);
  assert.equal(a.loudnessDb, -20);
});

test("representative loudness comes from the frame with the most tapped streams", () => {
  const a = aggregate([
    frame(0, { tapped: 1, loudnessDb: -30, gainDb: 1, skips: {} }),
    frame(1, { tapped: 3, loudnessDb: -18, gainDb: 5, skips: {} })
  ], NOW);
  assert.equal(a.loudnessDb, -18);
  assert.equal(a.gainDb, 5);
});

test("top-frame disabled state is reported", () => {
  const a = aggregate([
    frame(0, { tapped: 0, siteDisabled: true, enabled: true, host: "x.example" })
  ], NOW);
  assert.equal(a.siteDisabled, true);
});

test("observe mode is taken from the top frame", () => {
  const a = aggregate([frame(0, { tapped: 1, observe: true, loudnessDb: -25, gainDb: 4, skips: {} })], NOW);
  assert.equal(a.observe, true);
  assert.equal(a.gainDb, 4);
});
