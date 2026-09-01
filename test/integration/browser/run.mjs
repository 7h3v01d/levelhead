// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Real-browser integration harness (Tier 2).
//
// Loads the UNPACKED extension into a real Chromium via Puppeteer and verifies
// Levelhead's eligibility decisions against genuine Web Audio behaviour, using
// a page-side probe: once the extension has called createMediaElementSource on
// an element, the page's own createMediaElementSource on that same element
// throws "already connected" — a browser-truthful signal of ownership.
//
// Requirements (run on a machine that has Chrome; NOT runnable in a sandbox
// without a browser binary):
//   npm install                      # installs puppeteer + a Chrome for Testing
//   node test/integration/browser/run.mjs
//
// If you already have Chrome, set PUPPETEER_EXECUTABLE_PATH to its path and
// install puppeteer with PUPPETEER_SKIP_DOWNLOAD=1.
//
// Notes:
//   * MV3 extensions require a non-headless context or the new headless
//     ("--headless=new"); this runner uses headful by default for reliability.
//   * BFCache / park-revive / gain-authority boundaries are exercised in depth
//     by the jsdom tier (test/integration/lifecycle.integration.test.mjs);
//     this tier confirms the eligibility gate under real Chromium.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "..", ".."); // the extension root (has manifest.json)
const FIXTURES = join(HERE, "fixtures");

const MIME = { ".html": "text/html", ".mp4": "video/mp4", ".webm": "video/webm", ".js": "text/javascript" };

// Two static servers on different ports = two origins (for the cross-origin case).
function serve(port, rewrite) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const name = req.url.split("?")[0].replace(/^\//, "") || "same-origin.html";
      const file = join(FIXTURES, name);
      if (!existsSync(file)) { res.writeHead(404); res.end("nope"); return; }
      let body = readFileSync(file);
      if (rewrite && extname(file) === ".html") body = Buffer.from(rewrite(body.toString()));
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    });
    srv.listen(port, () => resolve(srv));
  });
}

async function main() {
  let puppeteer;
  try { puppeteer = (await import("puppeteer")).default; }
  catch { console.error("puppeteer is not installed. Run `npm install` first."); process.exit(2); }

  const OTHER = "http://127.0.0.1:8112";
  const mainSrv = await serve(8111, html => html.replace("CROSS_ORIGIN_SRC", OTHER + "/media.webm"));
  const otherSrv = await serve(8112);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox"
    ]
  });

  const results = [];
  const check = (name, cond, extra = "") => { results.push({ name, ok: !!cond, extra }); };

  async function probe(url, { disableSite = false } = {}) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load" });
    // Give the content script time to discover + classify + (maybe) tap.
    await new Promise(r => setTimeout(r, 1500));
    const r = await page.evaluate(() => window.__levelheadProbe ? window.__levelheadProbe() : { tapped: null });
    await page.close();
    return r;
  }

  try {
    const same = await probe("http://127.0.0.1:8111/same-origin.html");
    check("same-origin media is tapped", same.tapped === true, JSON.stringify(same));

    const cross = await probe("http://127.0.0.1:8111/cross-origin.html");
    check("cross-origin media is NOT tapped", cross.tapped === false, JSON.stringify(cross));
  } finally {
    await browser.close();
    mainSrv.close(); otherSrv.close();
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? "ok  " : "FAIL"} - ${r.name}${r.ok ? "" : "  " + r.extra}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
