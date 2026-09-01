// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Leon Priest (github: 7h3v01d)
//
// Real-browser integration harness (Tier 2).
//
// Loads the UNPACKED extension into real Chromium via Puppeteer and verifies
// Levelhead's irreversible-tap ownership decisions against genuine Web Audio,
// using a page-side probe: once Levelhead has called createMediaElementSource
// on an element, the page's own createMediaElementSource on that element throws
// "already connected" — a browser-truthful signal of ownership.
//
// Requirements (a machine WITH Chrome; not runnable in a browserless sandbox):
//   npm ci                         # installs puppeteer + Chrome for Testing
//   npm run test:browser
// If you already have Chrome, set PUPPETEER_EXECUTABLE_PATH and install with
// PUPPETEER_SKIP_DOWNLOAD=1.
//
// Every case asserts the fixture actually reached HAVE_METADATA before judging
// tap/no-tap, so "not tapped" can never be a false pass caused by media that
// simply failed to load.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "..", "..");     // extension root (manifest.json)
const FIXTURES = join(HERE, "fixtures");
const MAIN = 8111, OTHER = 8112;

const MIME = {
  ".html": "text/html", ".wav": "audio/wav",
  ".webm": "video/webm", ".mp4": "video/mp4", ".js": "text/javascript"
};

function serve(port, rewrite) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const name = req.url.split("?")[0].replace(/^\//, "") || "same-origin.html";
      const file = join(FIXTURES, name);
      if (!existsSync(file)) { res.writeHead(404); res.end("nope"); return; }
      let body = readFileSync(file);
      if (rewrite && extname(file) === ".html") body = Buffer.from(rewrite(body.toString()));
      // No Access-Control-Allow-Origin header anywhere → cross-origin stays no-CORS.
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    });
    srv.listen(port, () => resolve(srv));
  });
}

async function main() {
  let puppeteer;
  try { puppeteer = (await import("puppeteer")).default; }
  catch { console.error("puppeteer is not installed. Run `npm ci` first."); process.exit(2); }

  const mainSrv = await serve(MAIN, html => html.replace("CROSS_ORIGIN_SRC", `http://127.0.0.1:${OTHER}/media.wav`));
  const otherSrv = await serve(OTHER);

  const browser = await puppeteer.launch({
    headless: false,
    // Let Puppeteer own extension loading. The array form of enableExtensions
    // installs the unpacked extension via CDP and, for Chrome, requires a
    // remote-debugging pipe (pipe: true). This replaces the old --load-extension
    // / --disable-extensions-except flags, which Chrome 137+ removed and which
    // Puppeteer would override with its default --disable-extensions anyway.
    pipe: true,
    enableExtensions: [EXT_DIR],
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox"
    ]
  });

  // Scope to Levelhead's own service worker, not the first arbitrary one.
  const swTarget = await browser.waitForTarget(
    t => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 10000 }
  );
  const sw = await swTarget.worker();
  const setEnabled = v => sw.evaluate(val => chrome.storage.local.set({ enabled: val }), v);

  const results = [];
  const check = (name, ok, extra = "") => results.push({ name, ok: !!ok, extra });

  async function probe(path, { requireReady = true } = {}) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${MAIN}/${path}`, { waitUntil: "load" });
    // Wait until the fixture media has real metadata, so tap decisions are meaningful.
    let ready = true;
    try {
      await page.waitForFunction(() => {
        const v = document.getElementById("v");
        return v && v.readyState >= 1; // HAVE_METADATA
      }, { timeout: 5000 });
    } catch { ready = false; }
    const media = await page.evaluate(() => window.__mediaState ? window.__mediaState() : null);
    // Give the content script time to discover + classify + (maybe) tap.
    await new Promise(r => setTimeout(r, 1200));
    const probe = await page.evaluate(() => window.__levelheadProbe ? window.__levelheadProbe() : { tapped: null });
    await page.close();
    if (requireReady && !ready) throw new Error(`fixture ${path} never reached HAVE_METADATA: ${JSON.stringify(media)}`);
    return { ready, media, ...probe };
  }

  try {
    const same = await probe("same-origin.html");
    check("fixture: same-origin media reached HAVE_METADATA", same.ready, JSON.stringify(same.media));
    check("same-origin eligible media is TAPPED", same.tapped === true, JSON.stringify(same));

    const cross = await probe("cross-origin.html");
    check("fixture: cross-origin media reached HAVE_METADATA", cross.ready, JSON.stringify(cross.media));
    check("cross-origin media is NOT tapped (refused ownership)", cross.tapped === false, JSON.stringify(cross));

    await setEnabled(false);
    const off = await probe("off.html");
    check("fixture: OFF-page media reached HAVE_METADATA", off.ready, JSON.stringify(off.media));
    check("master OFF does NOT tap untapped media", off.tapped === false, JSON.stringify(off));
    await setEnabled(true);
  } catch (e) {
    check("browser harness ran without fixture/oracle errors", false, String(e && e.message || e));
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
