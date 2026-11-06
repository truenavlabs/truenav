// Tests for engine result -> certificate -> EIP-191 signature (certify/certificate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { canonicalMessage, eip191Digest, signCertificate, addressOf, toCertificate } from "./certificate.mjs";

const fixture = JSON.parse(readFileSync(new URL("../contract/tests/fixtures/engine-certificates.json", import.meta.url), "utf8"));
const testKey = new Uint8Array(32).fill(7);

test("canonical message has 17 pipe-joined fields with the contract id second", () => {
  const c = fixture.certificates[0].certificate;
  const m = canonicalMessage("registry.test.near", c);
  const parts = m.split("|");
  assert.equal(parts.length, 17);
  assert.equal(parts[0], "truenav-cert-v1");
  assert.equal(parts[1], "registry.test.near");
  assert.equal(parts[2], "harbor-credit-fund");
});

test("the committed fixture signatures recover to the fixture signer", () => {
  assert.equal(addressOf(testKey), fixture.signer_address);
  for (const { certificate, signature } of fixture.certificates) {
    const sig = Buffer.from(signature.slice(2), "hex");
    const recovered = new Uint8Array(65);
    recovered[0] = sig[64] - 27;
    recovered.set(sig.subarray(0, 64), 1);
    const digest = eip191Digest(canonicalMessage(fixture.contract_id, certificate));
    const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    const point = secp256k1.Point.fromBytes(pub).toBytes(false);
    assert.equal(`0x${Buffer.from(keccak_256(point.slice(1)).slice(12)).toString("hex")}`, fixture.signer_address);
  }
});

test("signing is deterministic and matches the committed fixture", () => {
  for (const { certificate, signature } of fixture.certificates) {
    assert.equal(signCertificate(fixture.contract_id, certificate, testKey), signature);
  }
});

test("money is integer cents, raw is hundredths, no-number statuses carry no score or band", () => {
  const cert = toCertificate(
    { fundId: "f", status: "disclaimed", score: null, band: null, raw: 20.004, trueVal: 12.345, trueRange: 0.1, policyNav: 0, headline: 100, dataAgeHours: 12, penaltyDetail: { attemptsCounted: 2 } },
    { fund_account: "a.near", manager_id: "m" },
    { nowMs: 1_000_000_000, engineCommit: "x" },
  );
  assert.equal(cert.score, null);
  assert.equal(cert.band, "");
  assert.equal(cert.raw_x100, 2000);
  assert.equal(cert.true_val_cents, "1235"); // U128 on the contract: a decimal string in JSON
  assert.equal(cert.headline_cents, "10000");
  assert.equal(cert.blocked_attempts, 2);
  assert.equal(cert.data_asof_ms, 1_000_000_000 - 12 * 3600 * 1000);
});

test("Harbor and Meridian certificates carry the demo pins", () => {
  const byId = Object.fromEntries(fixture.certificates.map((c) => [c.certificate.fund_id, c.certificate]));
  assert.equal(byId["harbor-credit-fund"].raw_x100, 9917);
  assert.equal(byId["harbor-credit-fund"].band, "green");
  assert.equal(byId["meridian-yield-fund"].raw_x100, 4284);
  assert.equal(byId["meridian-yield-fund"].band, "red");
});
