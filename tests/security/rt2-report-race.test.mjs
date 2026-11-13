// RT2-07 (REDTEAM_R2, info, not fixed): /report reads the head once, before the redeem. If a run fails between the
// read and the redeem, the API spends the entitlement and serves the previous good receipt as 200. This test records
// that behaviour; if a re-read after the redeem is added, rewrite the assertions (expect a refusal) rather than delete it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
import { createServer, queryHash, spendMessage } from "../../api/server.mjs";
import { initSpendStore } from "../../api/spend-store.mjs";
import { canonical } from "../../api/receipt.mjs";
import { failedHead } from "../../agent/test/failed-head-fixture.mjs";

const NOW = 5_000_000_000n, EXP = "60000";
const buyerKey = KeyPair.fromRandom("ed25519");
const e = JSON.parse(readFileSync(new URL("../../schema/vectors/engine-v3-derived.json", import.meta.url))).vectors[0].envelope;
const receipt = canonical(e);
const d = createHash("sha256").update(receipt).digest("hex");
const good = { token_id: e.token_id, seq: Number(e.seq), score: e.score ?? 0, band: e.band, caps: e.caps, holds: e.holds, period: `${e.period_start}/${e.period_end}`, as_of: e.valuation_time, method: e.method_version, version_key: e.engine_version_key, receipt_sha256: d, public_sha256: d, receipt, block_height: 1 };

test("RT2-07 a head that fails during the spend still yields a 200 report of the previous receipt", async () => {
  const token = e.token_id;
  let head = good, latestReads = 0;
  const ents = new Map();
  const id = "rt2-race-000001";
  ents.set(id, { request_id: id, buyer: "agent.test", kind: "report", query_hash: queryHash("report", token), paid: "1", created_ns: "1", expires_ns: String(NOW + 1000n), uses_left: 1 });
  const chain = {
    async view(_c, m, a) { if (m === "get_latest") { latestReads += 1; return head; } if (m === "get_entitlement") return ents.get(a.request_id) || null; throw new Error(m); },
    async nowNs() { return NOW; },
    async accessKeys() { return [{ public_key: buyerKey.getPublicKey().toString(), access_key: { nonce: 1, permission: "FullAccess" } }]; },
    async redeem(rid) { head = failedHead(token, { v3: true }); const x = ents.get(rid); x.uses_left -= 1; return x.uses_left; },
  };
  const spendStore = await initSpendStore(mkdtempSync(join(tmpdir(), "rt2-race-")), { create: true });
  const server = createServer({ chain, receipts: "receipts.test", query: "query.test", fee: "1", spendStore });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const nonce = randomBytes(16).toString("hex");
    const sig = Buffer.from(buyerKey.sign(spendMessage({ audience: "query.test", id, kind: "report", token, nonce, exp: EXP })).signature).toString("base64");
    const r = await fetch(`http://127.0.0.1:${server.address().port}/fund/${token}/report`, { headers: { "x-truenav-entitlement": id, "x-truenav-buyer": "agent.test", "x-truenav-buyer-sig": sig, "x-truenav-buyer-nonce": nonce, "x-truenav-buyer-exp": EXP } });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.receipt_sha256, good.receipt_sha256, "served the pre-failure receipt");
    assert.equal(JSON.parse(head.receipt).head_status, "failed", "the chain head is a failed head at serve time");
    assert.equal(latestReads, 1, "the head is not re-read after the redeem");
    assert.equal(ents.get(id).uses_left, 0, "the entitlement was spent");
  } finally { await new Promise((r) => server.close(r)); }
});
