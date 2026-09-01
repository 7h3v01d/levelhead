// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)

"use strict";

const DEFAULTS = {
  enabled: true,
  targetDb: -24,
  maxBoostDb: 12,
  maxCutDb: 12,
  compression: "medium",
  disabledHosts: [],
  debug: false
};

const $ = s => document.querySelector(s);
let currentHost = null;
let pollTimer = null;

const fmtDb = v =>
  typeof v === "number" && isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(1)}` : "—";

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $("#enabled").checked = s.enabled;
  $("#targetDb").value = s.targetDb;
  $("#targetVal").textContent = `${s.targetDb} dB`;
  $("#maxBoostDb").value = s.maxBoostDb;
  $("#boostVal").textContent = `+${s.maxBoostDb} dB`;
  $("#compression").value = s.compression;
  $("#debug").checked = s.debug;

  const tab = await activeTab();
  currentHost = hostOf(tab && tab.url);
  $("#host").textContent = currentHost || "unsupported page";
  updateSiteButton(currentHost && s.disabledHosts.includes(currentHost));
}

function updateSiteButton(disabled) {
  const btn = $("#siteToggle");
  btn.textContent = disabled ? "Enable here" : "Disable here";
  btn.classList.toggle("active", !!disabled);
}

const set = (key, value) => chrome.storage.local.set({ [key]: value });

$("#enabled").addEventListener("change", e => set("enabled", e.target.checked));
$("#debug").addEventListener("change", e => set("debug", e.target.checked));
$("#targetDb").addEventListener("input", e => {
  $("#targetVal").textContent = `${e.target.value} dB`;
  set("targetDb", Number(e.target.value));
});
$("#maxBoostDb").addEventListener("input", e => {
  $("#boostVal").textContent = `+${e.target.value} dB`;
  set("maxBoostDb", Number(e.target.value));
});
$("#compression").addEventListener("change", e => set("compression", e.target.value));

$("#siteToggle").addEventListener("click", async () => {
  if (!currentHost) return;
  const { disabledHosts } = await chrome.storage.local.get({ disabledHosts: [] });
  const i = disabledHosts.indexOf(currentHost);
  if (i >= 0) disabledHosts.splice(i, 1);
  else disabledHosts.push(currentHost);
  await chrome.storage.local.set({ disabledHosts });
  updateSiteButton(i < 0);
});

function skipSummary(skips) {
  if (!skips) return "";
  const parts = [];
  if (skips.drm) parts.push(`${skips.drm} DRM`);
  if (skips.cors) parts.push(`${skips.cors} cross-origin`);
  if (skips.inuse) parts.push(`${skips.inuse} in use`);
  if (skips.unknown) parts.push(`${skips.unknown} unknown`);
  return parts.length ? `⊘ ${parts.join(", ")} skipped` : "";
}

async function poll() {
  const tab = await activeTab();
  if (!tab) return;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "getStats" });
    if (!r) throw new Error("no response");
    $("#loudness").textContent = fmtDb(r.loudnessDb);
    $("#gain").textContent = fmtDb(r.gainDb);
    $("#tapped").textContent = String(r.tapped);

    let note = "";
    if (r.siteDisabled) note = "Disabled on this site.";
    else if (!r.enabled) note = "Leveler is off.";
    else if (r.tapped === 0) note = "No eligible media tapped yet.";
    const skip = skipSummary(r.skips);
    if (skip) note += (note ? "  " : "") + skip;
    if (r.compromised) note += (note ? "  " : "") + `⚠ ${r.compromised} source(s) unsafe after tap`;
    if (r.degraded) note += (note ? "  " : "") + `${r.degraded} degraded (no worklet)`;
    $("#status").textContent = note;
  } catch {
    $("#loudness").textContent = "—";
    $("#gain").textContent = "—";
    $("#tapped").textContent = "—";
    $("#status").textContent = "No content script on this page.";
  }
}

loadSettings().then(() => {
  poll();
  pollTimer = setInterval(poll, 500);
});
window.addEventListener("unload", () => clearInterval(pollTimer));
