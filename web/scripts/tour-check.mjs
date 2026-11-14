#!/usr/bin/env node
// Walks the whole guided tour in a real browser, from a first visit, at 1440x900 and 390x844. It builds the app
// (unless --no-build), serves dist/, and for every step checks: the popover is visible, inside the screen, next to
// the target and not over it; the target exists, is visible and lit; the spotlight is on it; the copy has no dashes;
// and, for action steps, that clicking the real target makes the expected change and the tour moves on by itself.
// It also checks Back, Next on an action step, Skip, Finish, Esc, ?tour=N resume, ?notour=1, once only auto start,
// the Take the tour entry point, a reload with the flag set, and that nothing logs a console error.
// Usage: node scripts/tour-check.mjs [--no-build] [--shots DIR] [--width 1440|390]
// Browser: playwright-core (web/node_modules, or the folder in $TN_PLAYWRIGHT_CORE) and Chrome ($CHROME, else
// google-chrome, chromium or chromium-browser). With either missing it prints SKIPPED and exits 0 unless TN_TOUR_REQUIRED=1.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { TOUR_STEPS, TOUR_KEY } from "../src/shell/tour-steps.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(ROOT, "dist");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SHOTS = resolve(opt("--shots", "/workspace/tour-shots"));
const WIDTHS = opt("--width", null) ? [Number(opt("--width"))] : [1440, 390];
const REQUIRED = process.env.TN_TOUR_REQUIRED === "1";
const skip = (why) => { console.log(`tour check SKIPPED: ${why}`); process.exit(REQUIRED ? 1 : 0); };

let chromium;
for (const base of [join(ROOT, "package.json"), process.env.TN_PLAYWRIGHT_CORE && join(process.env.TN_PLAYWRIGHT_CORE, "package.json")].filter(Boolean)) {
  try { ({ chromium } = createRequire(base)("playwright-core")); break; } catch { /* try the next place */ }
}
if (!chromium) skip("playwright-core not found (install it in web/, or set TN_PLAYWRIGHT_CORE to a folder that has it)");
function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"]) {
    const r = spawnSync("which", [c], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const CHROME = findChrome();
if (!CHROME) skip("no Chrome or Chromium found");

if (!args.includes("--no-build")) {
  const b = spawnSync("npm", ["run", "build:fast"], { cwd: ROOT, encoding: "utf8" });
  if (b.status !== 0) { console.error(b.stdout + b.stderr); process.exit(1); }
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain", ".pdf": "application/pdf" };
const srv = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f = join(DIST, p);
  if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) f = join(DIST, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const N = TOUR_STEPS.length;
const NARROW_PX = 1100;
const fails = [];
const fail = (w, where, msg) => { fails.push(`[${w}] ${where}: ${msg}`); console.log(`  FAIL [${w}] ${where}: ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THIRD_PARTY = /frankfurter|fiscaldata|coingecko|llama|nyfed|treasury\.gov|CORS policy|net::ERR_(FAILED|BLOCKED|NAME|INTERNET)/i;

// What the highlighted thing must show, so the copy and the screen agree. A step with no entry is only checked for visibility.
const SHOWS = {
  welcome: /Private credit NAV/i, "nav-range": /TrueRange/i, "all-funds": /All funds/i, "funds-table": /Meridian Yield Fund/, "open-meridian": /Meridian Yield Fund/,
  "fund-score": /TrueNav score[\s\S]*Reported NAV/i, "tab-loans": /Loan book/, "tab-pledges": /Pledges and alerts/, refused: /already holds|already pledged|Refused/i,
  "tab-overview": /Overview/, recompute: /Recompute check/i, "tab-stress": /Stress/, "loans-list": /pledged loans/i, "open-loan": /^33b1021e/,
  "loan-verdict": /Latest verdict/i, signature: /Check signature/, "loan-privacy": /Privacy/, "view-investor": /Investor view/i, "view-manager": /Fund manager view/i,
  "view-auditor": /Auditor view/i, markets: /Markets/, "privacy-boundary": /Who sees what|privacy|boundary/i, "trust-attestation": /Attestation/i, verifier: /Verifier/,
  tamper: /Change the TEE signer/, "feature-tee-underwriting": /What it does/, "feature-verdicts": /What it does/, "feature-attestation": /Flip one bit/,
  "feature-double-pledge": /Simulate the call/, "feature-engine": /Apply the T1 flag/, "feature-certificates": /Flip one signature byte/, "feature-roles": /What it does/,
  "feature-paid-report": /Step 1/, "feature-agent-pin": /Wrong engine version_key/, "feature-receipts-mirror": /What it does/, "feature-evidence": /What it does/,
  "raw-data": /Raw chain data/, report: /Build JSON bundle/, methodology: /Methodology/, roadmap: /Roadmap/, status: /Data status/, glossary: /Glossary/, faq: /Questions and answers/,
  support: /Support/, "features-index": /Verify it yourself/,
};

const dashRe = /[\u2013\u2014]/;
const boxOf = async (loc) => loc.boundingBox();
const gapBetween = (a, b) => { const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)); const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)); return Math.hypot(dx, dy); };
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

async function open(browser, width, { query = "", path = "/overview", fresh = true, ctx } = {}) {
  const context = ctx ?? await browser.newContext({ viewport: { width, height: width > 800 ? 900 : 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !THIRD_PARTY.test(m.text() + (m.location()?.url ?? ""))) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE + path + query, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}
const stepNow = (page) => page.evaluate(() => Number(new URL(location.href).searchParams.get("tour") || 0));
const flagNow = (page) => page.evaluate((k) => localStorage.getItem(k), TOUR_KEY);
const hasTour = (page) => page.locator("aside.tour").count().then((c) => c > 0);

/** Wait for the popover of step i to be on screen and still. Returns the popover box. */
async function settle(page, i, w) {
  const s = TOUR_STEPS[i - 1];
  const pop = page.locator(`aside.tour[data-step="${s.id}"]`);
  try { await pop.waitFor({ state: "visible", timeout: 15000 }); } catch { fail(w, `${i} ${s.id}`, "popover never showed"); return null; }
  let prev = "", still = 0;
  for (let k = 0; k < 40 && still < 3; k++) {
    const sig = JSON.stringify([await boxOf(pop), await page.locator(".tour-spot").boundingBox().catch(() => null), await page.evaluate(() => scrollY)]);
    still = sig === prev ? still + 1 : 0; prev = sig;
    await sleep(120);
  }
  return pop;
}

async function checkStep(page, i, w, width) {
  const s = TOUR_STEPS[i - 1];
  const where = `${i} ${s.id}`;
  const pop = await settle(page, i, w);
  if (!pop) return false;
  const vp = page.viewportSize();
  const pb = await boxOf(pop);
  if (pb.x < 0 || pb.y < 0 || pb.x + pb.width > vp.width + 0.5 || pb.y + pb.height > vp.height + 0.5) fail(w, where, `popover is not inside the screen: ${JSON.stringify(pb)}`);
  const side = await pop.getAttribute("data-side");
  if (side === "over") fail(w, where, "no side had room, popover is over the page with no arrow");
  if ((await stepNow(page)) !== i) fail(w, where, "URL step does not match");
  const here = await page.evaluate(() => location.pathname.replace(/\/+$/, "") || "/");
  if (here !== new URL(s.path, "http://x").pathname) fail(w, where, `on ${here}, expected ${s.path}`);
  const text = await pop.innerText();
  if (dashRe.test(text)) fail(w, where, "popover copy has a dash");
  if (!text.includes(`Step ${i} of ${N}`)) fail(w, where, "no step counter");
  if (!text.includes(s.title)) fail(w, where, "title missing");
  if (s.kind === "action" && !text.includes(s.act)) fail(w, where, "action text missing");
  for (const label of ["Skip the tutorial", "Previous step", i === N ? "Finish the tour" : "Next step"]) if (!(await pop.getByLabel(label).count())) fail(w, where, `no ${label} button`);
  if (i === 1 && !(await pop.getByLabel("Previous step").isDisabled())) fail(w, where, "Back is not disabled on step 1");
  if ((await pop.getAttribute("role")) !== "dialog" || !(await pop.getAttribute("aria-label"))) fail(w, where, "dialog role or label missing");
  const prog = await pop.getByRole("progressbar").getAttribute("aria-valuenow");
  if (Number(prog) !== i) fail(w, where, `progress bar says ${prog}`);
  const focused = await page.evaluate(() => !!document.activeElement?.closest("aside.tour"));
  if (!focused) fail(w, where, "keyboard focus is not in the popover");
  // the target: the one the step names for this width
  const sel = width <= NARROW_PX && s.mobileTarget ? s.mobileTarget : s.target;
  let tgt = page.locator(sel).first();
  if (!(await tgt.count()) && s.done?.kind === "exists") tgt = page.locator(s.done.selector).first();
  if (!(await tgt.count())) { fail(w, where, `target ${sel} does not exist`); return false; }
  if (!(await tgt.isVisible())) fail(w, where, `target ${sel} is not visible`);
  if (!(await tgt.evaluate((e) => e.classList.contains("tour-hl") && e.hasAttribute("data-tour-hl")))) fail(w, where, "target is not highlighted");
  const tb = await boxOf(tgt);
  if (!tb) { fail(w, where, "target has no box"); return false; }
  const clip = { x: Math.max(tb.x, 4), y: Math.max(tb.y, 4), width: Math.min(tb.x + tb.width, vp.width - 4) - Math.max(tb.x, 4), height: Math.min(tb.y + tb.height, vp.height - 4) - Math.max(tb.y, 4) };
  if (clip.width < 8 || clip.height < 8) fail(w, where, `target is mostly off screen: ${JSON.stringify(tb)}`);
  if (overlapArea(pb, clip) > 1) fail(w, where, `popover covers the target (${Math.round(overlapArea(pb, clip))} px2)`);
  const gap = gapBetween(pb, clip);
  if (gap > 48) fail(w, where, `popover is ${Math.round(gap)} px from the target`);
  const clipNow = async () => { const t = await boxOf(tgt); if (!t) return clip; const x = Math.max(t.x, 4), y = Math.max(t.y, 4); return { x, y, width: Math.min(t.x + t.width, vp.width - 4) - x, height: Math.min(t.y + t.height, vp.height - 4) - y }; };
  let cl = clip;
  const surrounds = (b) => b && !(b.x > cl.x + 1.5 || b.y > cl.y + 1.5 || b.x + b.width < cl.x + cl.width - 1.5 || b.y + b.height < cl.y + cl.height - 1.5);
  let sp = await page.locator(".tour-spot").boundingBox().catch(() => null);
  for (let k = 0; k < 15 && !surrounds(sp); k++) {
    await page.waitForTimeout(100);
    cl = await clipNow();
    sp = await page.locator(".tour-spot").boundingBox().catch(() => null);
  }
  if (!sp) fail(w, where, "no spotlight");
  else if (!surrounds(sp)) fail(w, where, `spotlight does not surround the target: ${JSON.stringify(sp)} vs ${JSON.stringify(cl)}`);
  const shows = SHOWS[s.id];
  if (shows && !shows.test((await tgt.innerText()).trim())) fail(w, where, `the highlighted thing does not show ${shows}: "${(await tgt.innerText()).trim().slice(0, 60)}"`);
  const num = String(i).padStart(2, "0");
  mkdirSync(join(SHOTS, String(width)), { recursive: true });
  await page.screenshot({ path: join(SHOTS, String(width), `${num}-${s.id}.png`) });
  return true;
}

/** Click the real target of an action step and check the change and the automatic advance. */
async function doAction(page, i, w, width) {
  const s = TOUR_STEPS[i - 1];
  const where = `${i} ${s.id}`;
  const sel = width <= NARROW_PX && s.mobileTarget ? s.mobileTarget : s.target;
  await page.evaluate(() => { window.__busy = false; const p = document.querySelector(".livepill"); window.__pill = p?.textContent ?? ""; if (p) new MutationObserver(() => { if (p.classList.contains("busy")) window.__busy = true; }).observe(p, { attributes: true, attributeFilter: ["class"] }); });
  await page.locator(sel).first().click({ timeout: 8000 });
  const want = i + 1;
  const t0 = Date.now();
  while ((await stepNow(page)) !== want && Date.now() - t0 < 12000) await sleep(150);
  if ((await stepNow(page)) !== want) { fail(w, where, "the tour did not advance by itself after the click"); return false; }
  const d = s.done;
  if (d.kind === "exists") {
    // the next step may be on another page: the change must at least have been there when the tour moved on, so look again if still on this page
    const nowPath = await page.evaluate(() => location.pathname);
    if (nowPath === new URL(s.path, "http://x").pathname && !(await page.locator(d.selector).count())) fail(w, where, `expected ${d.selector} after the click`);
  } else if (d.kind === "path") {
    const p = await page.evaluate(() => location.pathname);
    if (p !== d.path) fail(w, where, `expected to land on ${d.path}, got ${p}`);
  } else if (d.kind === "reread") {
    const seen = await page.evaluate(() => ({ busy: window.__busy, before: window.__pill, now: document.querySelector(".livepill")?.textContent ?? "" }));
    if (!seen.busy && seen.before === seen.now) fail(w, where, "the live pill did not read again");
  }
  return true;
}

async function walk(browser, width) {
  const w = String(width);
  console.log(`\nwalking ${N} steps at ${width}px from a first visit`);
  const { context, page, errors } = await open(browser, width);
  if (!(await settle(page, 1, w))) { await context.close(); return; }
  if ((await flagNow(page)) !== "started") fail(w, "auto start", `flag after auto start is ${await flagNow(page)}, expected started`);
  for (let i = 1; i <= N; i++) {
    const ok = await checkStep(page, i, w, width);
    process.stdout.write(ok ? "." : "x");
    if (!ok) { // keep going so one broken step does not hide the rest
      await page.goto(BASE + TOUR_STEPS[Math.min(i, N - 1)].path + (TOUR_STEPS[Math.min(i, N - 1)].path.includes("?") ? "&" : "?") + `tour=${Math.min(i + 1, N)}`);
      i = Math.min(i, N - 1);
      continue;
    }
    if (i === 4) { // Back works, and Next works on an action step
      await page.getByLabel("Previous step").click();
      if (!(await settle(page, 3, w)) || (await stepNow(page)) !== 3) fail(w, "back", "Back did not return to step 3");
      await page.getByLabel("Next step").click();
      if (!(await settle(page, 4, w)) || (await stepNow(page)) !== 4) fail(w, "next on an action step", "Next did not move from step 3 to step 4");
    }
    if (i === N) break;
    const s = TOUR_STEPS[i - 1];
    if (s.kind === "action") { if (!(await doAction(page, i, w, width))) { await page.getByLabel("Next step").click().catch(() => {}); } }
    else await page.getByLabel("Next step").click();
  }
  // finish
  if ((await stepNow(page)) === N) {
    await page.getByLabel("Finish the tour").click();
    await sleep(300);
    if (await hasTour(page)) fail(w, "finish", "the tour is still showing after Finish");
    if ((await stepNow(page)) !== 0) fail(w, "finish", "tour param still in the URL");
    if ((await flagNow(page)) !== "dismissed") fail(w, "finish", "dismissed flag not stored");
    await page.reload();
    await sleep(1500);
    if (await hasTour(page)) fail(w, "reload", "the tour came back on reload with the flag set");
  } else fail(w, "finish", `walk ended on step ${await stepNow(page)}, not ${N}`);
  if (errors.length) fail(w, "console", `${errors.length} console errors: ${[...new Set(errors)].slice(0, 3).join(" | ")}`);
  await context.close();
}

async function behaviours(browser, width) {
  const w = String(width);
  console.log(`\nbehaviour checks at ${width}px`);
  const errs = [];
  // Skip ends the tour and stores the flag; a reload and a later visit show nothing
  { const { context, page, errors } = await open(browser, width);
    await settle(page, 1, w);
    await page.getByLabel("Skip the tutorial").click(); await sleep(300);
    if (await hasTour(page)) fail(w, "skip", "tour still showing"); if ((await flagNow(page)) !== "dismissed") fail(w, "skip", "flag not stored");
    if ((await stepNow(page)) !== 0) fail(w, "skip", "tour param left in the URL");
    await page.reload(); await sleep(1500); if (await hasTour(page)) fail(w, "skip", "tour back after reload");
    await page.goto(BASE + "/overview"); await sleep(1500); if (await hasTour(page)) fail(w, "skip", "tour auto started again after a skip");
    // the entry point restarts it even with the flag set
    await page.locator("main").getByRole("link", { name: "Take the tour" }).first().click();
    if (!(await settle(page, 1, w))) fail(w, "entry point", "Take the tour did not start the tour"); else if ((await stepNow(page)) !== 1) fail(w, "entry point", "wrong step");
    errs.push(...errors); await context.close(); }
  // the tour is also offered from the features page and keeps its place on resume
  { const { context, page, errors } = await open(browser, width, { path: "/features", query: "?notour=1" });
    await sleep(800); if (await hasTour(page)) fail(w, "notour", "tour showed with notour=1");
    await page.locator("main").getByRole("link", { name: "Take the tour" }).first().click();
    if (!(await settle(page, 1, w))) fail(w, "features entry point", "did not start"); errs.push(...errors); await context.close(); }
  // Esc skips
  { const { context, page, errors } = await open(browser, width);
    await settle(page, 1, w); await page.keyboard.press("Escape"); await sleep(300);
    if (await hasTour(page)) fail(w, "esc", "tour still showing"); if ((await flagNow(page)) !== "dismissed") fail(w, "esc", "flag not stored");
    errs.push(...errors); await context.close(); }
  // notour and noloader keep it off, and nothing is stored; other app pages never auto start
  for (const [path, query, label] of [["/overview", "?notour=1", "notour"], ["/overview", "?noloader=1", "noloader"], ["/funds", "", "a page that is not the app home"], ["/verify", "", "the verifier"]]) {
    const { context, page, errors } = await open(browser, width, { path, query });
    await sleep(1800);
    if (await hasTour(page)) fail(w, label, "tour started");
    if ((await flagNow(page)) !== null) fail(w, label, `flag stored: ${await flagNow(page)}`);
    errs.push(...errors); await context.close();
  }
  // once only: a plain visit after the tour started (and was left) does not start it again
  { const { context, page, errors } = await open(browser, width);
    await settle(page, 1, w);
    await page.goto(BASE + "/overview"); await sleep(1500); if (await hasTour(page)) fail(w, "once", "auto started a second time");
    errs.push(...errors); await context.close(); }
  // ?tour=N resumes on the right page and step, with no flag needed
  for (const i of [11, 18, 27, 36, 40]) {
    const s = TOUR_STEPS[i - 1];
    const { context, page, errors } = await open(browser, width, { path: s.path + (s.path.includes("?") ? "&" : "?") + `tour=${i}` });
    if (!(await settle(page, i, w))) fail(w, `resume ${i}`, "did not resume");
    errs.push(...errors); await context.close();
  }
  // a bad step number shows nothing
  { const { context, page } = await open(browser, width, { query: `?notour=1&tour=${N + 5}` }); await sleep(1200); if (await hasTour(page)) fail(w, "bad step", "tour showed for a step that does not exist"); await context.close(); }
  if (errs.length) fail(w, "console", `${errs.length} console errors: ${[...new Set(errs)].slice(0, 3).join(" | ")}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
rmSync(SHOTS, { recursive: true, force: true });
try {
  for (const width of WIDTHS) { await walk(browser, width); await behaviours(browser, width); }
} finally {
  await browser.close();
  srv.close();
}
if (fails.length) { console.log(`\ntour check FAILED: ${fails.length} problems`); process.exit(1); }
console.log(`\ntour check passed: ${N} steps at ${WIDTHS.join(" and ")}px, screenshots in ${SHOTS}`);
