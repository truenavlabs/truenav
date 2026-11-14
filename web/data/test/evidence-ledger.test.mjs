// Evidence ledger: the real testnet transactions the README and docs point to, each checked against the public
// testnet RPC and NearBlocks (read only) and recorded with its block time in UTC. The offline tests check the committed
// file against the repository's own docs; buildLedger is tested with stubbed fetchers. No network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonical } from "../../../judge/lib.mjs";
import { ENTRIES, buildLedger, ledgerHash, LEDGER_SCHEMA } from "../../scripts/record-evidence-ledger.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const ledger = () => JSON.parse(read("web/data/recorded/evidence-ledger.json"));
const B58_TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const WANT = [
  ["registry_deploy", "Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE"],
  ["refused_signer_not_registered", "Gbu7tKHuE2WVfSMduS1MNyuMRf6TQSQyou2gr9ozXrnQ"],
  ["refused_already_pledged", "8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs"],
  ["tee_signer_registered", "9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE"],
  ["query_redeploy", "2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8"],
  ["registry_storage_topup", "7wjnse7nQxVyZLn29RRH4nxQmVGCNfWDBkucnSwC5Eka"],
];

test("the entries are the six transactions, with full 44 character hashes, in time order", () => {
  assert.deepEqual(ENTRIES.map((e) => [e.id, e.tx_hash]), WANT);
  for (const e of ENTRIES) assert.match(e.tx_hash, B58_TX);
  const l = ledger();
  assert.equal(l.schema, LEDGER_SCHEMA);
  assert.deepEqual(l.entries.map((e) => [e.id, e.tx_hash]), WANT);
  const times = l.entries.map((e) => Date.parse(e.block_time_utc));
  assert.deepEqual([...times].sort((a, b) => a - b), times, "not in time order");
});

test("each recorded transaction was read from RPC and NearBlocks and the two agreed", () => {
  for (const e of ledger().entries) {
    assert.equal(e.verified.rpc, "archival-rpc.testnet.near.org", e.id);
    assert.equal(e.verified.cross_check, "api-testnet.nearblocks.io", e.id);
    assert.equal(e.verified.agree, true, e.id);
    assert.match(e.signer, /\.testnet$/);
    assert.match(e.receiver, /\.testnet$/);
    assert.ok(Number.isInteger(e.block_height) && e.block_height > 277_000_000, e.id);
    assert.match(e.block_hash, B58_TX);
  }
});

test("block time is UTC, ends in Z, and is the block's nanosecond timestamp", () => {
  for (const e of ledger().entries) {
    assert.match(e.block_time_utc, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, e.id);
    assert.equal(e.block_time_utc, new Date(Number(BigInt(e.block_time_ns) / 1_000_000n)).toISOString(), e.id);
    assert.ok(Date.parse(e.block_time_utc) >= Date.parse("2026-11-05T00:00:00Z") && Date.parse(e.block_time_utc) <= Date.now(), e.id);
  }
});

test("block heights and UTC times agree with the README's build window list", () => {
  const readme = read("README.md");
  const byHash = new Map(ledger().entries.map((e) => [e.tx_hash, e]));
  let seen = 0;
  for (const m of readme.matchAll(/^- (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC: .*?\/(?:transactions|txns)\/([1-9A-HJ-NP-Za-km-z]{43,44})\).*?block (\d+)\./gm)) {
    const e = byHash.get(m[2]);
    assert.ok(e, `README lists ${m[2]} but the ledger does not`);
    assert.equal(e.block_time_utc.slice(0, 19).replace("T", " "), m[1], `${e.id} time`);
    assert.equal(String(e.block_height), m[3], `${e.id} height`);
    seen++;
  }
  assert.equal(seen, 5, "the README build window list should name five of the six transactions");
});

test("every ledger transaction is named in a repository document, and links point at a testnet explorer", () => {
  const docs = ["README.md", "docs/DEPLOYMENT_EVIDENCE.md", "docs/KNOWN_LIMITS.md", "docs/TRY_IT.md"].map(read).join("\n");
  for (const e of ledger().entries) {
    assert.ok(docs.includes(e.tx_hash), `${e.id}: no repository document names ${e.tx_hash}`);
    assert.equal(e.explorer_url, `https://testnet.nearblocks.io/txns/${e.tx_hash}`);
    assert.equal(e.explorer_alt_url, `https://explorer.testnet.near.org/transactions/${e.tx_hash}`);
  }
});

test("what each transaction did is what the docs say it did", () => {
  const by = Object.fromEntries(ledger().entries.map((e) => [e.id, e]));
  assert.equal(by.registry_deploy.receiver, "registry.tnlab-368aa2.testnet");
  assert.match(by.registry_deploy.actions, /DEPLOY_CONTRACT/);
  assert.equal(by.registry_deploy.outcome.status, "success");
  assert.equal(by.refused_signer_not_registered.outcome.status, "failure");
  assert.match(by.refused_signer_not_registered.outcome.result, /signer not registered/);
  assert.match(by.refused_signer_not_registered.actions, /submit_certificate/);
  assert.equal(by.refused_already_pledged.outcome.status, "success");
  assert.match(by.refused_already_pledged.outcome.result, /refused: already pledged elsewhere/);
  assert.match(by.refused_already_pledged.actions, /pledge_loan/);
  assert.match(by.tee_signer_registered.actions, /add_tee_signer/);
  assert.equal(by.tee_signer_registered.outcome.status, "success");
  assert.equal(by.query_redeploy.receiver, "query.tnlab-718ca9.testnet");
  assert.match(by.query_redeploy.actions, /DEPLOY_CONTRACT/);
  assert.equal(by.registry_storage_topup.receiver, "registry.tnlab-368aa2.testnet");
  assert.equal(by.registry_storage_topup.signer, "tnlab-368aa2.testnet");
  assert.match(by.registry_storage_topup.actions, /TRANSFER 1 NEAR/);
  assert.equal(by.registry_storage_topup.outcome.status, "success");
});

test("evidence_hash covers the entries and ignores the generated-at time", () => {
  const l = ledger();
  const { ephemeral, evidence_hash, ...hashed } = l;
  assert.equal(evidence_hash, createHash("sha256").update(canonical(hashed)).digest("hex"));
  assert.equal(ledgerHash(l), evidence_hash);
  assert.match(ephemeral.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const t = structuredClone(l);
  t.entries[0].block_height += 1;
  assert.notEqual(ledgerHash(t), evidence_hash);
});

// buildLedger with stubbed fetchers: it must refuse a transaction that is missing, differs between the two sources, or is not what the entry says
const nb = (e, over = {}) => ({ txns: [{ transaction_hash: e.tx_hash, signer_account_id: e.signer, receiver_account_id: e.receiver, block: { block_height: e.block_height }, block_timestamp: e.block_time_ns, ...over }] });
function withRaw() {
  // the stub needs RPC-shaped actions and status, rebuilt from the recorded entry
  const l = ledger();
  for (const e of l.entries) {
    e.__rpcActions = e.actions.split(" + ").map((a) => (a.startsWith("DEPLOY_CONTRACT") ? { DeployContract: { code: "x" } } : a.startsWith("TRANSFER") ? { Transfer: { deposit: "1000000000000000000000000" } } : { FunctionCall: { method_name: a.split(" ")[0], args: "", gas: 1, deposit: "0" } }));
    e.__rpcStatus = e.outcome.status === "failure"
      ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${e.outcome.result.replace(/^Smart contract panicked: /, "")}` } } } } }
      : { SuccessValue: e.outcome.result.startsWith("refused:") ? Buffer.from(JSON.stringify({ outcome: "refused", message: e.outcome.result.slice(9), attempt_id: "attempt-1" })).toString("base64") : "" };
  }
  return l;
}

test("buildLedger agrees with the committed ledger when both sources agree, and refuses when they do not", async () => {
  const l = withRaw();
  const rec = new Map(l.entries.map((e) => [e.tx_hash, e]));
  const f = {
    nearblocks: async (h) => nb(rec.get(h)),
    rpc: async (method, params) => {
      if (method === "block") { const e = l.entries.find((x) => x.block_hash === params.block_id); return { header: { height: e.block_height, timestamp_nanosec: e.block_time_ns } }; }
      const e = rec.get(params.tx_hash);
      return { final_execution_status: "FINAL", transaction: { signer_id: e.signer, receiver_id: e.receiver, actions: e.__rpcActions }, transaction_outcome: { block_hash: e.block_hash }, status: e.__rpcStatus };
    },
  };
  const built = await buildLedger({ entries: ENTRIES, fetchers: f, now: "2026-11-14T12:00:00.000Z" });
  const committed = ledger();
  assert.deepEqual(built.entries.map((e) => [e.tx_hash, e.block_height, e.block_time_utc, e.signer, e.receiver, e.outcome.status]), committed.entries.map((e) => [e.tx_hash, e.block_height, e.block_time_utc, e.signer, e.receiver, e.outcome.status]));
  await assert.rejects(() => buildLedger({ entries: ENTRIES, fetchers: { ...f, nearblocks: async (h) => (h === ENTRIES[0].tx_hash ? { txns: [] } : nb(rec.get(h))) }, now: "x" }), /not found/i);
  await assert.rejects(() => buildLedger({ entries: ENTRIES, fetchers: { ...f, nearblocks: async (h) => nb(rec.get(h), h === ENTRIES[1].tx_hash ? { block: { block_height: 1 } } : {}) }, now: "x" }), /disagree/i);
  await assert.rejects(() => buildLedger({ entries: ENTRIES, fetchers: { ...f, nearblocks: async (h) => nb(rec.get(h), h === ENTRIES[2].tx_hash ? { block_timestamp: "1" } : {}) }, now: "x" }), /disagree/i);
  const wrongReceiver = [{ ...ENTRIES[0], expect: { ...ENTRIES[0].expect, receiver: "someone.testnet" } }, ...ENTRIES.slice(1)];
  await assert.rejects(() => buildLedger({ entries: wrongReceiver, fetchers: f, now: "x" }), /receiver/i);
  const wrongStatus = [...ENTRIES.slice(0, 1), { ...ENTRIES[1], expect: { ...ENTRIES[1].expect, status: "success" } }, ...ENTRIES.slice(2)];
  await assert.rejects(() => buildLedger({ entries: wrongStatus, fetchers: f, now: "x" }), /status/i);
  const wrongText = [...ENTRIES.slice(0, 2), { ...ENTRIES[2], expect: { ...ENTRIES[2].expect, result: "something else" } }, ...ENTRIES.slice(3)];
  await assert.rejects(() => buildLedger({ entries: wrongText, fetchers: f, now: "x" }), /result/i);
  const notFinal = { ...f, rpc: async (m, p) => { const r = await f.rpc(m, p); return m === "block" ? r : { ...r, final_execution_status: "INCLUDED" }; } };
  await assert.rejects(() => buildLedger({ entries: ENTRIES, fetchers: notFinal, now: "x" }), /final/i);
});

test("plain text only: no em or en dashes in the ledger", () => {
  assert.doesNotMatch(read("web/data/recorded/evidence-ledger.json"), /[\u2013\u2014]/);
});
