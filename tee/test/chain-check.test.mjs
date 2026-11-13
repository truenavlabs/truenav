// tee/chain-check.mjs against an in-memory fake chain built from a synthetic signed set: no network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chainCheck } from "../chain-check.mjs";
import { syntheticSet, REGISTRY, SIGNED_AT, SIGNER, REPORT_SHA, sha } from "./synthetic-set.mjs";

const NOW = SIGNED_AT + 86400000;

/** What the registry would return after the set was submitted: one stored verdict per record, and the signer registered. */
function chainFor(file, { signer = SIGNER, model = file.model, attestation = REPORT_SHA, withTraps = false } = {}) {
  const verdicts = {};
  for (const r of file.results) {
    if (r.tampered && !withTraps) continue; // trap records are in the file and are not submitted

    verdicts[r.loan_hash] = [{
      verdict: r.verdict.verdict, anomalies: r.verdict.anomalies, signer, model_id: file.model, request_sha256: r.onchain.request_sha256,
      response_sha256: sha(r.onchain.response_body), attestation_sha256: attestation, expires_at_ms: file.expires_at_ms, submitted_by: "servicer.testnet", at_ms: NOW,
    }];
  }
  const calls = [];
  const view = async (contract, method, args) => {
    calls.push({ contract, method });
    if (method === "get_tee_signers") return [{ address: signer, model_id: model, attestation_ref: "ref", attestation_sha256: attestation, registered_at_ms: NOW }];
    if (method === "get_verdicts_page") return verdicts[args.loan_hash] || [];
    throw new Error(`unexpected view ${method}`);
  };
  return { view, calls, verdicts };
}
const run = (file, chain, o = {}) => chainCheck({ file, contract: REGISTRY, reportSha256: REPORT_SHA, view: chain.view, nowMs: NOW, ...o });
const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => c.text);

test("a set that is fully on chain passes every check", async () => {
  const file = syntheticSet();
  const chain = chainFor(file);
  const r = await run(file, chain);
  assert.deepEqual(failing(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.checks.filter((c) => /: on chain, /.test(c.text)).length, 2);
  assert.equal(r.checks.filter((c) => /not on chain, as intended/.test(c.text)).length, 1);
  assert.ok(chain.calls.every((c) => c.contract === REGISTRY && ["get_tee_signers", "get_verdicts_page"].includes(c.method)), "only these two views are called");
});

// N-02: the set's expiry is the expiry of every stored verdict (the per-record check requires them equal). One second
// past it the check fails with the set reported as expired, before the chain is read; one second before it is current.
test("a verdict set 1 second past expiry is reported as expired; 1 second before is current", async () => {
  const file = syntheticSet();
  let r = await run(file, chainFor(file), { nowMs: file.expires_at_ms + 1000 });
  assert.equal(r.ok, false);
  assert.ok(failing(r).some((t) => /expired/.test(t)), failing(r).join("; "));
  r = await run(file, chainFor(file), { nowMs: file.expires_at_ms - 1000 });
  assert.deepEqual(failing(r), []);
  assert.equal(r.checks.filter((c) => /: on chain, pass/.test(c.text)).length, 2);
});

test("a verdict set whose expiry equals now is current on chain; expiry + 1 ms is expired", async () => {
  const file = syntheticSet();
  let r = await run(file, chainFor(file), { nowMs: file.expires_at_ms });
  assert.deepEqual(failing(r), []);
  r = await run(file, chainFor(file), { nowMs: file.expires_at_ms + 1 });
  assert.equal(r.ok, false);
  assert.ok(failing(r).some((t) => /expired/.test(t)), failing(r).join("; "));
});

test("the signer, its model and its attestation hash on chain must be the file's", async () => {
  const file = syntheticSet();
  let r = await run(file, chainFor(file, { signer: "0x" + "1".repeat(40) }));
  assert.equal(r.ok, false); assert.ok(failing(r).some((t) => /is a registered TEE signer/.test(t)));
  r = await run(file, chainFor(file, { model: "another/model" }));
  assert.ok(failing(r).some((t) => /registered model is/.test(t)));
  r = await run(file, chainFor(file, { attestation: "f".repeat(64) }));
  assert.ok(failing(r).some((t) => /registered attestation sha256/.test(t)));
});

test("a missing verdict, or a stored verdict that differs from the file, fails with the field named", async () => {
  const file = syntheticSet();
  const missing = chainFor(file);
  missing.verdicts[file.results[1].loan_hash] = [];
  let r = await run(file, missing);
  assert.equal(r.ok, false); assert.ok(failing(r).some((t) => /S-1 .*no stored verdict/.test(t)));
  for (const [field, mutate] of [
    ["verdict", (s) => { s.verdict = s.verdict === "pass" ? "flag" : "pass"; }],
    ["anomalies", (s) => { s.anomalies = ["unreadable"]; }],
    ["expires_at_ms", (s) => { s.expires_at_ms += 1; }],
    ["request_sha256", (s) => { s.request_sha256 = "0".repeat(64); }],
    ["signer", (s) => { s.signer = "0x" + "2".repeat(40); }],
    ["model_id", (s) => { s.model_id = "x/y"; }],
    ["attestation_sha256", (s) => { s.attestation_sha256 = "e".repeat(64); }],
  ]) {
    const c = chainFor(file);
    mutate(c.verdicts[file.results[0].loan_hash][0]);
    r = await run(file, c);
    assert.ok(failing(r).some((t) => t.includes("differs from the file in") && t.includes(field)), field);
  }
});

test("file problems stop the check before the chain is read: wrong registry, tampered reply, wrong report, expired set", async () => {
  const file = syntheticSet();
  const never = { view: async () => { throw new Error("the chain must not be read"); } };
  assert.equal((await run(file, never, { contract: "registry.other.testnet" })).ok, false);
  const bad = syntheticSet(); bad.results[0].onchain.response_body += " ";
  assert.equal((await run(bad, never)).ok, false);
  assert.ok(failing(await run(file, never, { reportSha256: "a".repeat(64) })).some((t) => /attestation report file has the sha256/.test(t)));
  const r = await run(file, chainFor(file), { nowMs: file.expires_at_ms + 1 });
  assert.equal(r.ok, false);
});

test("a trap record on chain fails the check unless --allow-traps is given", async () => {
  const file = syntheticSet();
  const chain = chainFor(file, { withTraps: true });
  let r = await run(file, chain);
  assert.equal(r.ok, false);
  assert.ok(failing(r).some((t) => /trap record T1-altered-amount is on chain, but the plan was not to submit it/.test(t)));
  r = await run(file, chain, { allowTraps: true });
  assert.deepEqual(failing(r), []);
  assert.ok(r.checks.some((c) => /trap record T1-altered-amount is on chain \(allowed by --allow-traps\)/.test(c.text)));
});

test("verdicts beyond one page are found", async () => {
  const file = syntheticSet({ n: 2 });
  const chain = chainFor(file);
  const real = chain.verdicts[file.results[0].loan_hash][0];
  const filler = (i) => ({ ...real, response_sha256: sha(`filler ${i}`) });
  chain.verdicts[file.results[0].loan_hash] = [...Array.from({ length: 100 }, (_, i) => filler(i)), real];
  const view = async (c, m, a) => (m === "get_verdicts_page" ? (chain.verdicts[a.loan_hash] || []).slice(a.from_index, a.from_index + a.limit) : chain.view(c, m, a));
  assert.equal((await chainCheck({ file, contract: REGISTRY, reportSha256: REPORT_SHA, view, nowMs: NOW })).ok, true);
});

test("the CLI refuses an unknown argument and a missing verdicts file with exit 2, before any network access", () => {
  const cli = fileURLToPath(new URL("../chain-check.mjs", import.meta.url));
  assert.equal(spawnSync(process.execPath, [cli, "--nope"], { encoding: "utf8" }).status, 2);
  const r = spawnSync(process.execPath, [cli, "--verdicts", "tee/fixtures/does-not-exist.json"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no verdicts file at tee\/fixtures\/does-not-exist\.json: nothing to check yet \(TEE status is live\)/);
});
