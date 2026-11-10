// Regression for the sandbox e2e failure "Do not know how to serialize a BigInt": certify/testnet.mjs passed the
// fund's near-api-js Account as pledge_loan fund_account. The first call published the Account (signer key
// included) and the second threw once its nonce cache held a BigInt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { plainCallArgs, pledgeArgs } from "./call-args.mjs";

const base = { contractId: "registry.x.testnet", loanHash: "a".repeat(64), assetType: "real_estate", nonce: "b".repeat(64), expiryMs: 1_800_000_000_000, secretKey: new Uint8Array(32).fill(9) };
const throwaway = () => new Account("harbor.x.testnet", new JsonRpcProvider({ url: "http://127.0.0.1:9" }), KeyPair.fromRandom("ed25519").toString());

test("pledge args are plain JSON with the fund account id string", () => {
  const a = pledgeArgs({ ...base, fundAccountId: "harbor.x.testnet" });
  assert.equal(a.fund_account, "harbor.x.testnet");
  assert.equal(typeof a.expiry_ms, "number");
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test("pledge args refuse an Account object as the fund account", () => {
  assert.throws(() => pledgeArgs({ ...base, fundAccountId: throwaway() }), /account id string/);
});

test("call args refuse BigInt and non-plain objects before JSON.stringify", () => {
  const acc = throwaway();
  assert.throws(() => plainCallArgs({ fund_account: acc }), /args\.fund_account is a Account object/);
  acc.nonceManager.nonces.k = 1n;
  assert.throws(() => plainCallArgs({ fund_account: acc }), /not plain JSON/);
  assert.throws(() => plainCallArgs({ amount: 1n }), /args\.amount is a BigInt/);
  assert.throws(() => plainCallArgs({ list: [{ deep: 2n }] }), /args\.list\[0\]\.deep is a BigInt/);
  assert.throws(() => plainCallArgs({ bytes: new Uint8Array(1) }), /Uint8Array/);
  assert.throws(() => plainCallArgs({ n: NaN }), /finite/);
  const ok = { s: "1", n: 2, b: true, z: null, u: undefined, arr: ["x"], o: Object.create(null) };
  assert.equal(plainCallArgs(ok), ok);
});

test("testnet.mjs checks every call's args and pledges with account id strings", () => {
  const src = readFileSync(new URL("./testnet.mjs", import.meta.url), "utf8");
  assert.match(src, /functionCall\(methodName, plainCallArgs\(args\)/);
  for (const m of src.matchAll(/pledgeArgs\(([^,]+),/g)) assert.match(m[1], /^(FUND_ACCOUNT\[l\.fund_id\]|ids\.\w+|fundAccountId)$/, `pledgeArgs(${m[1]}, ...)`);
});
