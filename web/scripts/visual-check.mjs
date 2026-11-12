#!/usr/bin/env node
// Visual check of the built site (dist/). No dependencies: a small static server, headless Chrome and the
// DevTools protocol over Node's built-in WebSocket. For each page it waits for data to load, then fails on:
//   overlap   two different text runs whose boxes intersect
//   clipped   text cut off by an overflow:hidden box (without an ellipsis), or SVG text outside its chart
//   offpage   text past the right edge of the page
//   truncated text cut short with an ellipsis
// Fixed overlays (help button) are skipped: the footer reserves room for them instead.
// Usage: node scripts/visual-check.mjs [--key] [--shots DIR] [--only /path,/path] [--width 1440] [--dist DIR]
//   --key  only the KEY pages (npm run build runs this); without it, every page in PAGES (npm run check:visual).
// Chrome: $CHROME, else google-chrome, chromium or chromium-browser on PATH. With no Chrome the check prints
// SKIPPED and exits 0, unless TN_VISUAL_REQUIRED=1.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = resolve(process.argv.includes("--dist") ? process.argv[process.argv.indexOf("--dist") + 1] : join(ROOT, "dist"));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SHOTS = opt("--shots", null);
const WIDTH = Number(opt("--width", "1440"));

// Key pages: [path, screenshot name]. Every page here must pass.
export const PAGES = [
  ["/overview", "overview"], ["/funds", "funds"], ["/funds/meridian-yield-fund", "fund-meridian"], ["/funds/harbor-credit-fund", "fund-harbor"],
  ["/funds/meridian-yield-fund?tab=exposure", "fund-exposure"], ["/funds/meridian-yield-fund?tab=cashflows", "fund-cashflows"],
  ["/funds/meridian-yield-fund?tab=stress", "fund-stress"], ["/funds/meridian-yield-fund?tab=dataroom", "fund-dataroom"],
  ["/loans", "loans"], ["/loans/33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc", "loan-min03"],
  ["/markets", "markets"], ["/investor", "investor"], ["/manager", "manager"], ["/auditor", "auditor"],
  ["/reports/meridian-yield-fund", "report"], ["/verify", "verify"], ["/verify?tamper=reply", "verify-tamper"],
  ["/features", "features"], ["/features/tee-underwriting", "f1"], ["/features/verdicts", "f2"], ["/features/attestation", "f3"],
  ["/features/double-pledge", "f4"], ["/features/engine", "f5"], ["/features/engine?preset=t1", "f5-t1"], ["/features/certificates", "f6"],
  ["/features/roles", "f7"], ["/features/paid-report", "f8"], ["/features/agent-pin", "f9"], ["/features/receipts-mirror", "f10"],
  ["/features/evidence", "f11"], ["/data", "data"], ["/account/meridian.tnlab-368aa2.testnet", "account"], ["/faq", "faq"],
  ["/glossary", "glossary"], ["/methodology", "methodology"], ["/trust", "trust"], ["/support", "support"], ["/status", "status"],
  ["/roadmap", "roadmap"], ["/nope", "notfound"],
  ["/overview?tour=1", "tour-1"], ["/overview?tour=2", "tour-2"], ["/funds/meridian-yield-fund?tab=pledges&tour=3", "tour-3"],
  ["/funds/meridian-yield-fund?tour=4", "tour-4"], ["/loans/33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc?tour=5", "tour-5"],
  ["/verify?tour=6", "tour-6"], ["/reports/meridian-yield-fund?tour=7", "tour-7"],
];

// The judge path: checked on every npm run build.
export const KEY = ["/overview", "/funds", "/funds/meridian-yield-fund", "/loans/33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc", "/verify", "/features", "/features/double-pledge", "/features/engine", "/features/certificates", "/faq", "/overview?tour=2"];

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"]) {
    const r = spawnSync("which", [c], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain" };
function serve() {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = join(DIST, p);
    if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) f = join(DIST, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
    res.end(readFileSync(f));
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && waiting.has(j.id)) { const w = waiting.get(j.id); waiting.delete(j.id); j.error ? w.no(new Error(j.error.message)) : w.ok(j.result); }
    else if (j.method) events.push(j);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => { const n = ++id; waiting.set(n, { ok, no }); ws.send(JSON.stringify({ id: n, method, params, sessionId })); });
  return { send, events, close: () => ws.close() };
}

// Runs in the page. Returns problems as strings.
const PROBE = String.raw`(() => {
  const out = [];
  const W = document.documentElement.clientWidth;
  const skip = (el) => !!el.closest('[data-visual-ignore], .tickerslot, .helppanel, script, style, noscript, [aria-hidden="true"] .sr');
  const closedDetails = (el) => { const d = el.closest("details:not([open])"); return !!d && !el.closest("summary"); };
  const fixed = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (getComputedStyle(e).position === "fixed") return true; return false; };
  const visible = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false; } return true; };
  const label = (el, t) => (el.className && typeof el.className === "string" ? el.tagName.toLowerCase() + "." + el.className.split(" ")[0] : el.tagName.toLowerCase()) + ' "' + t.trim().slice(0, 40) + '"';
  const runs = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.textContent; if (!t || !t.trim()) continue;
    const el = n.parentElement; if (!el || skip(el) || closedDetails(el) || fixed(el) || !visible(el)) continue;
    let rects;
    if (el instanceof SVGElement) { const r = el.getBoundingClientRect(); rects = [r]; }
    else { const rg = document.createRange(); rg.selectNodeContents(n); rects = [...rg.getClientRects()]; }
    rects = rects.filter((r) => r.width > 1 && r.height > 1);
    // what the reader can see: each run cut to its scrolling or clipping ancestors
    const clipRects = [];
    for (let a = el; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible" || s.overflowY !== "visible") clipRects.push(a.getBoundingClientRect()); }
    const seenRects = rects.map((r) => { let l = r.left, t = r.top, rr = r.right, b = r.bottom; for (const c of clipRects) { l = Math.max(l, c.left); t = Math.max(t, c.top); rr = Math.min(rr, c.right); b = Math.min(b, c.bottom); } return { left: l, top: t, width: rr - l, height: b - t }; }).filter((r) => r.width > 1 && r.height > 1);
    for (const r of seenRects) runs.push({ el, n, t, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
    // clipped by an ancestor with overflow hidden or clip (HTML only)
    if (!(el instanceof SVGElement)) {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (/(hidden|clip)/.test(s.overflowX + s.overflowY) && s.position !== "fixed") {
          const ar = a.getBoundingClientRect();
          const tr = rects.reduce((m, r) => ({ l: Math.min(m.l, r.left), r: Math.max(m.r, r.right), t: Math.min(m.t, r.top), b: Math.max(m.b, r.bottom) }), { l: 1e9, r: -1e9, t: 1e9, b: -1e9 });
          if (!rects.length) break;
          const ell = s.textOverflow === "ellipsis" || getComputedStyle(el).textOverflow === "ellipsis";
          if (ell && a.scrollWidth > a.clientWidth + 1) { out.push("truncated: " + label(el, t) + " shown with an ellipsis"); break; }
          if (!ell && (tr.r > ar.right + 1.5 || tr.l < ar.left - 1.5 || tr.b > ar.bottom + 2 || tr.t < ar.top - 2) && ar.width > 0) out.push("clipped: " + label(el, t) + " inside " + label(a, ""));
          break;
        }
        if (/(auto|scroll)/.test(s.overflowX)) break; // scrollable box: text is reachable
      }
      for (const r of seenRects) if (r.left + r.width > W + 1) { out.push("offpage: " + label(el, t)); break; }
    } else {
      const svg = el.ownerSVGElement; if (svg) { const sr = svg.getBoundingClientRect(); const r = rects[0];
        if (r && (r.right > sr.right + 2 || r.left < sr.left - 2 || r.bottom > sr.bottom + 2 || r.top < sr.top - 2)) out.push("clipped: svg text " + label(el, t) + " outside its chart"); }
    }
  }
  runs.sort((a, b) => a.y - b.y);
  const seen = new Set();
  for (let i = 0; i < runs.length; i++) {
    const a = runs[i];
    for (let j = i + 1; j < runs.length && runs[j].y < a.y + a.h; j++) {
      const b = runs[j];
      if (a.n === b.n) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) { if (a.el instanceof SVGElement || b.el instanceof SVGElement) continue; }
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 2 && iy > Math.min(a.h, b.h) * 0.35) {
        const k = label(a.el, a.t) + " x " + label(b.el, b.t);
        if (!seen.has(k)) { seen.add(k); out.push("overlap: " + k); }
      }
    }
  }
  return out;
})()`;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) { console.error("visual-check: dist/ missing, run vite build first"); process.exit(1); }
  const chrome = findChrome();
  if (!chrome) {
    const msg = "visual-check: SKIPPED, no Chrome found (set CHROME=/path/to/chrome)";
    if (process.env.TN_VISUAL_REQUIRED === "1") { console.error(msg); process.exit(1); }
    console.log(msg); return;
  }
  const only = opt("--only", null);
  const named = new Map(PAGES);
  const pages = only ? only.split(",").map((p) => [p, named.get(p) ?? (p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root")]) : args.includes("--key") ? PAGES.filter(([p]) => KEY.includes(p)) : PAGES;
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const prof = mkdtempSync(join(tmpdir(), "tn-visual-"));
  const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${prof}`, `--window-size=${WIDTH},1000`, "about:blank"], { stdio: "ignore" });
  let fail = 0;
  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) { await sleep(100); const f = join(prof, "DevToolsActivePort"); if (existsSync(f)) port = readFileSync(f, "utf8").split("\n")[0]; }
    if (!port) throw new Error("Chrome did not start");
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const c = await cdp(ver.webSocketDebuggerUrl);
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    for (const [path, name] of pages) {
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m, p) => c.send(m, p, sessionId);
      await s("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 1000, deviceScaleFactor: 1, mobile: false });
      await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await s("Page.enable");
      await s("Page.navigate", { url: base + path });
      // wait until the page settles: no skeletons, no "Reading" buttons, for 2 polls in a row (max 25 s)
      let calm = 0;
      for (let t = 0; t < 100 && calm < 3; t++) {
        await sleep(250);
        const r = await s("Runtime.evaluate", { expression: `document.readyState === "complete" && !document.querySelector(".skel, [aria-busy='true'], .livepill.busy")`, returnByValue: true });
        calm = r.result.value ? calm + 1 : 0;
      }
      await sleep(600);
      // probe at the top of the page: a sticky top bar over scrolled content is not an overlap
      await s("Runtime.evaluate", { expression: `document.documentElement.style.scrollBehavior = "auto"; window.scrollTo(0, 0)` });
      await sleep(250);
      const r = await s("Runtime.evaluate", { expression: PROBE, returnByValue: true });
      const probs = (r.result && r.result.value) || [String(r.exceptionDetails && r.exceptionDetails.text)];
      if (SHOTS) {
        const m = await s("Page.getLayoutMetrics");
        const h = Math.ceil(Math.min(m.cssContentSize.height, 16000));
        await s("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        const shot = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
      }
      console.log(`${probs.length ? "FAIL" : "ok  "} ${path}${probs.length ? `\n  ${probs.slice(0, 25).join("\n  ")}${probs.length > 25 ? `\n  ... ${probs.length - 25} more` : ""}` : ""}`);
      if (probs.length) fail++;
      await c.send("Target.closeTarget", { targetId });
    }
    c.close();
  } finally {
    proc.kill("SIGKILL");
    srv.close();
    await sleep(200);
    rmSync(prof, { recursive: true, force: true });
  }
  console.log(`visual-check: ${pages.length - fail} of ${pages.length} pages clean`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error("visual-check:", e.message); process.exit(1); });
