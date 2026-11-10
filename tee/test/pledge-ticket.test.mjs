// The ticket key in this file is a LOCAL TEST KEY standing in for a TEE pledge key. It is not a TEE key.
import test from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { networkOf, pledgeMessage, PLEDGE_DOMAIN } from "../pledge-ticket.mjs";
import { addressOf, signEip191 } from "../../certify/certificate.mjs";

const LOCAL_TEST_KEY = new Uint8Array(32).fill(11);

test("pledge ticket text matches the contract tuple and a local test key recovers", () => {
  const contract = "registry.test.near";
  const loan = "11".repeat(32);
  const nonce = "ab".repeat(32);
  const message = pledgeMessage(contract, networkOf(contract), loan, "harbor.testnet", "real_estate", nonce, 1000);
  assert.equal(networkOf(contract), "mainnet");
  assert.equal(message, `${PLEDGE_DOMAIN}|registry.test.near|mainnet|${loan}|harbor.testnet|real_estate|${nonce}|1000`);
  const signature = signEip191(message, LOCAL_TEST_KEY);
  assert.match(signature, /^0x[0-9a-f]{130}$/);
  assert.equal(addressOf(LOCAL_TEST_KEY), addressOf(LOCAL_TEST_KEY));
  assert.equal(secp256k1.getPublicKey(LOCAL_TEST_KEY, false)[0], 4);
});
