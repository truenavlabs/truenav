// NEW-02: buyer proof accepts only a FullAccess key or a FunctionCall key scoped to the query contract.
// An unrelated FunctionCall key (for example a dapp session key that leaked) must not spend the entitlement.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { createServer, queryHash, spendMessage } from "../server.mjs";
import { initSpendStore } from "../spend-store.mjs";
import { canonical } from "../receipt.mjs";

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const v3 = JSON.parse(readFileSync(new URL("../../schema/vectors/engine-v3-derived.json", import.meta.url))).vectors[0].envelope;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rec = (() => {
  const body = canonical(v3);
  const digest = sha(body);
  return { token_id: v3.token_id, seq: Number(v3.seq), method: v3.method_version, version_key: v3.engine_version_key, score: v3.score, band: v3.band, caps: v3.caps, holds: v3.holds, period: `${v3.period_start}/${v3.period_end}`, as_of: v3.valuation_time, receipt_sha256: digest, public_sha256: digest, receipt: body, block_height: 100 };
})();
const QUERY = "query.test";
const BUYER = "buyer.testnet";
const ID = "buyer-key-0001";
const EXP = "60000";

const fa = (public_key) => ({ public_key, access_key: { nonce: 1, permission: "FullAccess" } });
const fc = (public_key, receiver_id, method_names = ["buy_query"]) => ({
  public_key,
  access_key: { nonce: 1, permission: { FunctionCall: { receiver_id, method_names, allowance: "1" } } },
});

function proof(key, id = ID, token = rec.token_id) {
  const nonce = randomBytes(16).toString("hex");
  const sig = Buffer.from(key.sign(spendMessage({ audience: QUERY, id, kind: "report", token, nonce, exp: EXP })).signature).toString("base64");
  return { "x-truenav-entitlement": id, "x-truenav-buyer": BUYER, "x-truenav-buyer-sig": sig, "x-truenav-buyer-nonce": nonce, "x-truenav-buyer-exp": EXP };
}

async function spend(keys, signer, { id = ID } = {}) {
  const ents = new Map();
  ents.set(id, { request_id: id, buyer: BUYER, kind: "report", query_hash: queryHash("report", rec.token_id), expires_ns: "999999999999999999999", uses_left: 1 });
  let redeemCalls = 0;
  const chain = {
    async view(_c, m, a) {
      if (m === "get_latest") return rec;
      if (m === "get_entitlement") return ents.get(a.request_id) ? { ...ents.get(a.request_id) } : null;
      return null;
    },
    async accessKeys(account) { return account === BUYER ? keys : []; },
    async nowNs() { return 0n; },
    async redeem(rid, qh) {
      redeemCalls += 1;
      const e = ents.get(rid);
      if (!e || e.query_hash !== qh || e.uses_left < 1) throw new Error("entitlement already used");
      e.uses_left -= 1;
      return e.uses_left;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "truenav-new02-"));
  temps.push(dir);
  const spendStore = await initSpendStore(dir, { create: true });
  const server = createServer({ chain, receipts: "receipts.test", query: QUERY, fee: "1", spendStore });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/fund/${rec.token_id}/report`, { headers: proof(signer, id) });
    const body = await res.json();
    return { status: res.status, body, redeemCalls };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("NEW-02 an unrelated FunctionCall key cannot spend the buyer's entitlement", async () => {
  const owner = KeyPair.fromRandom("ed25519");
  const leaked = KeyPair.fromRandom("ed25519");
  const out = await spend(
    [fa(owner.getPublicKey().toString()), fc(leaked.getPublicKey().toString(), "other.dapp.test", ["mint"])],
    leaked,
  );
  assert.equal(out.status, 403, `unrelated FunctionCall key was accepted (${out.status}): ${JSON.stringify(out.body)}`);
  assert.equal(out.body.error, "buyer proof does not match the entitlement");
  assert.equal(out.redeemCalls, 0, "redeem ran for a key that is not FullAccess and is not scoped to the query contract");
});

test("NEW-02 a FullAccess key can spend the buyer's entitlement", async () => {
  const owner = KeyPair.fromRandom("ed25519");
  const leftover = KeyPair.fromRandom("ed25519");
  const out = await spend(
    [fa(owner.getPublicKey().toString()), fc(leftover.getPublicKey().toString(), "other.dapp.test", ["mint"])],
    owner,
    { id: "buyer-key-0002" },
  );
  assert.equal(out.status, 200, `FullAccess proof was refused (${out.status}): ${JSON.stringify(out.body)}`);
  assert.equal(out.redeemCalls, 1);
});

test("NEW-02 an unknown permission shape cannot spend the buyer's entitlement", async () => {
  const key = KeyPair.fromRandom("ed25519");
  const pub = key.getPublicKey().toString();
  const shapes = [
    { public_key: pub },
    { public_key: pub, access_key: { nonce: 1, permission: "PartialAccess" } },
    { public_key: pub, access_key: { nonce: 1, permission: { Delegate: {} } } },
    { public_key: pub, access_key: { nonce: 1, permission: { FunctionCall: { receiver_id: QUERY, method_names: [] }, Extra: true } } },
  ];
  for (const [i, k] of shapes.entries()) {
    const out = await spend([k], key, { id: `buyer-key-unk-${i}` });
    assert.equal(out.status, 403, `unknown permission shape ${i} was accepted (${out.status}): ${JSON.stringify(out.body)}`);
    assert.equal(out.body.error, "buyer proof does not match the entitlement");
    assert.equal(out.redeemCalls, 0);
  }
});

test("NEW-02 a FunctionCall key scoped to the query contract can spend the buyer's entitlement", async () => {
  const scoped = KeyPair.fromRandom("ed25519");
  const out = await spend([fc(scoped.getPublicKey().toString(), QUERY, ["buy_query"])], scoped, { id: "buyer-key-0003" });
  assert.equal(out.status, 200, `query-scoped FunctionCall proof was refused (${out.status}): ${JSON.stringify(out.body)}`);
  assert.equal(out.redeemCalls, 1);
});
