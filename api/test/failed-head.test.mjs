// Fix 13 (N3, N4): /report on a failed head is 409 run_failed and never redeems, even with a valid entitlement and
// buyer proof; and the spend store refuses a symlinked .flock-probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { createServer, queryHash, spendMessage } from "../server.mjs";
import { initSpendStore, probeFlock } from "../spend-store.mjs";
import { failedHead } from "../../agent/test/failed-head-fixture.mjs";

const NOW = 5_000_000_000n;
const EXP = "60000";
const buyerKey = KeyPair.fromRandom("ed25519");

async function withFailedHead(head, fn) {
  const spendStore = await initSpendStore(mkdtempSync(join(tmpdir(), "truenav-failed-head-")), { create: true });
  const ents = new Map();
  const calls = { redeem: 0, entitlement: 0 };
  const chain = {
    async view(_contract, method, args) {
      if (method === "get_latest") return head;
      if (method === "get_entitlement") { calls.entitlement += 1; return ents.get(args.request_id) || null; }
      throw new Error(`unexpected view ${method}`);
    },
    async nowNs() { return NOW; },
    async accessKeys() { return [{ public_key: buyerKey.getPublicKey().toString() }]; },
    async redeem(id) { calls.redeem += 1; const e = ents.get(id); e.uses_left -= 1; return e.uses_left; },
  };
  const server = createServer({ chain, receipts: "receipts.test", query: "query.test", fee: "10000000000000000000000", spendStore });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn({ url: `http://127.0.0.1:${server.address().port}`, ents, calls, spendStore });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("fix13 /report on a failed head is 409 run_failed and does not redeem a valid entitlement", async () => {
  for (const v3 of [true, false]) {
    const token = "DEMO-CREDIT";
    await withFailedHead(failedHead(token, { v3 }), async ({ url, ents, calls, spendStore }) => {
      const id = `failed-head-${v3 ? "v3" : "v2"}-0001`;
      ents.set(id, { request_id: id, buyer: "agent.test", kind: "report", query_hash: queryHash("report", token), paid: "10000000000000000000000", created_ns: "1", expires_ns: String(NOW + 1000n), uses_left: 1 });
      const nonce = randomBytes(16).toString("hex");
      const sig = Buffer.from(buyerKey.sign(spendMessage({ audience: "query.test", id, kind: "report", token, nonce, exp: EXP })).signature).toString("base64");
      const headers = { "x-truenav-entitlement": id, "x-truenav-buyer": "agent.test", "x-truenav-buyer-sig": sig, "x-truenav-buyer-nonce": nonce, "x-truenav-buyer-exp": EXP };
      for (const path of ["score", "report"]) {
        const r = await fetch(`${url}/fund/${token}/${path}`, { headers });
        assert.equal(r.status, 409, `v3=${v3} ${path}`);
        assert.deepEqual(await r.json(), { error: "run_failed" });
      }
      assert.equal(calls.redeem, 0, "no redeem on a failed head");
      assert.equal(calls.entitlement, 0, "the entitlement is not even read");
      assert.equal(ents.get(id).uses_left, 1);
      assert.equal(existsSync(join(spendStore, "LOCK")), false, "no spend nonce reserved");
    });
  }
});

test("fix13 probeFlock refuses a symlinked .flock-probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "truenav-flock-probe-"));
  symlinkSync("/tmp/truenav-missing-flock-target", join(dir, ".flock-probe"));
  // Refused before flock runs. Today the inner "is a symlink" error is rewrapped by the catch, so the message reads
  // "flock probe path: spend_store_closed"; the check pins the refusal, not that wording.
  assert.throws(() => probeFlock(dir), /flock probe path/);
  assert.equal(existsSync("/tmp/truenav-missing-flock-target"), false, "the symlink target was not created");
});
