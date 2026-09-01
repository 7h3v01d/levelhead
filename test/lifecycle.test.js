// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Run: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lifecycle.js");

test("a fresh record is unowned, undecided, and reconsiderable", () => {
  const r = L.newRecord();
  assert.equal(r.owned, false);
  assert.equal(L.encryptedActive(r), false);
  assert.equal(L.shouldReconsider(r), true);
});

test("DRM evidence is scoped to the current generation", () => {
  const r = L.newRecord();
  L.markEncrypted(r);
  assert.equal(L.encryptedActive(r), true);   // this source is DRM
  L.bumpGeneration(r);                          // element loads a new source
  assert.equal(L.encryptedActive(r), false);    // DRM must NOT persist into it
});

test("a skip decision is scoped to the current generation", () => {
  const r = L.newRecord();
  L.markSkipped(r);
  assert.equal(L.shouldReconsider(r), false);   // don't re-skip the same source
  L.bumpGeneration(r);                            // new source arrives
  assert.equal(L.shouldReconsider(r), true);      // must be reconsidered
});

test("safe → DRM → safe recovers (the README promise, in state form)", () => {
  const r = L.newRecord();
  assert.equal(L.encryptedActive(r), false);     // safe source A
  L.bumpGeneration(r); L.markEncrypted(r);
  assert.equal(L.encryptedActive(r), true);      // DRM source B
  L.bumpGeneration(r);
  assert.equal(L.encryptedActive(r), false);     // safe source C — recovered
});

test("skipped cross-origin then safe source becomes eligible again", () => {
  const r = L.newRecord();
  L.markSkipped(r);                               // source A skipped (cors)
  assert.equal(L.shouldReconsider(r), false);
  L.bumpGeneration(r);                            // source B (same-origin)
  assert.equal(L.shouldReconsider(r), true);      // gets another look
});
