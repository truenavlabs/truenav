// Web disclosure and copy checks. Run: npm test (in web/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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
