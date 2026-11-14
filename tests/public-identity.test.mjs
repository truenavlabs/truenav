// Public identity check: no tracked file names a private reference, a personal handle or a real person.
// The words are stored only as sha256 hashes so this file does not itself publish them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const BANNED = new Set([
  "13c945dce632469cd1dbb3123299ac26e77c7d55985527504bf51b0668ff75d6",
  "43a52bc7d59d42b4020c698b3eff5e35c5f552b81d59eebde76594953a374bcb",
  "eaa56c180e05434c65e31c7d654cb4f462a6ae281aa16ef107747f984d1be52d",
  "99b4c037877eee21438b6b13aa6bcd14e8f3baf77fd185eb3ea11f3a0a405be7",
  "91548a28c0bebc117bd1bb62b942de3ff9df08f15b889c423fb648dec9a03a44",
  "eeca278742526b4b0cfbb2ab830bb88c740d48f02e18bae0755a149e9c8479bb",
  "96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a",
]);
const sha = (w) => createHash("sha256").update(w).digest("hex");
// Pinned method specs and vectors: their bytes are built into the pinned receipts wasm and its reproducible
// build check, so their version labels cannot change without breaking the pin. Only these files are exempt.
const PINNED = new Set([
  "schema/methods/truenav-v3.0.0-rc3.json",
  "schema/methods/truenav-v3.0.1.json",
  "schema/vectors/disclosure-bounds.json",
  "schema/vectors/disclosure-policy.json",
]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|wasm|woff2?|ttf|otf|gz|zip)$/i;

test("no tracked file contains a banned public identity word", () => {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => f && !BINARY.test(f) && !PINNED.has(f));
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const w of new Set(text.toLowerCase().split(/[^a-z0-9]+/))) if (w && BANNED.has(sha(w))) hits.push(f);
  }
  assert.deepEqual([...new Set(hits)], [], "files with a banned identity word");
});
