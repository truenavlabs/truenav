// Web disclosure and copy checks. Run: npm test (in web/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_V3_FIELDS, publicV3, bandOf } from "../src/public.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const src = join(web, "src");
const fixture = (name) => JSON.parse(readFileSync(join(src, "fixtures", name), "utf8"));

const BANNED_WORD_SHA256 = new Set([
  "99b4c037877eee21438b6b13aa6bcd14e8f3baf77fd185eb3ea11f3a0a405be7",
  "43a52bc7d59d42b4020c698b3eff5e35c5f552b81d59eebde76594953a374bcb",
]);

function files(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

test("allowlist is the same 37 fields as the API guard", () => {
  assert.equal(PUBLIC_V3_FIELDS.length, 37);
  const api = readFileSync(join(web, "..", "api", "receipt.mjs"), "utf8");
  const m = api.match(/const fields=\[([^\]]+)\]/);
  assert.ok(m, "api/receipt.mjs public field list not found");
  const apiFields = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...PUBLIC_V3_FIELDS].sort(), apiFields.sort());
});

test("public view keeps only allowlisted keys and whole-number scores", () => {
  const h = publicV3(fixture("harbor-score.json"));
  const m = publicV3(fixture("meridian-score.json"));
  for (const r of [h, m]) for (const k of Object.keys(r)) assert.ok(PUBLIC_V3_FIELDS.includes(k), k);
  assert.equal(h.score, 99);
  assert.equal(h.band, "green");
  assert.equal(m.score, 43);
  assert.equal(m.band, "red");
  assert.equal("stored_block" in h, false);
  const full = publicV3(fixture("harbor-receipt.json"));
  for (const k of ["fund_account", "commitments", "source_key_ids", "attestation_ref", "input_sha256"]) assert.equal(k in full, false, k);
});

test("publicV3 refuses a non-integer score", () => {
  assert.throws(() => publicV3({ score: 99.17 }));
  assert.throws(() => publicV3({ score: 101 }));
  assert.equal(publicV3({ score: null }).score, null);
});

test("bands: green 85+, yellow 60 to 84, red below 60", () => {
  assert.equal(bandOf(85), "green");
  assert.equal(bandOf(84), "yellow");
  assert.equal(bandOf(60), "yellow");
  assert.equal(bandOf(59), "red");
});

test("source has no raw pins, private score fields, em dashes or banned names", () => {
  const banned = [/99\.17/, /42\.84/, /score_x100/, /raw_score/, /\u2014/, /circuit breaker/i, /\bvault\b/i, /\bgat(e|ed|ing)\b/i];
  for (const f of files(src)) {
    if (f.includes(`${"fixtures"}`)) continue;
    const s = readFileSync(f, "utf8");
    for (const re of banned) assert.equal(re.test(s), false, `${f} matches ${re}`);
    assert.equal(/parts_x100/.test(s), false, `${f} mentions parts_x100`);
    // Names that must never appear, stored as sha256 of the lowercase word so this file does not carry them.
    for (const w of s.toLowerCase().match(/[a-z]+/g) ?? []) {
      const h = createHash("sha256").update(w).digest("hex");
      assert.equal(BANNED_WORD_SHA256.has(h), false, `${f} contains a banned name`);
    }
  }
});

test("every explainer is verbatim", () => {
  const copy = readFileSync(join(src, "copy.ts"), "utf8");
  assert.ok(copy.includes(`"what the fund's loans are worth after expected losses. model estimate, not fair value."`));
  assert.ok(copy.includes(`"where TrueVal likely falls, assuming loans default independently. demo estimate."`));
  assert.ok(copy.includes(`"how far you can trust the fund's reported NAV, 0 to 100."`));
});

test("fonts are local OFL files", () => {
  const fonts = readdirSync(join(web, "public", "fonts"));
  for (const f of ["Manrope-Variable.woff2", "JetBrainsMono-Variable.woff2", "OFL-Manrope.txt", "OFL-JetBrainsMono.txt"]) assert.ok(fonts.includes(f), f);
  const css = readFileSync(join(src, "styles.css"), "utf8");
  assert.match(css, /--font-sans: "Manrope"/);
  assert.match(css, /--font-mono: "JetBrains Mono"/);
  assert.equal(/https?:\/\/fonts\./.test(css), false);
});

// Copy and placeholder hygiene for the public site and judge text.
const repoRoot = join(web, "..");
const tracked = () => spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).stdout.split("\0").filter((f) => f && !f.endsWith("package-lock.json") && !f.endsWith(".pdf") && !f.endsWith(".wasm") && !f.endsWith(".b64") && !f.endsWith(".png") && !f.endsWith(".woff2") && !f.endsWith(".ico"));
const readRepo = (f) => { try { return readFileSync(join(repoRoot, f), "utf8"); } catch { return ""; } };

test("the old sibling project name appears nowhere in the tracked tree", () => {
  const needle = new RegExp(["referral", "relay"].join("[ _-]?"), "i");
  const hits = tracked().filter((f) => needle.test(readRepo(f)) || needle.test(f));
  assert.deepEqual(hits, []);
});

test("About names the other entry by name only, links GitHub Issues, and has no placeholder contact", () => {
  const about = readFileSync(join(src, "site", "About.tsx"), "utf8");
  assert.match(about, /TendAI Custody/);
  assert.doesNotMatch(about, /example\.invalid|\(placeholder\)|href=\{?"#"\}?/);
  assert.match(about, /github\.com\/truenavlabs\/truenav\/issues/);
  const i = about.indexOf("TendAI Custody");
  assert.doesNotMatch(about.slice(i - 200, i + 200), /<a\b/, "TendAI Custody is a name only, no link");
});

test("no visible copy says pending approval, not in this commit, or waits for a public repository", () => {
  const checked = [...files(src), join(web, "data", "verify.mjs"), join(web, "data", "pledge-sim.mjs")].filter((f) => /\.(tsx?|mjs|json)$/.test(f));
  for (const f of checked) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, /pending approval/i, f);
    assert.doesNotMatch(t, /not in this commit/i, f);
    assert.doesNotMatch(t, /once the repository is public/i, f);
  }
  assert.doesNotMatch(readRepo("judge/stages.mjs"), /not in this commit/i);
  assert.doesNotMatch(readRepo("web/data/recorded/judge-replay.json"), /not in this commit/i);
});

test("the Technology page does not show a stale test count or a pending TEE verdict row", () => {
  const t = readFileSync(join(src, "site", "Technology.tsx"), "utf8");
  assert.doesNotMatch(t, /pending \/ not run/);
  assert.doesNotMatch(t, /n: "413"/);
});

test("the recorded judge replay is self-consistent: its evidence_hash is the sha256 of its canonical hashed part", async () => {
  const { canonical } = await import("../../judge/lib.mjs");
  const rec = JSON.parse(readRepo("web/data/recorded/judge-replay.json"));
  const { ephemeral, evidence_hash, ...hashed } = rec;
  assert.equal(createHash("sha256").update(canonical(hashed)).digest("hex"), evidence_hash);
});

test("UPGRADE_V3 states the real status: v3 pinned and CI built, not deployed, live receipts is v2", () => {
  const t = readRepo("UPGRADE_V3.md");
  const head = t.split("\n").slice(0, 6).join("\n");
  assert.doesNotMatch(head, /local candidate only/i);
  assert.match(head, /not deployed/i);
  assert.match(head, /live v2/i);
  assert.match(head, /5f294c9a/);
  assert.match(head, /f32949b3/);
});
