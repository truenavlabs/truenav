// Paid report check (F2): the agent's paid report must be the chain receipt it already verified. A report server that copies the
// legitimate outer receipt_sha256 and seq but alters the report body is refused, and out.report is built from the
// verified chain envelope. Honest path: the agent against the real API handler. Fake chain, local HTTP only, no network,
// no transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
import { runAgent, newRequestId, verifyRecord } from "../../agent/agent.mjs";
import { createServer, queryHash } from "../../api/server.mjs";
import { initSpendStore } from "../../api/spend-store.mjs";
import { canonical, publicV3 } from "../../api/receipt.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const NOW_NS = 5_000_000_000n;
const FEE = 10n ** 22n;
const envelope = JSON.parse(readFileSync(new URL("../../schema/vectors/engine-v3-derived.json", import.meta.url))).vectors[0].envelope;
const fx = JSON.parse(readFileSync(new URL("../../receipts/tests/fixtures/engine-receipts.json", import.meta.url), "utf8")).receipts;

// get_latest for a v3 receipt as the contract stores it: canonical public body, wrapper hash = sha256(body)
function v3Stored() {
  const receipt = canonical(envelope);
  const digest = sha(receipt);
  return { token_id: envelope.token_id, seq: Number(envelope.seq), request_id: 1, method: envelope.method_version, version_key: envelope.engine_version_key, score: envelope.score, band: envelope.band, period: `${envelope.period_start}/${envelope.period_end}`, as_of: envelope.valuation_time, caps: envelope.caps, holds: envelope.holds, receipt_sha256: digest, public_sha256: digest, receipt, requested_ns: 1, stored_ns: 2, block_height: 100 };
}
function v2Stored(key) {
  const receipt = fx[key].output;
  const r = JSON.parse(receipt);
  return { token_id: r.token_id, seq: 1, request_id: 1, method: r.method, version_key: "ab".repeat(32), score: r.score, band: r.band, period: r.period, as_of: r.as_of, caps: r.caps.map((c) => c.code), holds: r.holds.map((h) => h.code), receipt_sha256: sha(receipt), receipt, requested_ns: 1, stored_ns: 2, block_height: 100 };
}

// One fake chain shared by the agent (view, buyQuery, signSpend) and the API (view, redeem, accessKeys, nowNs).
function world(head) {
  const key = KeyPair.fromRandom("ed25519");
  const ents = new Map();
  const calls = { bought: 0, redeem: 0 };
  const chain = {
    async view(_c, method, args) {
      if (method === "get_latest") return head;
      if (method === "get_token") return { token: { token_id: args.token_id }, pending: null, last_failure: null };
      if (method === "get_config") return { fee: FEE.toString(), paused: false };
      if (method === "get_entitlement") return ents.get(args.request_id) || null;
      throw new Error(`unexpected view ${method}`);
    },
    async buyQuery({ requestId, queryHash: qh, kind, deposit }) {
      calls.bought += 1;
      const e = { request_id: requestId, buyer: "agent.test", kind, query_hash: qh, paid: deposit.toString(), created_ns: "1", expires_ns: String(NOW_NS + 10n ** 12n), uses_left: 1 };
      ents.set(requestId, e);
      return { ...e, tx_hash: "TX" };
    },
    async signSpend(message) { return Buffer.from(key.sign(message).signature).toString("base64"); },
    async nowMs() { return Number(NOW_NS / 1_000_000n); },
    async nowNs() { return NOW_NS; },
    async accessKeys() { return [{ public_key: key.getPublicKey().toString() }]; },
    async redeem(id) { calls.redeem += 1; const e = ents.get(id); e.uses_left -= 1; return e.uses_left; },
  };
  return { chain, calls };
}
async function withApi(head, edit, fn) {
  const { chain, calls } = world(head);
  const spendDir = mkdtempSync(join(tmpdir(), "truenav-fix14-f2-"));
  const spendStore = await initSpendStore(spendDir, { create: true });
  const server = createServer({ chain, receipts: "receipts.test", query: "query.test", fee: FEE.toString(), spendStore });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  // a man in the middle (or a faulty report server): the real API answer, then edited
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    const body = await res.json();
    const edited = edit ? edit(structuredClone(body)) : body;
    return { status: res.status, json: async () => edited };
  };
  try {
    const token = head.token_id;
    const run = () => runAgent({ chain, token, receipts: "receipts.test", query: "query.test", requestId: newRequestId(token, "0".repeat(12)), nowMs: Date.parse(head.as_of), execute: true, apiUrl });
    await fn({ run, calls });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
    rmSync(spendDir, { recursive: true, force: true });
  }
}

test("fix14 F2 honest v3: the agent accepts the real API report and builds it from the verified chain envelope", async () => {
  const head = v3Stored();
  assert.equal(verifyRecord(head.token_id, head), null);
  await withApi(head, null, async ({ run, calls }) => {
    const out = await run();
    assert.equal(calls.bought, 1);
    assert.equal(calls.redeem, 1);
    const expected = { status: 200, ...publicV3(JSON.parse(head.receipt)), receipt_sha256: head.receipt_sha256, attestation: "unattested" };
    assert.equal(canonical(out.report), canonical(expected));
    assert.equal(out.report.token_id, envelope.token_id);
    assert.equal(out.report.score, envelope.score);
  });
});

test("fix14 F2 a v3 report with copied outer hash and seq but altered content is refused", async () => {
  const head = v3Stored();
  const edits = {
    token: (r) => { r.token_id = "wrong-fund"; },
    score: (r) => { r.score = 1; r.band = "red"; },
    token_and_score: (r) => { r.token_id = "wrong-fund"; r.score = 1; },
    trueval: (r) => { r.trueval = "999"; },
    caps: (r) => { r.caps = ["invented_cap"]; },
    dropped_field: (r) => { delete r.holds; },
    extra_field: (r) => { r.note = "injected"; },
    attested_claim: (r) => { r.attestation = "attested"; },
    inner_hash: (r) => { r.receipt_sha256 = "00".repeat(32); },
    seq: (r) => { r.seq = "999"; },
  };
  for (const [name, f] of Object.entries(edits)) {
    await withApi(head, (body) => {
      // the outer identifiers stay the legitimate chain values
      assert.equal(body.receipt_sha256, head.receipt_sha256);
      assert.equal(body.seq, head.seq);
      f(body.receipt);
      return body;
    }, async ({ run }) => {
      await assert.rejects(run, /report_mismatch/, name);
    });
  }
});

test("fix14 F2 v3 private-field guard still applies before anything is returned", async () => {
  const head = v3Stored();
  await withApi(head, (body) => { body.receipt.metrics = { outstanding_cents: 1 }; return body; }, async ({ run }) => {
    await assert.rejects(run, /private_field/);
  });
});

test("fix14 F2 v2: altered score, band, caps or holds with copied outer hash and seq is refused; honest is accepted", async () => {
  const head = v2Stored("HONEST-CREDIT");
  await withApi(head, null, async ({ run }) => {
    const out = await run();
    assert.equal(out.report.score, head.score);
    assert.equal(out.report.band, head.band);
  });
  for (const f of [(r) => { r.score = 1; }, (r) => { r.band = "red"; }, (r) => { r.caps = ["invented_cap"]; }, (r) => { r.holds = ["invented_hold"]; }, (r) => { r.token_id = "OTHER-FUND"; }]) {
    await withApi(head, (body) => {
      assert.ok(body && body.receipt, `expected a report receipt to edit, got ${JSON.stringify(body)}`);
      f(body.receipt);
      return body;
    }, async ({ run }) => {
      await assert.rejects(run, /report_mismatch/);
    });
  }
});
