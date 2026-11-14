// A04: the Verify page must not show overall green unless the certificate-signatures row is live.
// Offline: the chain is a fake built from the committed evidence; certificate transactions come from a stubbed fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runWebChecks, webSummary } from "../verify.mjs";
import { CHAIN_CHECK_IDS, chainReader, codeHashFromSha256 } from "../../verifier/index.mjs";
import { loadEvidence } from "../../verifier/evidence.mjs";
import { sha256Hex } from "../../verifier/eip191.mjs";

const root = new URL("../../../", import.meta.url);
const readText = async (p) => readFileSync(new URL(p, root), "utf8");
const json = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const REG = json("web/data/recorded/registry-368aa2.json");
const ACCEPTED = json("web/data/recorded/tx-cert-accepted.json");
const NOW = Date.parse("2026-11-20T00:00:00Z");

/** A chain that answers like the live registry, from the committed evidence. */

/** Happy-path fakes answer with the pinned v3 receipts deployment so registry tests are not failed by the receipts checks. */
function attachPinnedReceipts(chain) {
  const root = new URL("../../../", import.meta.url);
  const pin = JSON.parse(readFileSync(new URL("receipts/pinned-builds.json", root), "utf8")).receipts;
  const engine = JSON.parse(readFileSync(new URL("receipts/v3-build.json", root), "utf8")).engine.sha256;
  const account = "receipts.tnlab-718ca9.testnet";
  const cfg = { outlayer: "outlayer.testnet", project_id: `${account}/truenav-engine`, version_key: engine, method: "truenav-v3.0.1", secrets_profile: "engine", secrets_owner: account, max_instructions: 10000000000, max_memory_mb: 128, max_execution_seconds: 30, outlayer_deposit: "10000000000000000000000", storage_deposit: "350000000000000000000000", outlayer_tgas: 200, callback_tgas: 80 };
  return {
    ...chain,
    receipts: account,
    receiptsCodeHash: async () => codeHashFromSha256(pin),
    receiptsView: async (m) => {
      if (m === "get_config") return { admin: "tnlab-718ca9.testnet", pauser: "tnlab-718ca9.testnet", paused: false, next_request: 1, config: cfg };
      if (m === "list_tokens") return [];
      if (m === "get_latest_receipt" || m === "get_latest") return null;
      throw new Error(`no view ${m}`);
    },
  };
}

function fakeChain(ev) {
  const firstByLoan = new Map();
  for (const r of ev.verdicts.results) if (!r.tampered && !firstByLoan.has(r.loan_hash)) firstByLoan.set(r.loan_hash, r);
  const stored = (r) => ({ verdict: r.verdict.verdict, anomalies: r.verdict.anomalies, signer: r.onchain.signer, model_id: r.onchain.model_id, request_sha256: r.onchain.request_sha256, response_sha256: sha256Hex(r.onchain.response_body), attestation_sha256: ev.status.report_sha256, expires_at_ms: ev.verdicts.expires_at_ms, submitted_by: "servicer.x.testnet", at_ms: 1 });
  const views = {
    get_roles: () => ({ ...ev.liveRegistry.roles }),
    get_tee_signers: () => [{ address: ev.status.tee_signer, model_id: ev.status.model, attestation_ref: "x", attestation_sha256: ev.status.report_sha256, registered_at_ms: 1 }],
    get_signers: () => [...ev.liveRegistry.certificate_signers],
    get_servicer_pledge_key: () => ev.liveRegistry.servicer_pledge_address,
    get_latest_verdict: ({ loan_hash }) => (firstByLoan.has(loan_hash) ? stored(firstByLoan.get(loan_hash)) : null),
    get_lock: ({ loan_hash }) => (firstByLoan.has(loan_hash) ? { fund_id: firstByLoan.get(loan_hash).fund_id, locked_at_ms: 0 } : null),
    get_latest_certificate: ({ fund_id }) => REG.funds.find((f) => f.fund_id === fund_id).certificate,
  };
  return attachPinnedReceipts(chainReader({
    contract: ev.status.registry,
    url: "fake",
    view: async (_c, m, a) => { if (!views[m]) throw new Error(`no view ${m}`); return views[m](a); },
    codeHash: async () => ev.liveRegistry.code_hash,
  }));
}

/** Stub globalThis.fetch for the certificate transaction reads. mode: "ok" answers from the recorded txs, a number is an HTTP status. */
async function withTxFetch(mode, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    if (typeof mode === "number") return { ok: false, status: mode, json: async () => ({}) };
    const { method, params } = JSON.parse(init.body);
    const result = method === "tx" ? ACCEPTED.txs[params.tx_hash] : { header: { height: 1, timestamp_nanosec: String(NOW * 1e6) } };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", result }) };
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const evidence = async () => structuredClone(await loadEvidence(readText));
const live = (id) => ({ id, state: "live", detail: "ok" });
const allChainLive = () => CHAIN_CHECK_IDS.map(live);
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test("A04 summary: all chain checks live and the certificate signature row live is green", () => {
  const s = webSummary([...allChainLive(), live("certificate-signatures")]);
  assert.equal(s.runnableGreen, true);
});

test("A04 summary: all chain checks live but the certificate signature row missing is not green", () => {
  assert.equal(webSummary(allChainLive()).runnableGreen, false);
});

test("A04 summary: certificate signature row unchecked (transactions unreadable) is not green", () => {
  const s = webSummary([...allChainLive(), { id: "certificate-signatures", state: "unchecked", detail: "could not read the transactions: HTTP 503. Not checked." }]);
  assert.equal(s.runnableGreen, false);
});

test("A04 summary: certificate signature row failed is not green", () => {
  const s = webSummary([...allChainLive(), { id: "certificate-signatures", state: "fail", detail: "signature recovers to another key" }]);
  assert.equal(s.runnableGreen, false);
});

test("A04 end to end: happy path with readable certificate transactions is green", async () => {
  const ev = await evidence();
  const r = await withTxFetch("ok", () => runWebChecks({ evidence: ev, chain: fakeChain(ev), now: NOW }));
  const c = byId(r.checks);
  assert.equal(c["certificate-signatures"].state, "live", c["certificate-signatures"].detail);
  assert.equal(r.summary.counts.fail, 0, JSON.stringify(r.checks.filter((x) => x.state === "fail")));
  assert.equal(r.summary.runnableGreen, true);
});

test("A04 end to end: certificate transaction reads fail with HTTP 503, so overall green is false", async () => {
  const ev = await evidence();
  const r = await withTxFetch(503, () => runWebChecks({ evidence: ev, chain: fakeChain(ev), now: NOW }));
  const c = byId(r.checks);
  for (const id of CHAIN_CHECK_IDS) assert.equal(c[id].state, "live", `${id}: ${c[id].detail}`);
  assert.notEqual(c["certificate-signatures"].state, "live");
  assert.equal(r.summary.runnableGreen, false);
});

test("A04 end to end: a corrupted certificate signature fails and overall green is false", async () => {
  const ev = await evidence();
  const r = await withTxFetch("ok", () => runWebChecks({ evidence: ev, chain: fakeChain(ev), now: NOW, tamper: "cert" }));
  assert.equal(byId(r.checks)["certificate-signatures"].state, "fail");
  assert.equal(r.summary.runnableGreen, false);
});
