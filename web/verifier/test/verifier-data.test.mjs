// G1: the verifier panel data layer must never show a pass it did not just earn. Offline: the chain is a fake built
// from the committed evidence, or the real web/chain.mjs reader with fetch cut. No network, no keys.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runVerifierChecks, summarize, chainReader, STATES, CHAIN_CHECK_IDS, VERDICT_TTL_MS as TTL_WEB, bindingFor as bindingWeb, codeHashFromSha256 } from "../checks.mjs";
import { loadEvidence } from "../evidence.mjs";
import { eip191Recover as recoverWeb, sha256Hex } from "../eip191.mjs";
import { eip191Recover as recoverNode, bindingFor as bindingNode, VERDICT_TTL_MS as TTL_NODE } from "../../../tee/underwrite.mjs";

const root = new URL("../../../", import.meta.url);
const readText = async (p) => readFileSync(new URL(p, root), "utf8");
const fresh = async () => structuredClone(await loadEvidence(readText));
const NOW = Date.parse("2026-11-20T00:00:00Z"); // inside the recorded set's 30 day window

/** A chain that answers like the live registry, from the committed evidence (the set the live registry holds). */

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

function fakeChain(ev, over = {}) {
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
    get_latest_certificate: ({ fund_id }) => ({ certificate: { fund_id, band: "green", score: 90 }, signer: ev.liveRegistry.certificate_signers[0], stored_at_ms: 1 }),
    ...over,
  };
  return attachPinnedReceipts(chainReader({
    contract: ev.status.registry,
    url: "fake",
    view: async (_c, m, a) => { if (!views[m]) throw new Error(`no view ${m}`); return views[m](a); },
    codeHash: async () => (over.codeHash ? over.codeHash() : ev.liveRegistry.code_hash),
  }));
}

const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));
const flipHex = (s, at) => s.slice(0, at) + (s[at] === "0" ? "1" : "0") + s.slice(at + 1);

test("intact evidence and an answering chain: chain checks live, attestation recorded with its date, the rest honestly unchecked", async () => {
  const ev = await fresh();
  const rs = await runVerifierChecks({ evidence: ev, chain: fakeChain(ev), now: NOW });
  const r = byId(rs);
  for (const id of [...CHAIN_CHECK_IDS, "verdict-signatures", "verdict-replies", "verdict-binding"]) assert.equal(r[id].state, "live", `${id}: ${r[id].detail}`);
  assert.equal(r["attestation-quote"].state, "recorded");
  assert.equal(r["attestation-quote"].evidenceDate, ev.verdicts.attestation.checked_at);
  for (const id of ["image-measurements", "prompt-binding", "wasm-source"]) assert.equal(r[id].state, "unchecked");
  assert.equal(summarize(rs).green, true);
});

test("every result has the documented shape and no em or en dash", async () => {
  const ev = await fresh();
  for (const x of await runVerifierChecks({ evidence: ev, chain: fakeChain(ev), now: NOW })) {
    assert.deepEqual(Object.keys(x).filter((k) => !["id", "label", "state", "detail", "source", "evidenceDate"].includes(k)), []);
    assert.ok(STATES.includes(x.state));
    for (const k of ["id", "label", "detail", "source"]) assert.equal(typeof x[k], "string");
    assert.doesNotMatch(`${x.label} ${x.detail}`, /[\u2013\u2014]/);
    assert.ok(Object.isFrozen(x));
  }
});

test("RPC cut (fetch rejects): no chain check is live, none is green, local checks still run", async () => {
  const ev = await fresh();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed"); };
  try {
    const rs = await runVerifierChecks({ evidence: ev, chain: chainReader({ contract: ev.status.registry }), now: NOW }); // real web/chain.mjs, default RPC and its backups
    const r = byId(rs);
    assert.ok(calls >= 3, "the real reader tried the default RPC and its backups");
    for (const id of CHAIN_CHECK_IDS) {
      assert.equal(r[id].state, "unchecked", `${id} must not pass without the chain: ${r[id].detail}`);
      assert.match(r[id].detail, /could not read/);
    }
    assert.equal(r["verdict-signatures"].state, "live");
    const s = summarize(rs);
    assert.equal(s.green, false);
    assert.equal(s.chainLive, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("RPC answers HTTP 500 or a JSON-RPC error: still no chain check is live", async () => {
  const ev = await fresh();
  const realFetch = globalThis.fetch;
  for (const reply of [() => new Response("down", { status: 500 }), () => Response.json({ jsonrpc: "2.0", id: "truenav", error: { name: "HANDLER_ERROR", message: "boom" } })]) {
    globalThis.fetch = async () => reply();
    try {
      const r = byId(await runVerifierChecks({ evidence: ev, chain: chainReader({ contract: ev.status.registry }), now: NOW }));
      for (const id of CHAIN_CHECK_IDS) assert.equal(r[id].state, "unchecked", id);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test("one signature byte flipped: signatures fail, the on-chain match fails, summary not green", async () => {
  const ev = await fresh();
  const chain = fakeChain(structuredClone(ev)); // chain holds the true verdicts
  const rec = ev.verdicts.results[0];
  rec.onchain.signature = flipHex(rec.onchain.signature, 10);
  const r = byId(await runVerifierChecks({ evidence: ev, chain, now: NOW }));
  assert.equal(r["verdict-signatures"].state, "fail");
  assert.equal(r["onchain-verdicts"].state, "fail");
  assert.equal(summarize(Object.values(r)).green, false);
});

test("signature flipped and the chain cut: still fail, never live", async () => {
  const ev = await fresh();
  ev.verdicts.results[3].onchain.signature = flipHex(ev.verdicts.results[3].onchain.signature, 70);
  const down = chainReader({ contract: "x.testnet", view: async () => { throw new Error("offline"); }, codeHash: async () => { throw new Error("offline"); } });
  const r = byId(await runVerifierChecks({ evidence: ev, chain: down, now: NOW }));
  assert.equal(r["verdict-signatures"].state, "fail");
  assert.ok(Object.values(r).every((x) => !(CHAIN_CHECK_IDS.includes(x.id) && x.state === "live")));
});

test("response body changed by one character: its signature no longer recovers", async () => {
  const ev = await fresh();
  const on = ev.verdicts.results[1].onchain;
  const before = on.response_body;
  on.response_body = on.response_body.replace(/pass/, "flag");
  assert.notEqual(on.response_body, before);
  const r = byId(await runVerifierChecks({ evidence: ev, chain: fakeChain(await fresh()), now: NOW }));
  assert.equal(r["verdict-signatures"].state, "fail");
});

test("published report changed by one byte: hash fails even with the chain down; attestation is not shown as recorded", async () => {
  const ev = await fresh();
  const bytes = Buffer.from(ev.reportB64.replace(/\s+/g, ""), "base64");
  bytes[bytes.indexOf(Buffer.from("signing_address")) + 20] ^= 1;
  ev.reportB64 = bytes.toString("base64");
  const down = chainReader({ view: async () => { throw new Error("offline"); }, codeHash: async () => { throw new Error("offline"); } });
  const r = byId(await runVerifierChecks({ evidence: ev, chain: down, now: NOW }));
  assert.equal(r["attestation-hash"].state, "fail");
  assert.notEqual(r["attestation-quote"].state, "recorded");
});

test("a recorded attestation check that did not pass is a fail, not recorded", async () => {
  const ev = await fresh();
  ev.verdicts.attestation.sections[1].checks[0].pass = false;
  const r = byId(await runVerifierChecks({ evidence: ev, chain: fakeChain(ev), now: NOW }));
  assert.equal(r["attestation-quote"].state, "fail");
});

test("chain disagrees (code hash, TEE signer, on-chain verdict): each is a fail", async () => {
  const ev = await fresh();
  const r = byId(await runVerifierChecks({
    evidence: ev,
    now: NOW,
    chain: fakeChain(ev, {
      codeHash: () => "11111111111111111111111111111111",
      get_tee_signers: () => [{ address: "0x" + "ab".repeat(20), model_id: ev.status.model, attestation_sha256: ev.status.report_sha256 }],
      get_latest_verdict: () => ({ verdict: "pass", anomalies: [], signer: ev.status.tee_signer, response_sha256: "00".repeat(32) }),
    }),
  }));
  for (const id of ["registry-code", "tee-signer", "attestation-hash", "onchain-verdicts"]) assert.equal(r[id].state, "fail", id);
});

test("expiry matches the contract boundary: equal to now is current, now + 1 ms past it is expired", async () => {
  const ev = await fresh();
  const at = (now) => runVerifierChecks({ evidence: ev, chain: fakeChain(ev), now }).then((rs) => byId(rs)["verdict-binding"].state);
  assert.equal(await at(ev.verdicts.expires_at_ms), "live");
  assert.equal(await at(ev.verdicts.expires_at_ms + 1), "fail");
});

test("missing or unreadable evidence never yields live or recorded for the evidence checks", async () => {
  const rs = await runVerifierChecks({ evidence: {}, chain: chainReader({ view: async () => { throw new Error("offline"); }, codeHash: async () => { throw new Error("offline"); } }), now: NOW });
  const r = byId(rs);
  for (const id of ["attestation-hash", "attestation-quote", "verdict-signatures", "verdict-replies", "verdict-binding"]) assert.equal(r[id].state, "fail", id);
  await assert.rejects(loadEvidence(async (p) => (p.endsWith("status.json") ? "{not json" : "")));
});

test("browser crypto agrees with tee/underwrite.mjs on every recorded verdict and on a corrupted signature", async () => {
  const ev = await fresh();
  const f = ev.verdicts;
  for (const r of f.results) {
    const text = `${f.model}:${r.onchain.request_sha256}:${sha256Hex(r.onchain.response_body)}`;
    assert.equal(recoverWeb(text, r.onchain.signature), recoverNode(text, r.onchain.signature));
    const bad = flipHex(r.onchain.signature, 4);
    let a, b;
    try { a = recoverWeb(text, bad); } catch { a = "throws"; }
    try { b = recoverNode(text, bad); } catch { b = "throws"; }
    assert.equal(a, b);
    assert.notEqual(a, f.attestation.signers[0].signing_address.toLowerCase());
  }
  assert.equal(TTL_WEB, TTL_NODE);
  assert.equal(bindingWeb(f.contract_id, f.expires_at_ms), bindingNode(f.contract_id, f.expires_at_ms));
});

test("the data layer imports nothing from node: (it must load in a browser)", () => {
  for (const p of ["web/verifier/checks.mjs", "web/verifier/eip191.mjs", "web/verifier/evidence.mjs", "web/verifier/index.mjs", "tee/reply.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(p, root), "utf8"), /from\s+["']node:|require\(|\bBuffer\./, p);
  }
  // web/chain.mjs keeps a Buffer fallback behind a typeof btoa guard; it must still import nothing from node:
  assert.doesNotMatch(readFileSync(new URL("web/chain.mjs", root), "utf8"), /from\s+["']node:|require\(/);
});

// NEW-05: the deployed registry returns a verdict stored in the same millisecond as the current pledge, which can be
// the previous pledge's verdict. The verifier accepts a latest verdict only when it is strictly after the lock time.
test("NEW-05: a latest verdict stored at the lock millisecond fails the on-chain match as pledge generation ambiguous", async () => {
  const ev = await fresh();
  const same = { get_lock: () => ({ fund_id: "f", locked_at_ms: 1 }) }; // the fake stores every verdict at at_ms 1
  const r = byId(await runVerifierChecks({ evidence: ev, chain: fakeChain(ev, same), now: NOW }));
  assert.equal(r["onchain-verdicts"].state, "fail");
  assert.match(r["onchain-verdicts"].detail, /pledge generation ambiguous/);
  assert.equal(summarize(Object.values(r)).green, false);
  const after = byId(await runVerifierChecks({ evidence: ev, chain: fakeChain(ev, { get_lock: () => ({ fund_id: "f", locked_at_ms: 0 }) }), now: NOW }));
  assert.equal(after["onchain-verdicts"].state, "live");
});
