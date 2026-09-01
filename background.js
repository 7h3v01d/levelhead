// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Levelhead — MV3 service worker: per-tab stats aggregator.
//
// Each frame's content script reports its stats here; the popup asks for a
// tab's deterministic aggregate. No new permissions: tab/frame identity comes
// from the message sender, and tab cleanup uses chrome.tabs.onRemoved (which
// needs no "tabs" permission).

importScripts("stats-aggregator.js");

// tabId -> Map(frameId -> { frameId, ts, stats })
const tabs = new Map();

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg) return;

  if (msg.type === "levelhead:report" && sender && sender.tab) {
    const tid = sender.tab.id;
    const fid = sender.frameId || 0;
    let frames = tabs.get(tid);
    if (!frames) { frames = new Map(); tabs.set(tid, frames); }
    frames.set(fid, { frameId: fid, ts: Date.now(), stats: msg.stats || {} });
    return; // no response expected
  }

  if (msg.type === "levelhead:getTab") {
    const frames = tabs.get(msg.tabId);
    const entries = frames ? [...frames.values()] : [];
    send(self.LevelheadStats.aggregate(entries, Date.now()));
    return true; // async response
  }
});

chrome.tabs.onRemoved.addListener(tid => tabs.delete(tid));
