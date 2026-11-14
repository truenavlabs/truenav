// A05: the Attestation page may say the registry signer is the key in the report only when the report's own
// signing address equals the registry signer. A matching report hash alone is not enough. Offline, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bindingResult, reportSigningAddress } from "../src/lib/attestation-binding.mjs";

const root = new URL("../../", import.meta.url);
const B64 = readFileSync(new URL("tee/fixtures/attestation-report-368aa2.json.b64", root), "utf8");
const BYTES = Uint8Array.from(Buffer.from(B64.replace(/\s+/g, ""), "base64"));
const SHA = createHash("sha256").update(BYTES).digest("hex");
const SIGNER = "0x2665cce942fa427ef30d87f4b0bff67fb7645462";
const OTHER = "0x6994c1391f4244185497aa2afa8e14f5790314b0";
const SUCCESS_TEXT = /match: .*(key|signer)/i;

test("A05: the report's model signing address is read from the committed report", () => {
  assert.equal(reportSigningAddress(BYTES), SIGNER);
});

test("A05: unreadable or empty report bytes give no address, never a throw", () => {
  assert.equal(reportSigningAddress(new Uint8Array([1, 2, 3])), null);
  assert.equal(reportSigningAddress(new Uint8Array()), null);
});

test("A05 guard: hash match and the report names the registry signer is a success", () => {
  const r = bindingResult({ computedSha: SHA, storedSha: SHA, registryAddress: SIGNER, reportAddress: reportSigningAddress(BYTES) });
  assert.equal(r.state, "match");
  assert.match(r.text, SUCCESS_TEXT);
  assert.match(r.text, /0x2665/);
});

test("A05 guard: address case differences do not matter", () => {
  const r = bindingResult({ computedSha: SHA, storedSha: SHA, registryAddress: SIGNER.toUpperCase().replace("0X", "0x"), reportAddress: SIGNER });
  assert.equal(r.state, "match");
});

test("A05: report hash matches but the registry signer address is swapped, so there is no success text", () => {
  const r = bindingResult({ computedSha: SHA, storedSha: SHA, registryAddress: OTHER, reportAddress: reportSigningAddress(BYTES) });
  assert.notEqual(r.state, "match");
  assert.doesNotMatch(r.text, SUCCESS_TEXT);
  assert.match(r.text, /differs|not the|does not/i);
});

test("A05: report hash matches but the report has no readable signing address, so there is no success text", () => {
  const r = bindingResult({ computedSha: SHA, storedSha: SHA, registryAddress: SIGNER, reportAddress: null });
  assert.notEqual(r.state, "match");
  assert.doesNotMatch(r.text, SUCCESS_TEXT);
});

test("A05: no registry signer at all is not a success", () => {
  const r = bindingResult({ computedSha: SHA, storedSha: SHA, registryAddress: undefined, reportAddress: SIGNER });
  assert.notEqual(r.state, "match");
});

test("A05: a different report hash is a mismatch even when the addresses agree", () => {
  const r = bindingResult({ computedSha: "00".repeat(32), storedSha: SHA, registryAddress: SIGNER, reportAddress: SIGNER });
  assert.equal(r.state, "no-match");
  assert.doesNotMatch(r.text, SUCCESS_TEXT);
});

test("A05: the page gets its result text from bindingResult and no longer prints a hash-only success sentence", () => {
  const src = readFileSync(new URL("web/src/pages/features/Attestation.tsx", root), "utf8");
  assert.match(src, /attestation-binding/);
  assert.match(src, /bindingResult\(/);
  assert.doesNotMatch(src, /is the key attested in this report/);
  assert.doesNotMatch(src, /st\.sha === onChain\?\.attestation_sha256 \?/);
});

test("A05: the copy has no em or en dash", () => {
  const src = readFileSync(new URL("web/src/lib/attestation-binding.mjs", root), "utf8");
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});
