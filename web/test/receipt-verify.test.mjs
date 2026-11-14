// Read-only receipt verify panel: query parsing, empty contract, field and hash checks,
// attestation consistency, tx events. Views and RPC are mocks. No live RPC, no signing, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RECEIPTS_CONTRACT, REGISTRY_CONTRACT } from "../src/lib/near.mjs";
import { RPC_TIMEOUT_MS } from "../chain.mjs";
import {
  BASE58_HASH,
  EMPTY_DETAIL,
  HEX64,
  MAX_QUERY_CHARS,
  PROOF_REF_PREFIX,
  PROOF_SCHEME,
  asDec,
  boundedEvents,
  compareWrapperAndBody,
  extractTx,
  isHex64,
  normalizeStored,
  parseQuery,
  sameDec,
  sha256Hex,
  verifyReceipt,
} from "../src/lib/receipt-verify.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const HASH = "6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm";
const VERSION = "ab".repeat(32);

function bodyOf({ seq = "1", requestId = "1", prev = null, fundId = "harbor-credit-fund", extra = {} } = {}) {
  return {
    receipt_version: "3",
    method_version: "truenav-v3.0.1",
    network: "near_testnet",
    receipts_contract: RECEIPTS_CONTRACT,
    engine_version_key: VERSION,
    token_id: "DEMO-CREDIT",
    fund_id: fundId,
    fund_account: "harbor.tnlab-368aa2.testnet",
    period_start: "2026-10-01",
    period_end: "2026-10-31",
    seq,
    prev_receipt_sha256: prev,
    request_id: requestId,
    score: 87,
    band: "green",
    as_of: "2026-11-13T00:00:00.000Z",
    valuation_time: "2026-11-13T00:00:00.000Z",
    receipt_sha256: "cd".repeat(32),
    caps: [],
    holds: [],
    attestation_ref: null,
    ...extra,
  };
}

function storedRow(body, { requestId = 1, wrapperSha } = {}) {
  const raw = JSON.stringify(body);
  return {
    token_id: body.token_id,
    seq: Number(body.seq),
    request_id: Number(requestId),
    method: "truenav-v3.0.1",
    version_key: VERSION,
    score: body.score,
    band: body.band,
    period: `${body.period_start}/${body.period_end}`,
    as_of: body.valuation_time,
    caps: body.caps || [],
    holds: body.holds || [],
    receipt_sha256: wrapperSha || sha(raw),
    receipt: raw,
    requested_ns: 1,
    stored_ns: 2,
    block_height: 100,
  };
}

const BODY_1 = bodyOf();
const ROW_1 = storedRow(BODY_1, { requestId: 1 });
const BODY_2 = bodyOf({ seq: "2", requestId: "2", prev: BODY_1.receipt_sha256, extra: { score: 80 } });
const ROW_2 = storedRow(BODY_2, { requestId: 2 });

const EMPTY_CONFIG = {
  admin: "tnlab-718ca9.testnet",
  pauser: "tnlab-718ca9.testnet",
  paused: false,
  config: { method: "truenav-v3.0.1", version_key: VERSION },
  next_request: 1,
};
const LIVE_CONFIG = { ...EMPTY_CONFIG, next_request: 3 };

function views({ config = LIVE_CONFIG, rows = [ROW_1, ROW_2], tokens, pending = {}, failures = {}, bindings = {}, attestations = {}, funds = { "harbor-credit-fund": { fund_id: "harbor-credit-fund", account_id: "harbor.tnlab-368aa2.testnet" } } } = {}) {
  const list = tokens || [{ token_id: "DEMO-CREDIT", kind: "credit", receipts: rows.length, registered_ns: 1 }];
  const bySeq = new Map(rows.map((r) => [`${r.token_id}:${r.seq}`, r]));
  const calls = [];
  const viewReceipts = async (method, args = {}) => {
    calls.push({ contract: "receipts", method, args });
    if (method === "get_config") return config;
    if (method === "list_tokens") return list;
    if (method === "get_token") {
      const id = args.token_id;
      const t = list.find((x) => x.token_id === id);
      if (!t) return null;
      return { token: t, pending: pending[id] || null, last_failure: failures[id] || null };
    }
    if (method === "get_history") {
      const id = args.token_id;
      const from = Number(args.from_seq);
      const limit = Number(args.limit || 10);
      return rows
        .filter((r) => r.token_id === id && r.seq <= from)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit);
    }
    if (method === "get_latest") {
      const ours = rows.filter((r) => r.token_id === args.token_id);
      return ours.length ? ours.reduce((a, b) => (a.seq > b.seq ? a : b)) : null;
    }
    if (method === "get_receipt") {
      return bySeq.get(`${args.token_id}:${args.seq}`) || null;
    }
    if (method === "get_body_binding") {
      return bindings[`${args.token_id}:${args.seq}`] ?? null;
    }
    if (method === "get_attestations") {
      return attestations[`${args.token_id}:${args.seq}`] ?? [];
    }
    throw new Error(`unexpected receipts view ${method}`);
  };
  const viewRegistry = async (method, args = {}) => {
    calls.push({ contract: "registry", method, args });
    if (method === "get_fund") return funds[args.fund_id] ?? null;
    throw new Error(`unexpected registry view ${method}`);
  };
  return { viewReceipts, viewRegistry, calls };
}

function eventLog(event, data) {
  return `EVENT_JSON:${JSON.stringify({ standard: "truenav-receipts", version: "1.0.0", event, data: [data] })}`;
}

function txResult({ events = [], failure = null, receiverId = RECEIPTS_CONTRACT, hash = HASH } = {}) {
  return {
    status: failure ? { Failure: failure } : { SuccessValue: "" },
    transaction: { hash, signer_id: "runner.tnlab-718ca9.testnet", receiver_id: receiverId },
    transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [] } },
    receipts_outcome: [
      { outcome: { logs: events, executor_id: receiverId } },
    ],
  };
}

test("parseQuery accepts a request id, token:seq, token/seq, and a base58 hash with optional signer", () => {
  assert.deepEqual(parseQuery(""), { kind: "none" });
  assert.deepEqual(parseQuery("   "), { kind: "none" });
  assert.deepEqual(parseQuery("1"), { kind: "request_id", requestId: "1" });
  assert.deepEqual(parseQuery("42"), { kind: "request_id", requestId: "42" });
  assert.deepEqual(parseQuery("DEMO-CREDIT:2"), { kind: "receipt", tokenId: "DEMO-CREDIT", seq: "2" });
  assert.deepEqual(parseQuery("DEMO-CREDIT/2"), { kind: "receipt", tokenId: "DEMO-CREDIT", seq: "2" });
  assert.deepEqual(parseQuery("DEMO-CREDIT 2"), { kind: "receipt", tokenId: "DEMO-CREDIT", seq: "2" });
  assert.deepEqual(parseQuery(HASH), { kind: "tx", hash: HASH, signerId: null });
  assert.deepEqual(parseQuery(`${HASH}@runner.tnlab-718ca9.testnet`), { kind: "tx", hash: HASH, signerId: "runner.tnlab-718ca9.testnet" });
  assert.deepEqual(parseQuery(`${HASH} runner.tnlab-718ca9.testnet`), { kind: "tx", hash: HASH, signerId: "runner.tnlab-718ca9.testnet" });
  assert.equal(BASE58_HASH.test(HASH), true);
});

test("parseQuery refuses oversized input, control characters, id 0, and junk", () => {
  assert.equal(parseQuery("0").kind, "invalid");
  assert.equal(parseQuery("x".repeat(MAX_QUERY_CHARS + 1)).kind, "invalid");
  assert.equal(parseQuery("1\n2").kind, "invalid");
  assert.equal(parseQuery("not a query").kind, "invalid");
  assert.equal(parseQuery("DEMO-CREDIT:").kind, "invalid");
  assert.equal(parseQuery("bad id:1").kind, "invalid");
  assert.equal(parseQuery(1).kind, "invalid");
});

test("sha256Hex matches node crypto and isHex64 / asDec helpers are strict", async () => {
  assert.equal(await sha256Hex("abc"), sha("abc"));
  assert.equal(isHex64(VERSION), true);
  assert.equal(isHex64("AB".repeat(32)), false);
  assert.equal(isHex64("ab".repeat(31)), false);
  assert.equal(asDec("01"), null);
  assert.equal(asDec("0"), "0");
  assert.equal(asDec(2), "2");
  assert.equal(sameDec("2", 2), true);
  assert.equal(sameDec("2", "02"), false);
  assert.equal(HEX64.test(ROW_1.receipt_sha256), true);
});

test("an empty contract (next_request 1) is an honest empty state, including for a request id or token:seq", async () => {
  const v = views({ config: EMPTY_CONFIG, rows: [], tokens: [] });
  const none = await verifyReceipt({ query: "", ...v });
  assert.equal(none.kind, "empty");
  assert.equal(none.nextRequest, "1");
  assert.equal(none.detail, EMPTY_DETAIL);
  assert.equal(none.checks.some((c) => c.id === "empty" && c.state === "unchecked"), true);
  assert.equal(none.summary.counts.fail, 0);

  const byId = await verifyReceipt({ query: "1", ...v });
  assert.equal(byId.kind, "empty");
  assert.match(byId.detail, /next_request is 1/);

  const bySeq = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v });
  assert.equal(bySeq.kind, "empty");

  // list_tokens / get_history must not be called when the contract has issued no requests.
  assert.equal(v.calls.every((c) => c.method === "get_config"), true);
});

// Plan B state: next_request is 3 (two timed out runs used ids 1 and 2) but nothing is stored.
const PLAN_B_TOKENS = ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"].map((token_id) => ({ token_id, kind: "credit", receipts: 0 }));

test("no stored receipt with next_request above 1 is an honest empty state, not a parse error", async () => {
  const v = views({ config: LIVE_CONFIG, rows: [], tokens: PLAN_B_TOKENS });
  const r = await verifyReceipt({ query: "", ...v });
  assert.equal(r.kind, "empty");
  assert.equal(r.summary.counts.fail, 0, JSON.stringify(r.checks.filter((c) => c.state === "fail")));
  assert.match(r.detail, /no live receipt is stored yet/i);
  assert.match(r.detail, /v2/);
  assert.doesNotMatch(r.detail, /could not be parsed/);
  assert.equal(r.checks.some((c) => c.id === "empty" && c.state === "unchecked"), true);
  assert.equal(r.checks.some((c) => c.id === "lookup"), false);
});

test("stored receipts with an empty query show the latest stored receipt, and a broken stored row still fails", async () => {
  const ok = await verifyReceipt({ query: "", ...views({ rows: [ROW_1, ROW_2] }) });
  assert.equal(ok.kind, "checked");
  assert.equal(ok.receipt.seq, "2");
  const bad = { ...ROW_2, receipt_sha256: "00".repeat(32) };
  const r = await verifyReceipt({ query: "", ...views({ rows: [ROW_1, bad] }) });
  assert.equal(r.kind, "checked");
  assert.equal(r.checks.some((c) => c.state === "fail"), true);
  assert.equal(r.summary.ok, false);
});

test("a tx hash on an empty contract still looks up the tx and keeps the empty state", async () => {
  const v = views({ config: EMPTY_CONFIG, rows: [], tokens: [] });
  const rpc = async () => txResult({ events: [eventLog("run_requested", { token_id: "DEMO-CREDIT", request_id: 1 })] });
  const r = await verifyReceipt({ query: HASH, ...v, rpc });
  assert.equal(r.kind, "empty");
  assert.equal(r.tx.hash, HASH);
  assert.equal(r.checks.some((c) => c.id === "empty"), true);
  assert.equal(r.checks.some((c) => c.id === "tx-status" && c.state === "live"), true);
});

test("verifyReceipt finds a receipt by token:seq and by request id", async () => {
  const v = views();
  const a = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v });
  assert.equal(a.kind, "checked");
  assert.equal(a.receipt.tokenId, "DEMO-CREDIT");
  assert.equal(a.receipt.seq, "1");
  assert.equal(a.receipt.requestId, "1");
  const fields = a.checks.find((c) => c.id === "fields");
  assert.equal(fields.state, "live");
  const hash = a.checks.find((c) => c.id === "wrapper-hash");
  assert.equal(hash.state, "live");
  assert.match(hash.detail, new RegExp(ROW_1.receipt_sha256));

  const b = await verifyReceipt({ query: "2", ...v });
  assert.equal(b.kind, "checked");
  assert.equal(b.receipt.seq, "2");
  assert.equal(b.receipt.requestId, "2");
  const prev = b.checks.find((c) => c.id === "prev-hash");
  assert.equal(prev.state, "live", prev && prev.detail);
});

test("wrapper hash fails when the stored string is tampered, and prev hash fails when the link is wrong", async () => {
  const bad = { ...ROW_1, receipt: ROW_1.receipt.replace("87", "86") };
  const v1 = views({ rows: [bad] });
  const r1 = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v1 });
  assert.equal(r1.checks.find((c) => c.id === "wrapper-hash").state, "fail");

  const wrongPrev = storedRow(bodyOf({ seq: "2", requestId: "2", prev: "ee".repeat(32), extra: { score: 80 } }), { requestId: 2 });
  const v2 = views({ rows: [ROW_1, wrongPrev] });
  const r2 = await verifyReceipt({ query: "DEMO-CREDIT:2", ...v2 });
  assert.equal(r2.checks.find((c) => c.id === "prev-hash").state, "fail");
});

test("seq 1 with an empty prev hash passes, and a v3 chain must not link to the previous wrapper hash", async () => {
  const v = views({ rows: [ROW_1] });
  const r = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v });
  assert.equal(r.checks.find((c) => c.id === "prev-hash").state, "live");

  const linkedToWrapper = storedRow(bodyOf({ seq: "2", requestId: "2", prev: ROW_1.receipt_sha256, extra: { score: 80 } }), { requestId: 2 });
  const v2 = views({ rows: [ROW_1, linkedToWrapper] });
  const r2 = await verifyReceipt({ query: "DEMO-CREDIT:2", ...v2 });
  assert.equal(r2.checks.find((c) => c.id === "prev-hash").state, "fail");
  assert.match(r2.checks.find((c) => c.id === "prev-hash").detail, /wrapper hash/);
});

test("wrapper receipt_sha256 and envelope receipt_sha256 are different roles and are not required to match", () => {
  const norm = normalizeStored(ROW_1);
  assert.ok(norm.wrapperSha);
  assert.equal(norm.body.receipt_sha256, "cd".repeat(32));
  assert.notEqual(norm.wrapperSha, norm.body.receipt_sha256);
  const cmp = compareWrapperAndBody(norm);
  assert.equal(cmp.bad.join(), "");
  assert.ok(cmp.compared.includes("token_id"));
  assert.ok(cmp.compared.includes("seq"));
  assert.ok(cmp.compared.includes("request_id"));
});

test("a missing receipt, an unissued request, a pending run and a last failure are distinct, honest states", async () => {
  const v = views({
    // request_run increments next_request when the request is issued, including a still-pending run.
    config: { ...LIVE_CONFIG, next_request: 5 },
    pending: { "DEMO-CREDIT": { request_id: 3, token_id: "DEMO-CREDIT" } },
    failures: { "OTHER": { request_id: 4, code: "outlayer_run_failed" } },
    tokens: [
      { token_id: "DEMO-CREDIT", kind: "credit", receipts: 2, registered_ns: 1 },
      { token_id: "OTHER", kind: "credit", receipts: 0, registered_ns: 1 },
    ],
  });
  const missing = await verifyReceipt({ query: "DEMO-CREDIT:9", ...v });
  assert.equal(missing.kind, "missing");
  assert.equal(missing.checks.find((c) => c.id === "lookup").state, "fail");

  const unissued = await verifyReceipt({ query: "9", ...v });
  assert.equal(unissued.kind, "not_issued");
  assert.match(unissued.detail, /has not been issued/);

  const pending = await verifyReceipt({ query: "3", ...v });
  assert.equal(pending.kind, "pending");
  assert.match(pending.detail, /pending/);

  const fail = await verifyReceipt({ query: "4", ...v });
  assert.equal(fail.kind, "failure");
  assert.match(fail.detail, /outlayer_run_failed/);
});

test("attestation binding and records are checked when present, and labeled unchecked when absent", async () => {
  const v0 = views();
  const none = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v0 });
  assert.equal(none.checks.find((c) => c.id === "attestation-binding").state, "unchecked");
  assert.match(none.checks.find((c) => c.id === "attestation-binding").detail, /No body binding/);

  const binding = {
    token_id: "DEMO-CREDIT",
    seq: "1",
    receipt_sha256: BODY_1.receipt_sha256,
    body_sha256: "11".repeat(32),
  };
  const rec = {
    token_id: "DEMO-CREDIT",
    seq: "1",
    receipt_sha256: BODY_1.receipt_sha256,
    body_sha256: "11".repeat(32),
    proof_ref: `${PROOF_REF_PREFIX}99`,
    proof_scheme: PROOF_SCHEME,
    attester: "attester.testnet",
  };
  const v1 = views({ bindings: { "DEMO-CREDIT:1": binding }, attestations: { "DEMO-CREDIT:1": [rec] } });
  const ok = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v1 });
  assert.equal(ok.checks.find((c) => c.id === "attestation-binding").state, "live");
  assert.equal(ok.checks.find((c) => c.id === "attestation-records").state, "live");
  const quote = ok.checks.find((c) => c.id === "attestation-quote");
  assert.equal(quote.state, "unchecked");
  assert.match(quote.detail, /not fetched or verified/);

  const bad = { ...rec, proof_ref: "https://evil.example/attest/1" };
  const v2 = views({ bindings: { "DEMO-CREDIT:1": binding }, attestations: { "DEMO-CREDIT:1": [bad] } });
  const no = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v2 });
  assert.equal(no.checks.find((c) => c.id === "attestation-records").state, "fail");
});

test("registry fund, receipts contract id and network are checked; a missing fund is unchecked, not a fail", async () => {
  const v = views();
  const r = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v });
  assert.equal(r.checks.find((c) => c.id === "registry-fund").state, "live");
  assert.equal(r.checks.find((c) => c.id === "receipts-contract").state, "live");
  assert.equal(r.checks.find((c) => c.id === "network").state, "live");

  const other = storedRow(bodyOf({ fundId: "unknown-fund" }));
  const v2 = views({ rows: [other], funds: {} });
  const r2 = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v2 });
  assert.equal(r2.checks.find((c) => c.id === "registry-fund").state, "unchecked");
});

test("a tx hash re-reads the stored receipt and matches receipt_stored events on the wrapper hash", async () => {
  const v = views();
  const rpc = async (method, params) => {
    assert.equal(method, "tx");
    assert.equal(params.tx_hash, HASH);
    assert.equal(params.wait_until, "NONE");
    return txResult({
      events: [
        eventLog("run_requested", { token_id: "DEMO-CREDIT", request_id: 1, version_key: VERSION, method: "truenav-v3.0.1" }),
        eventLog("receipt_stored", { receipt_version: "3", token_id: "DEMO-CREDIT", seq: "1", receipt_sha256: ROW_1.receipt_sha256, public_sha256: ROW_1.receipt_sha256 }),
      ],
    });
  };
  const r = await verifyReceipt({ query: HASH, ...v, rpc });
  assert.equal(r.kind, "checked");
  assert.equal(r.receipt.seq, "1");
  assert.equal(r.tx.hash, HASH);
  assert.equal(r.checks.find((c) => c.id === "tx-status").state, "live");
  assert.equal(r.checks.find((c) => c.id === "tx-receiver").state, "live");
  assert.equal(r.checks.find((c) => c.id === "tx-events").state, "live");
  assert.equal(r.explorerUrl, `https://testnet.nearblocks.io/txns/${HASH}`);
});

test("a tx whose receipt_stored hash does not match the stored receipt fails the event check", async () => {
  const v = views();
  const rpc = async () => txResult({
    events: [eventLog("receipt_stored", { token_id: "DEMO-CREDIT", seq: "1", receipt_sha256: "ff".repeat(32) })],
  });
  const r = await verifyReceipt({ query: HASH, ...v, rpc });
  assert.equal(r.kind, "checked");
  assert.equal(r.checks.find((c) => c.id === "tx-events").state, "fail");
});

test("bounded event parsing caps outcomes and logs, and extractTx drops proofs", () => {
  const result = {
    status: { SuccessValue: "" },
    transaction: { hash: HASH, signer_id: "runner.tnlab-718ca9.testnet", receiver_id: RECEIPTS_CONTRACT },
    transaction_outcome: { id: HASH, proof: ["keep-me-out"] },
    receipts_outcome: Array.from({ length: 40 }, (_, i) => ({
      outcome: { logs: Array.from({ length: 40 }, (__, j) => eventLog("noise", { i, j })) },
      proof: ["x"],
    })),
  };
  const events = boundedEvents(result);
  assert.ok(events.length <= 40);
  const tx = extractTx(result);
  assert.equal(tx.hash, HASH);
  assert.equal(tx.receiverId, RECEIPTS_CONTRACT);
  assert.equal("proof" in tx, false);
});

test("not-checkable rows are always present: TEE execution, private fields, sealed envelope hash", async () => {
  const v = views();
  const r = await verifyReceipt({ query: "DEMO-CREDIT:1", ...v });
  for (const id of ["tee-execution", "private-fields", "envelope-hash"]) {
    const c = r.checks.find((x) => x.id === id);
    assert.ok(c, id);
    assert.equal(c.state, "unchecked", id);
  }
  assert.equal(RPC_TIMEOUT_MS, 8000);
  assert.equal(REGISTRY_CONTRACT, "registry.tnlab-368aa2.testnet");
});

test("verifyReceipt never signs, never sends, and does not call views other than the receipts and registry mocks", async () => {
  const v = views();
  const r = await verifyReceipt({ query: "1", ...v });
  assert.equal(r.kind, "checked");
  assert.equal(v.calls.every((c) => c.contract === "receipts" || c.contract === "registry"), true);
  const text = JSON.stringify(v.calls);
  assert.equal(/sign|secret|private_key|request_run|set_runner/i.test(text), false);
  assert.equal(v.calls.some((c) => c.contract === "registry" && c.method === "get_fund"), true);
});

test("a failed get_config is a visible error, not a thrown exception", async () => {
  const viewReceipts = async () => {
    throw new Error("RPC query timed out after 8000 ms");
  };
  const r = await verifyReceipt({ query: "1", viewReceipts });
  assert.equal(r.kind, "error");
  assert.match(r.detail, /timed out after 8000 ms/);
  assert.equal(r.checks[0].state, "fail");
});
