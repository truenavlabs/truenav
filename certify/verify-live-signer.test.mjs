// certify/verify-live-signer.mjs against an in-memory fake chain built from the repository's own expectations. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkLiveRegistry } from "./verify-live-signer.mjs";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const expected = read("certify/live-registry.json");
const status = read("tee/status.json");

function fakeChain(edit = (s) => s) {
  const state = edit(structuredClone({
    code_hash: expected.code_hash,
    get_roles: expected.roles,
    get_signers: expected.certificate_signers,
    get_servicer_pledge_key: expected.servicer_pledge_address,
    get_pledge_signers: [],
    get_tee_signers: [{ address: status.tee_signer, model_id: status.model, attestation_ref: "x", attestation_sha256: status.report_sha256, registered_at_ms: 1 }],
  }));
  const calls = [];
  return {
    calls,
    view: async (c, m) => { calls.push([c, m]); if (!(m in state)) throw new Error(`unexpected view ${m}`); return state[m]; },
    codeHash: async (c) => { calls.push([c, "view_account"]); return state.code_hash; },
  };
}
const run = (chain, s = status) => checkLiveRegistry({ expected, status: s, view: chain.view, codeHash: chain.codeHash });
const failing = (r) => r.checks.filter((c) => !c.ok).map((c) => c.text);

test("the repository's expectations agree with each other and with tee/status.json", () => {
  assert.equal(expected.contract, status.registry);
  assert.equal(status.tee, "live");
  assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), new RegExp(expected.code_hash), "the README names the same code hash");
  for (const k of ["admin", "registrar", "pauser", "servicer"]) assert.match(expected.roles[k], /(^|\.)tnlab-368aa2\.testnet$/);
});

test("a chain that matches passes every check, and only views on the live registry are made", async () => {
  const chain = fakeChain();
  const r = await run(chain);
  assert.deepEqual(failing(r), []);
  assert.equal(r.ok, true);
  assert.ok(chain.calls.every(([c]) => c === expected.contract));
});

test("each difference is named: code hash, a role, certificate signers, pledge key, ticket signers, TEE signer, its model and report hash", async () => {
  const cases = [
    [(s) => { s.code_hash = "Other"; return s; }, /code hash/],
    [(s) => { s.get_roles.servicer = "mallory.testnet"; return s; }, /role servicer/],
    [(s) => { s.get_roles.paused = true; return s; }, /role paused/],
    [(s) => { s.get_signers.push("0x" + "1".repeat(40)); return s; }, /certificate signers/],
    [(s) => { s.get_servicer_pledge_key = "0x" + "2".repeat(40); return s; }, /servicer pledge key/],
    [(s) => { s.get_pledge_signers = [{ address: "0x" + "3".repeat(40) }]; return s; }, /pledge-ticket signers/],
    [(s) => { s.get_tee_signers[0].address = "0x" + "4".repeat(40); return s; }, /the TEE signer is/],
    [(s) => { s.get_tee_signers.push({ ...s.get_tee_signers[0], address: "0x" + "5".repeat(40) }); return s; }, /exactly one TEE signer/],
    [(s) => { s.get_tee_signers[0].model_id = "z-ai/other"; return s; }, /model is/],
    [(s) => { s.get_tee_signers[0].attestation_sha256 = "0".repeat(64); return s; }, /attestation sha256/],
  ];
  for (const [edit, re] of cases) {
    const r = await run(fakeChain(edit));
    assert.equal(r.ok, false, String(re));
    assert.ok(failing(r).some((t) => re.test(t)), `${re}: ${failing(r).join(" | ")}`);
  }
});

test("a pending status, or a status for another registry, fails", async () => {
  assert.ok(failing(await run(fakeChain(), { ...status, tee: "pending" })).some((t) => /says live/.test(t)));
  assert.ok(failing(await run(fakeChain(), { ...status, registry: "registry.other.testnet" })).some((t) => /same registry/.test(t)));
});

test("the CLI refuses an unknown argument with exit 2, before any network access", () => {
  const cli = fileURLToPath(new URL("./verify-live-signer.mjs", import.meta.url));
  assert.equal(spawnSync(process.execPath, [cli, "--nope"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, "--rpc"], { encoding: "utf8" }).status, 2);
});
