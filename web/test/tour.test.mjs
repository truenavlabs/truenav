// The guided product tour: the step list covers every app page and feature, the copy follows the site rules, and the
// start, resume and skip behaviours are pure functions with fixed answers. The browser walk is scripts/tour-check.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { TOUR_STEPS, TOUR_KEY, parseTour, tourHref, tourStart, shouldAutoStart, pathnameOf } from "../src/shell/tour-steps.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const BANNED = new Set([
  "13c945dce632469cd1dbb3123299ac26e77c7d55985527504bf51b0668ff75d6", "43a52bc7d59d42b4020c698b3eff5e35c5f552b81d59eebde76594953a374bcb",
  "eaa56c180e05434c65e31c7d654cb4f462a6ae281aa16ef107747f984d1be52d", "99b4c037877eee21438b6b13aa6bcd14e8f3baf77fd185eb3ea11f3a0a405be7",
  "91548a28c0bebc117bd1bb62b942de3ff9df08f15b889c423fb648dec9a03a44", "eeca278742526b4b0cfbb2ab830bb88c740d48f02e18bae0755a149e9c8479bb",
  "96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a",
]);
const copyOf = (s) => [s.title, s.body, s.act ?? "", s.link?.label ?? ""].join(" ");

test("the tour has a long, unique, well formed step list that ends on the features index", () => {
  assert.ok(TOUR_STEPS.length >= 30, `only ${TOUR_STEPS.length} steps`);
  assert.equal(new Set(TOUR_STEPS.map((s) => s.id)).size, TOUR_STEPS.length, "step ids repeat");
  for (const s of TOUR_STEPS) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(s.path.startsWith("/"), s.id);
    assert.ok(s.target.length > 0, `${s.id} has no target`);
    assert.ok(s.title.length >= 8 && s.title.length <= 48, `${s.id} title length`);
  }
  assert.equal(pathnameOf(TOUR_STEPS.at(-1).path), "/features");
  assert.equal(TOUR_STEPS[0].path, "/overview");
});

test("action steps say exactly what to click and how the tour knows it worked; info steps do neither", () => {
  const actions = TOUR_STEPS.filter((s) => s.kind === "action");
  assert.ok(actions.length >= 14, `only ${actions.length} action steps`);
  for (const s of TOUR_STEPS) {
    if (s.kind === "action") {
      assert.match(s.act ?? "", /^Click /, `${s.id}: act must start with Click`);
      assert.ok(s.done && ["path", "exists", "reread"].includes(s.done.kind), `${s.id}: done kind`);
      if (s.done.kind === "path") assert.ok(s.done.path.startsWith("/"), s.id);
      if (s.done.kind === "exists") assert.ok(s.done.selector, s.id);
    } else {
      assert.equal(s.kind, "info");
      assert.equal(s.act, undefined, `${s.id}: info step has an act`);
      assert.equal(s.done, undefined, `${s.id}: info step has a done check`);
    }
  }
});

test("every sidebar page and every feature page is on the tour", () => {
  const paths = new Set(TOUR_STEPS.map((s) => pathnameOf(s.path)));
  const nav = [...read("src/shell/AppShell.tsx").matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(nav.length >= 20);
  for (const h of nav) assert.ok(paths.has(h), `sidebar page ${h} is not on the tour`);
  const feats = [...read("src/pages/features/Index.tsx").matchAll(/\["F\d+", "([a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(feats.length, 11);
  for (const f of feats) assert.ok(paths.has(`/features/${f}`), `feature ${f} is not on the tour`);
  for (const p of ["/funds/meridian-yield-fund", "/loans", "/reports/meridian-yield-fund"]) assert.ok(paths.has(p), p);
  assert.ok([...paths].some((p) => /^\/loans\/[0-9a-f]{64}$/.test(p)), "no loan page");
});

test("the story keeps its order: live read, NAV range, fund tabs, refusal, recompute, signature, privacy, verifier, report, methodology", () => {
  const at = (re) => { const i = TOUR_STEPS.findIndex((s) => re.test(s.id)); assert.ok(i >= 0, String(re)); return i; };
  const order = [/^live-read/, /^nav-range/, /^fund-tabs|^tab-loans/, /^refused/, /^recompute/, /^signature/, /^privacy/, /^tamper/, /^report/, /^methodology/, /^roadmap/];
  const idx = order.map(at);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "story order broken");
});

test("copy: 1 to 3 short plain sentences, no dashes, no raw scores, no gate, no file names, no names, no overclaims", () => {
  for (const s of TOUR_STEPS) {
    const t = copyOf(s);
    assert.doesNotMatch(t, /[\u2013\u2014]/, `${s.id} has a dash`);
    assert.doesNotMatch(t, /\bgat(e|ed|es|ing)\b/i, `${s.id} says gate`);
    assert.doesNotMatch(t, /\d+\.\d+/, `${s.id} has a decimal number`);
    assert.doesNotMatch(t, /\b[\w-]+\.(mjs|json|tsx?|md|rs|toml|b64|txt)\b/i, `${s.id} shows a repo file name`);
    assert.doesNotMatch(t, /\bintents\b/i, `${s.id} mentions intents`);
    assert.doesNotMatch(t, /\bguarantee|trustless|zero.knowledge|fully verified|production|mainnet ready/i, `${s.id} overclaims`);
    assert.doesNotMatch(t, /\bvault\b|circuit breaker/i, s.id);
    for (const w of new Set(t.toLowerCase().match(/[a-z]+/g) ?? [])) assert.equal(BANNED.has(createHash("sha256").update(w).digest("hex")), false, `${s.id} has a banned name`);
    const sentences = s.body.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length >= 1 && sentences.length <= 3, `${s.id} has ${sentences.length} sentences`);
    assert.ok(s.body.length <= 330, `${s.id} body is ${s.body.length} chars`);
    if (s.kind === "action") assert.ok(s.act.length <= 90, `${s.id} act is long`);
    // chain signatures and receipts v3 are design or not deployed, never live
    for (const sent of s.body.split(/(?<=[.!?])\s+/)) if (/chain signatures|receipts v3|\bv3\b|base mirror|mirror/i.test(sent)) assert.match(sent, /not (live|deployed)|design|not run|not built/i, `${s.id}: "${sent}"`);
  }
});

test("demo and testnet are labelled where funds, keys or markets appear", () => {
  const all = TOUR_STEPS.map(copyOf).join(" ");
  assert.match(all, /testnet/i);
  assert.match(all, /fictional|demo/i);
  const certs = TOUR_STEPS.find((s) => s.id === "feature-certificates");
  assert.match(certs.body, /test key/i, "certificates must say the signer is a test key");
  const roadmap = TOUR_STEPS.find((s) => s.id === "roadmap");
  assert.match(roadmap.body, /none of it is live|not live/i);
  const mirror = TOUR_STEPS.find((s) => s.id === "feature-receipts-mirror");
  assert.match(mirror.body, /not deployed/i);
});

test("tourHref and parseTour round trip the step in the URL", () => {
  assert.equal(parseTour("/overview?tour=3"), 3);
  assert.equal(parseTour("/funds/x?tab=loans&tour=12"), 12);
  assert.equal(parseTour("/overview"), 0);
  assert.equal(parseTour("/overview?tour=0"), 0);
  assert.equal(parseTour("/overview?tour=abc"), 0);
  assert.equal(parseTour(`/overview?tour=${TOUR_STEPS.length + 1}`), 0);
  assert.equal(tourHref("/overview", 1), "/overview?tour=1");
  assert.equal(tourHref("/funds/x?tab=loans", 9), "/funds/x?tab=loans&tour=9");
  assert.equal(tourHref("/funds/x?tab=loans&tour=4", 9), "/funds/x?tab=loans&tour=9");
  assert.equal(tourStart(), "/overview?tour=1");
  for (let n = 1; n <= TOUR_STEPS.length; n++) assert.equal(parseTour(tourHref(TOUR_STEPS[n - 1].path, n)), n);
});

test("auto start: once, on the app home only, never with notour or noloader or a stored flag or a tour param", () => {
  const ok = { pathname: "/overview", search: "", stored: null };
  assert.equal(shouldAutoStart(ok), true);
  assert.equal(shouldAutoStart({ ...ok, pathname: "/app" }), true);
  assert.equal(shouldAutoStart({ ...ok, search: "?notour=1" }), false);
  assert.equal(shouldAutoStart({ ...ok, search: "?noloader=1" }), false);
  assert.equal(shouldAutoStart({ ...ok, search: "?tour=2" }), false);
  assert.equal(shouldAutoStart({ ...ok, stored: "dismissed" }), false);
  assert.equal(shouldAutoStart({ ...ok, stored: "started" }), false);
  assert.equal(shouldAutoStart({ ...ok, pathname: "/funds" }), false);
  assert.equal(shouldAutoStart({ ...ok, pathname: "/verify" }), false);
  assert.equal(shouldAutoStart({ ...ok, pathname: "/" }), false);
  assert.equal(TOUR_KEY, "truenav.tour");
});

test("every action target and done selector is a plain selector the page can match", () => {
  for (const s of TOUR_STEPS) {
    for (const sel of [s.target, s.mobileTarget, s.done?.selector].filter(Boolean)) assert.doesNotMatch(sel, /[{};]|<|>$/, `${s.id}: ${sel}`);
  }
});
