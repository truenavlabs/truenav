// receipts-code and receipts-config: the Verify page must not show overall green unless the
// live receipts contract matches the pinned v3 build and the expected v3 config.
// Offline: the registry is a fake built from committed evidence; receipts answers come from
// the recorded live read (web/data/recorded/receipts-live.json) or a matching fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runWebChecks, webSummary } from "../verify.mjs";
import { CHAIN_CHECK_IDS, chainReader, runVerifierChecks, summarize } from "../../verifier/index.mjs";
import { loadEvidence } from "../../verifier/evidence.mjs";
import { sha256Hex } from "../../verifier/eip191.mjs";

const root = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const json = (p) => JSON.parse(read(p));
const REG = json("web/data/recorded/registry-368aa2.json");
const ACCEPTED = json("web/data/recorded/tx-cert-accepted.json");
const LIVE = json("web/data/recorded/receipts-live.json");
const BUILD = json("receipts/v3-build.json");
const PINNED = json("receipts/pinned-builds.json");
const NOW = Date.parse("2026-11-20T00:00:00Z");

const ACCOUNT = "receipts.tnlab-718ca9.testnet";
const RECEIPTS_PIN = PINNED.receipts;
const ENGINE_PIN = BUILD.engine.sha256;
const STORAGE_V3 = "350000000000000000000000";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = n % 58n;
    n = n / 58n;
    out = B58[Number(r)] + out;
  }
  let pad = 0;
  for (const b of bytes) {
    if (b === 0) pad++;
    else break;
  }
  return `${B58[0].repeat(pad)}${out}`;
}

function codeHashFromHex(hex) {
  const h = String(hex).toLowerCase();
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return base58Encode(bytes);
}

const EXPECTED_CODE_HASH = codeHashFromHex(RECEIPTS_PIN);

const pins = () => ({
  account: ACCOUNT,
  sha256: RECEIPTS_PIN,
  engineSha256: ENGINE_PIN,
  method: "truenav-v3.0.1",
  storage_deposit: STORAGE_V3,
  outlayer_tgas: 200,
  callback_tgas: 80,
  outlayer: "outlayer.testnet",
});

const v3Config = () => ({
  outlayer: "outlayer.testnet",
  project_id: `${ACCOUNT}/truenav-engine`,
  version_key: ENGINE_PIN,
  method: "truenav-v3.0.1",
  secrets_profile: "engine",
  secrets_owner: ACCOUNT,
  max_instructions: 10000000000,
  max_memory_mb: 128,
  max_execution_seconds: 30,
  outlayer_deposit: "10000000000000000000000",
  storage_deposit: STORAGE_V3,
  outlayer_tgas: 200,
  callback_tgas: 80,
});

const matchingReceipts = (over = {}) => ({
  account: ACCOUNT,
  code_hash: EXPECTED_CODE_HASH,
  get_config: { admin: "tnlab-718ca9.testnet", pauser: "tnlab-718ca9.testnet", paused: false, next_request: 1, config: v3Config() },
  list_tokens: [],
  latest: {},
  ...over,
});

function fakeRegistryChain(ev) {
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
  return chainReader({
    contract: ev.status.registry,
    url: "fake",
    view: async (_c, m, a) => { if (!views[m]) throw new Error(`no view ${m}`); return views[m](a); },
    codeHash: async () => ev.liveRegistry.code_hash,
  });
}

function withReceipts(chain, receipts) {
  return {
    ...chain,
    receipts: receipts.account || ACCOUNT,
    receiptsCodeHash: async () => receipts.code_hash,
    receiptsView: async (m, a = {}) => {
      if (m === "get_config") return receipts.get_config;
      if (m === "list_tokens") return receipts.list_tokens || [];
      if (m === "get_latest_receipt" || m === "get_latest") {
        const rows = receipts.latest || {};
        if (a.token_id && Object.prototype.hasOwnProperty.call(rows, a.token_id)) return rows[a.token_id];
        return null;
      }
      throw new Error(`no view ${m}`);
    },
  };
}

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

async function evidence() {
  const ev = structuredClone(await loadEvidence((p) => read(p)));
  ev.receipts = pins();
  ev.paths = { ...ev.paths, receiptsPin: "receipts/pinned-builds.json", receiptsBuild: "receipts/v3-build.json", receiptsLive: "web/data/recorded/receipts-live.json" };
  return ev;
}

const byId = (checks) => Object.fromEntries((checks || []).filter(Boolean).map((c) => [c.id, c]));
const live = (id) => ({ id, state: "live", detail: "ok" });

test("pins and the recorded live read are the expected current deployment", () => {
  assert.equal(RECEIPTS_PIN, BUILD.receipts.sha256);
  assert.equal(RECEIPTS_PIN.slice(0, 8), "5f294c9a");
  assert.equal(ENGINE_PIN.slice(0, 8), "098f5d86");
  assert.equal(LIVE.account, ACCOUNT);
  assert.equal(LIVE.code_sha256.slice(0, 8), "f32949b3");
  assert.equal(LIVE.get_config.config.method, "cashflow-v2.1.0");
  assert.equal(LIVE.get_config.config.version_key.slice(0, 8), "360cd473");
  assert.notEqual(LIVE.code_sha256, RECEIPTS_PIN);
  assert.notEqual(LIVE.get_config.config.version_key, ENGINE_PIN);
  const rehearsal = read("receipts/e2e/v3-rehearsal-l1b.mjs");
  assert.match(rehearsal, /method:'truenav-v3.0.1'/);
  assert.match(rehearsal, /storage_deposit:nearToYocto\('0.35'\)/);
  assert.match(rehearsal, /outlayer_tgas:200,callback_tgas:80/);
});

test("codeHashFromSha256 encodes sha256(wasm) to the NEAR view_account code_hash", async () => {
  const mod = await import("../../verifier/checks.mjs");
  assert.equal(typeof mod.codeHashFromSha256, "function", "checks.mjs must export codeHashFromSha256");
  assert.equal(mod.codeHashFromSha256(LIVE.code_sha256), LIVE.code_hash);
  assert.equal(mod.codeHashFromSha256(RECEIPTS_PIN), EXPECTED_CODE_HASH);
  assert.notEqual(EXPECTED_CODE_HASH, LIVE.code_hash);
});

test("CHAIN_CHECK_IDS includes receipts-code and receipts-config, so green requires both live", () => {
  assert.ok(CHAIN_CHECK_IDS.includes("receipts-code"), "receipts-code must be a chain check");
  assert.ok(CHAIN_CHECK_IDS.includes("receipts-config"), "receipts-config must be a chain check");
});

test("recorded live receipts deployment: both checks fail as mismatch, redeploy pending, and overall green is false", async () => {
  const ev = await evidence();
  const chain = withReceipts(fakeRegistryChain(ev), LIVE);
  const r = await withTxFetch("ok", () => runWebChecks({ evidence: ev, chain, now: NOW }));
  const c = byId(r.checks);
  assert.equal(r.summary.runnableGreen, false, "the live receipts deployment must not show overall green");
  assert.ok(c["receipts-code"], "receipts-code check must exist");
  assert.ok(c["receipts-config"], "receipts-config check must exist");
  assert.equal(c["receipts-code"].state, "fail", c["receipts-code"].detail);
  assert.equal(c["receipts-config"].state, "fail", c["receipts-config"].detail);
  assert.match(c["receipts-code"].detail, /redeploy pending/i);
  assert.match(c["receipts-code"].detail, new RegExp(ACCOUNT.replace(/\./g, "\\.")));
  assert.match(c["receipts-code"].detail, LIVE.code_hash);
  assert.match(c["receipts-code"].detail, EXPECTED_CODE_HASH);
  assert.match(c["receipts-config"].detail, /redeploy pending/i);
  assert.match(c["receipts-config"].detail, /cashflow-v2\.1\.0/);
  assert.match(c["receipts-config"].detail, /truenav-v3\.0\.1/);
  assert.match(c["receipts-config"].detail, /360cd473/);
  assert.match(c["receipts-config"].detail, /098f5d86/);
  assert.doesNotMatch(`${c["receipts-code"].label} ${c["receipts-code"].detail} ${c["receipts-config"].label} ${c["receipts-config"].detail}`, /[\u2013\u2014]/);
  assert.equal(r.summary.counts.fail > 0, true);
  assert.equal(r.summary.runnableGreen, false, "the live receipts deployment must not show overall green");
  assert.equal(summarize(r.checks).green, false);
});

test("matching receipts code and v3 config (no stored receipt) can be live, and overall green can be true", async () => {
  const ev = await evidence();
  const chain = withReceipts(fakeRegistryChain(ev), matchingReceipts());
  const r = await withTxFetch("ok", () => runWebChecks({ evidence: ev, chain, now: NOW }));
  const c = byId(r.checks);
  assert.equal(c["receipts-code"].state, "live", c["receipts-code"] && c["receipts-code"].detail);
  assert.equal(c["receipts-config"].state, "live", c["receipts-config"] && c["receipts-config"].detail);
  assert.match(c["receipts-code"].detail, new RegExp(ACCOUNT.replace(/\./g, "\\.")));
  assert.match(c["receipts-code"].detail, EXPECTED_CODE_HASH);
  assert.match(c["receipts-config"].detail, /truenav-v3\.0\.1/);
  assert.match(c["receipts-config"].detail, /098f5d86/);
  assert.equal(r.summary.counts.fail, 0, JSON.stringify(r.checks.filter((x) => x.state === "fail")));
  assert.equal(r.summary.runnableGreen, true);
});

test("a matching code hash with the old v2 config still fails receipts-config and is not green", async () => {
  const ev = await evidence();
  const chain = withReceipts(fakeRegistryChain(ev), { ...LIVE, code_hash: EXPECTED_CODE_HASH });
  const rs = await runVerifierChecks({ evidence: ev, chain, now: NOW });
  const c = byId(rs);
  assert.equal(c["receipts-code"].state, "live");
  assert.equal(c["receipts-config"].state, "fail");
  assert.match(c["receipts-config"].detail, /redeploy pending/i);
  assert.equal(summarize(rs).green, false);
});

test("a matching v3 config with the live old code hash still fails receipts-code and is not green", async () => {
  const ev = await evidence();
  const chain = withReceipts(fakeRegistryChain(ev), matchingReceipts({ code_hash: LIVE.code_hash }));
  const rs = await runVerifierChecks({ evidence: ev, chain, now: NOW });
  const c = byId(rs);
  assert.equal(c["receipts-code"].state, "fail");
  assert.equal(c["receipts-config"].state, "live");
  assert.equal(summarize(rs).green, false);
});

test("when a stored receipt exists, its engine_code_sha256 must equal the engine pin", async () => {
  const ev = await evidence();
  const bad = matchingReceipts({
    get_config: { admin: "tnlab-718ca9.testnet", pauser: "tnlab-718ca9.testnet", paused: false, next_request: 2, config: v3Config() },
    list_tokens: [{ token_id: "DEMO-CREDIT", kind: "credit", receipts: 1 }],
    latest: { "DEMO-CREDIT": { token_id: "DEMO-CREDIT", seq: "1", engine_code_sha256: LIVE.get_config.config.version_key } },
  });
  const cBad = byId(await runVerifierChecks({ evidence: ev, chain: withReceipts(fakeRegistryChain(ev), bad), now: NOW }));
  assert.equal(cBad["receipts-config"].state, "fail");
  assert.match(cBad["receipts-config"].detail, /engine_code_sha256/);
  const good = matchingReceipts({
    get_config: { admin: "tnlab-718ca9.testnet", pauser: "tnlab-718ca9.testnet", paused: false, next_request: 2, config: v3Config() },
    list_tokens: [{ token_id: "DEMO-CREDIT", kind: "credit", receipts: 1 }],
    latest: { "DEMO-CREDIT": { token_id: "DEMO-CREDIT", seq: "1", engine_code_sha256: ENGINE_PIN } },
  });
  const cGood = byId(await runVerifierChecks({ evidence: ev, chain: withReceipts(fakeRegistryChain(ev), good), now: NOW }));
  assert.equal(cGood["receipts-config"].state, "live", cGood["receipts-config"] && cGood["receipts-config"].detail);
});

test("RPC cut on receipts reads: both checks are unchecked, never live, and not green", async () => {
  const ev = await evidence();
  const down = chainReader({
    contract: ev.status.registry,
    url: "fake",
    view: async () => { throw new Error("offline"); },
    codeHash: async () => { throw new Error("offline"); },
  });
  const rs = await runVerifierChecks({ evidence: ev, chain: down, now: NOW });
  const c = byId(rs);
  assert.equal(c["receipts-code"].state, "unchecked", c["receipts-code"] && c["receipts-code"].detail);
  assert.equal(c["receipts-config"].state, "unchecked", c["receipts-config"] && c["receipts-config"].detail);
  assert.equal(summarize(rs).green, false);
});

test("deploymentStatus names the receipts account, code hash, engine version, and redeploy pending on the live read", async () => {
  const ev = await evidence();
  const rs = await runVerifierChecks({ evidence: ev, chain: withReceipts(fakeRegistryChain(ev), LIVE), now: NOW });
  const mod = await import("../../verifier/checks.mjs");
  assert.equal(typeof mod.deploymentStatus, "function", "checks.mjs must export deploymentStatus");
  const d = mod.deploymentStatus(rs);
  assert.equal(d.account, ACCOUNT);
  assert.equal(d.codeHash, LIVE.code_hash);
  assert.ok(d.engineVersion === LIVE.get_config.config.version_key || d.engineVersion === ENGINE_PIN);
  assert.equal(d.pendingRedeploy, true);
  assert.match(d.line, new RegExp(ACCOUNT.replace(/\./g, "\\.")));
  assert.match(d.line, /redeploy pending/i);
  assert.doesNotMatch(d.line, /[\u2013\u2014]/);
  const page = read("web/src/pages/Verify.tsx");
  assert.match(page, /deploymentStatus/, "the Verify page must show the deployment line beside the summary note");
});
