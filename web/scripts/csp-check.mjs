#!/usr/bin/env node
// CSP check of the built site (dist/) under the exact headers in web/vercel.json.
// No dependencies: a small static server that sends those headers, headless Chrome and the DevTools protocol.
// For each page it records every CSP violation (main page and the near-connect srcdoc wallet iframe, which
// inherits the page policy), then opens the wallet modal and starts each testnet wallet's sandbox.
// Usage: node scripts/csp-check.mjs [--csp "policy"] [--wallets id,id] [--no-wallets]
// Live network: feeds, RPC and wallet manifests load from the real hosts, so run it online.
// Chrome: $CHROME, else google-chrome or chromium on PATH. With no Chrome it prints SKIPPED and exits 0.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(ROOT, "dist");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

export function siteHeaders(config = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"))) {
  const rule = (config.headers || []).find((h) => h.source === "/(.*)");
  const out = {};
  for (const { key, value } of rule ? rule.headers : []) out[key] = value;
  return out;
}

const PAGES = ["/", "/overview", "/funds/meridian-yield-fund", "/investor", "/manager", "/support", "/markets", "/status"];
const DEFAULT_WALLETS = ["meteor-wallet", "intear-wallet", "near-cli", "nightly-wallet", "wallet-connect", "ethereum-wallets", "ledger"];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain" };
function serve(headers) {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.startsWith("/api/")) { res.writeHead(404, { ...headers, "content-type": "application/json" }); res.end("{}"); return; }
    let f = join(DIST, p);
    if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) f = join(DIST, "index.html");
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(f)] || "application/octet-stream" });
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

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"]) {
    const r = spawnSync("which", [c], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function hostOf(u) {
  try { const x = new URL(u); return x.protocol + "//" + x.host; } catch { return u || "(inline)"; }
}

// Runs in every frame before page scripts. Collects violations from this frame.
const HOOK = String.raw`(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    const rec = { d: e.effectiveDirective, u: String(e.blockedURI || "").slice(0, 120), s: String(e.sourceFile || "").slice(0, 80) };
    window.__csp.push(rec);
    try { if (window.top !== window) window.top.postMessage({ __cspv: rec }, "*"); } catch {}
  }, true);
  window.__walletMsgs = [];
  if (window.top === window) window.addEventListener("message", (m) => {
    if (m.data && m.data.__cspv) window.__csp.push({ ...m.data.__cspv, frame: "child" });
    if (m.data && typeof m.data.method === "string") window.__walletMsgs.push(m.data.method.slice(0, 40));
  });
})()`;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) { console.error("csp-check: dist/ missing, run vite build first"); process.exit(1); }
  const chrome = findChrome();
  if (!chrome) { console.log("csp-check: SKIPPED, no Chrome found"); return; }
  const headers = siteHeaders();
  if (opt("--csp", null)) headers["Content-Security-Policy"] = opt("--csp");
  const wallets = args.includes("--no-wallets") ? [] : (opt("--wallets", null)?.split(",") ?? DEFAULT_WALLETS);
  const srv = await serve(headers);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const prof = mkdtempSync(join(tmpdir(), "tn-csp-"));
  const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
  let port;
  for (let i = 0; i < 300 && !port; i++) { await sleep(100); const f = join(prof, "DevToolsActivePort"); if (existsSync(f)) port = readFileSync(f, "utf8").split("\n")[0]; }
  let fail = 0;
  const report = [];
  try {
    if (!port) throw new Error("Chrome did not start");
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const c = await cdp(ver.webSocketDebuggerUrl);
    const open = async (path) => {
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m, p) => c.send(m, p, sessionId);
      await s("Page.enable");
      await s("Log.enable");
      await s("Runtime.enable");
      await s("Page.addScriptToEvaluateOnNewDocument", { source: HOOK, runImmediately: true });
      // Sandboxed srcdoc wallet frames can run out of process: attach to them and read their console too.
      const kids = new Set([sessionId]);
      await s("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const watchKids = setInterval(() => {
        for (const e of c.events) {
          if (e.method === "Target.attachedToTarget" && kids.has(e.sessionId) && !kids.has(e.params.sessionId)) {
            const k = e.params.sessionId;
            kids.add(k);
            c.send("Log.enable", {}, k).catch(() => {});
            c.send("Runtime.enable", {}, k).catch(() => {});
            c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, k).catch(() => {});
          }
        }
      }, 100);
      const t0 = c.events.length;
      await s("Page.navigate", { url: base + path });
      await sleep(6000);
      const ev = (expression) => s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);
      const logs = () => c.events.slice(t0).filter((e) => kids.has(e.sessionId) && ((e.method === "Log.entryAdded" && /Content Security Policy|Refused to/i.test(e.params.entry.text)) || (e.method === "Runtime.consoleAPICalled" && /Content Security Policy|Refused to/i.test(JSON.stringify(e.params.args)))));
      return { s, ev, logs, targetId, stop: () => clearInterval(watchKids) };
    };
    for (const path of PAGES) {
      const p = await open(path);
      const v = await p.ev("JSON.stringify(window.__csp)");
      const rendered = await p.ev(`document.querySelector("#root")?.children.length || 0`);
      const list = JSON.parse(v || "[]");
      const logLines = p.logs().map((e) => (e.params.entry ? e.params.entry.text : JSON.stringify(e.params.args)).slice(0, 200));
      const bad = list.length + logLines.length > 0 || !rendered;
      if (bad) fail++;
      report.push({ path, rendered: !!rendered, violations: list, logs: logLines });
      p.stop();
      await c.send("Target.closeTarget", { targetId: p.targetId });
    }
    if (wallets.length) {
      const p = await open("/overview");
      const clicked = await p.ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /Connect wallet/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
      await sleep(4000);
      const modal = await p.ev(`(() => { const items = [...document.querySelectorAll("[data-type]")].map((e) => e.getAttribute("data-type")); return items; })()`);
      report.push({ path: "wallet modal", clicked, walletsListed: modal });
      if (!clicked || !Array.isArray(modal) || modal.length === 0) fail++;
      for (const id of wallets) {
        if (!modal.includes(id)) { report.push({ wallet: id, listed: false }); continue; }
        const before = JSON.parse((await p.ev("JSON.stringify(window.__csp)")) || "[]").length;
        const t1 = p.logs().length;
        await p.ev(`(() => { const e = document.querySelector('[data-type="${id}"]'); if (e) e.click(); return !!e; })()`);
        await sleep(7000);
        const all = JSON.parse((await p.ev("JSON.stringify(window.__csp)")) || "[]");
        const iframes = await p.ev(`document.querySelectorAll("iframe").length`);
        const msgs = await p.ev(`[...new Set(window.__walletMsgs)].join(",")`);
        const logLines = p.logs().slice(t1).map((e) => (e.params.entry ? e.params.entry.text : JSON.stringify(e.params.args)).slice(0, 220));
        const v = all.slice(before);
        report.push({ wallet: id, iframes, ready: /wallet-ready/.test(msgs || ""), msgs, violations: v, logs: logLines });
        if (v.length || logLines.length || !/wallet-ready/.test(msgs || "")) fail++;
        // close the wallet popup and reopen the modal for the next wallet
        await p.ev(`document.querySelectorAll("iframe").forEach((f) => f.closest("div[class*=popup], .hot-connector-popup, body > div")?.remove())`);
        await p.s("Page.reload", {});
        await sleep(5000);
        await p.ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /Connect wallet/.test(x.textContent)); if (b) b.click(); })()`);
        await sleep(3000);
      }
    }
    c.close();
  } finally {
    proc.kill("SIGKILL");
    srv.close();
    await sleep(500);
    try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp profile, leave it */ }
  }
  for (const r of report) {
    const keys = new Set();
    for (const v of r.violations || []) keys.add(`${v.d} ${hostOf(v.u)}${v.frame ? " (iframe)" : ""}`);
    for (const l of r.logs || []) keys.add("log: " + l.replace(/https?:\/\/127\.0\.0\.1:\d+/g, "").slice(0, 140));
    const name = r.path || `wallet ${r.wallet}`;
    const extra = r.walletsListed ? ` listed=${r.walletsListed.join(",")}` : r.listed === false ? " not listed" : r.iframes !== undefined ? ` iframes=${r.iframes} ready=${r.ready} msgs=${r.msgs}` : r.rendered === false ? " NOT RENDERED" : "";
    console.log(`${keys.size || r.ready === false || r.rendered === false ? "FAIL" : "ok  "} ${name}${extra}`);
    for (const k of keys) console.log(`     ${k}`);
  }
  console.log(fail ? `csp-check: ${fail} problem(s)` : "csp-check: no CSP violations");
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
