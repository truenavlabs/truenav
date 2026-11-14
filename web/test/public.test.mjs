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
  const near = about.slice(Math.max(0, i - 200), i + 200);
  assert.ok(!/<a\b/.test(near) || /href="https:\/\/tendaicustody\.app"/.test(near), "the only link allowed beside TendAI Custody is its own site");
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

test("WHY_NEAR does not overclaim reproducible builds, stays under 300 words and keeps its doc links", () => {
  const t = readRepo("WHY_NEAR.md");
  assert.doesNotMatch(t, /anyone (can )?match the deployed code hash/i);
  assert.match(t, /receipts and query/i);
  assert.match(t, /registry/i);
  assert.match(t, /host build/i);
  assert.ok(t.split(/\s+/).filter(Boolean).length < 300);
  assert.match(t, /docs\.near\.org\/smart-contracts\/anatomy\/reproducible-builds/);
});

test("the README first screen states the platform, the audit scope and no exact test counts", () => {
  const t = readRepo("README.md");
  assert.match(t, /Linux or WSL/);
  assert.match(t, /flock/);
  assert.match(t, /npm audit --omit=dev/);
  assert.match(t, /development/i);
  assert.doesNotMatch(t, /ℹ tests \d+|ℹ pass \d+|tests 819|pass 814|skipped 5\b/);
  assert.doesNotMatch(t, /Attestation verified:/);
  assert.ok(t.split("\n").length < 260, "the README stays short; deep detail lives in docs/");
});

test("docs that were moved out of the README exist and the README links each one", () => {
  const t = readRepo("README.md");
  for (const f of ["docs/TRY_IT.md", "docs/CLAIMS.md", "docs/KNOWN_LIMITS.md", "docs/NETWORK.md", "docs/DEPLOYMENT_EVIDENCE.md"]) {
    assert.ok(readRepo(f).length > 200, f);
    assert.ok(t.includes(f), `README links ${f}`);
  }
});

test("README has the Q-015 other entry section, About names the other entry with no person reference", () => {
  const t = readRepo("README.md");
  assert.ok(t.includes("## Other entry (Q-015 disclosure)\n\nThe same submitter also entered [TendAI Custody](https://tendaicustody.app) in NEAR HACKATHON. The two projects are independent, with separate code, contracts and deployments, and neither depends on the other."));
  assert.doesNotMatch(t, /by the same person/);
  const about = readFileSync(join(src, "site", "About.tsx"), "utf8");
  assert.doesNotMatch(about, /same person/);
  assert.match(about, /TendAI Custody/);
  assert.match(t, /Live app: https:\/\/truenav\.app/);
  assert.doesNotMatch(t, /not live yet|launching after final pass/i);
});

test("the registry storage headroom item is resolved by the 14 Nov top-up everywhere it was open", () => {
  const TX = "7wjnse7nQxVyZLn29RRH4nxQmVGCNfWDBkucnSwC5Eka";
  const trust = readFileSync(join(src, "pages", "Trust.tsx"), "utf8");
  const row = trust.split("\n").find((l) => l.includes("Storage headroom (N-01)"));
  assert.ok(row, "Trust page keeps the storage headroom row");
  assert.match(row, /Resolved/);
  assert.ok(row.includes(TX));
  assert.doesNotMatch(row, /may fail|Open, Low/);
  const limits = readRepo("docs/KNOWN_LIMITS.md").split("\n").find((l) => l.includes("Storage headroom (N-01)"));
  assert.match(limits, /Resolved/);
  assert.ok(limits.includes(TX));
  assert.doesNotMatch(limits, /likely to fail|Open, Low/);
  const readme = readRepo("README.md");
  assert.doesNotMatch(readme, /628 bytes|next write may fail/);
  assert.doesNotMatch(readFileSync(join(src, "content", "faq-data.mjs"), "utf8"), /low registry storage headroom/);
});
