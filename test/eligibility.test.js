// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Run: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../eligibility.js");

const PAGE = "https://site.example";
const base = (over = {}) => ({
  mediaKeys: false, encrypted: false, src: "", readyState: 4,
  crossOrigin: null, pageOrigin: PAGE, ...over
});

test("same-origin file is ok", () => {
  assert.equal(E.classify(base({ src: PAGE + "/clip.mp4" })), "ok");
});

test("same-origin blob (MSE) is ok", () => {
  assert.equal(E.classify(base({ src: "blob:" + PAGE + "/uuid" })), "ok");
});

test("cross-origin without CORS is skipped", () => {
  assert.equal(E.classify(base({ src: "https://cdn.other/clip.mp4" })), "cors");
});

test("cross-origin WITH crossorigin=anonymous is ok", () => {
  assert.equal(E.classify(base({ src: "https://cdn.other/clip.mp4", crossOrigin: "anonymous" })), "ok");
});

test("mediaKeys means drm", () => {
  assert.equal(E.classify(base({ src: PAGE + "/clip.mp4", mediaKeys: true })), "drm");
});

test("observed encrypted event means drm even before mediaKeys attaches", () => {
  assert.equal(E.classify(base({ src: PAGE + "/clip.mp4", encrypted: true, mediaKeys: false })), "drm");
});

test("no source yet → wait", () => {
  assert.equal(E.classify(base({ src: "" })), "wait");
});

test("metadata not loaded → wait", () => {
  assert.equal(E.classify(base({ src: PAGE + "/clip.mp4", readyState: 0 })), "wait");
});

test("data: URL is ok", () => {
  assert.equal(E.classify(base({ src: "data:audio/wav;base64,AAAA", readyState: 0 })), "ok");
});

// The P0-1 scenario: one element's source changing over its lifetime.
test("lifetime replacement: eligible → cross-origin → DRM → back to eligible", () => {
  assert.equal(E.classify(base({ src: PAGE + "/a.mp4" })), "ok");
  assert.equal(E.classify(base({ src: "https://cdn.other/b.mp4" })), "cors");
  assert.equal(E.classify(base({ src: "https://cdn.other/b.mp4", mediaKeys: true })), "drm");
  assert.equal(E.classify(base({ src: PAGE + "/c.mp4" })), "ok");
});
