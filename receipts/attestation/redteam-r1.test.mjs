// Red team round 1. Simulated quote capability only. No live attestation is fetched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {matchWithCapabilities, bodyOf, canonical, sha} from './match-core.mjs';
import {taskHash, quoteFields} from '../../tee/fingerprint.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL('../../' + p, import.meta.url)));

function fixture() {
  const e = structuredClone(read('schema/vectors/engine-v3-derived.json').vectors[0].envelope);
  const real = read('tee/fixtures/fingerprint-attestation-sample.json');
  const m = quoteFields(Buffer.from(real.tdx_quote, 'base64'));
  const p = {
    ...real,
    wasm_hash: e.engine_code_sha256,
    executed_wasm_sha256: e.engine_code_sha256,
    input_hash: 'a'.repeat(64),
    output_hash: sha(canonical(bodyOf(e))),
    caller_account_id: 'runner.testnet',
    project_id: 'receipts.tnlab-718ca9.testnet/truenav-engine',
    build_target: 'wasm32-wasip2',
  };
  const r = {
    token_id: e.token_id,
    seq: e.seq,
    receipt_sha256: e.receipt_sha256,
    body_sha256: p.output_hash,
    proof_ref: 'https://testnet-api.outlayer.ai/attestations/by-request/1',
    proof_scheme: 'outlayer_tdx_v1',
    attester: 'relayer.testnet',
    block_height: '100',
  };
  const c = {
    engine_code_sha256: e.engine_code_sha256,
    input_hash: p.input_hash,
    caller_account_id: p.caller_account_id,
    project_id: p.project_id,
    fund_id: e.fund_id,
    approved_measurements: [m],
  };
  const caps = {
    fetchProof: async () => p,
    quoteFields: () => ({...m, report_data: taskHash(p) + '0'.repeat(64)}),
    verifyQuote: async () => ({status: 'UpToDate'}),
  };
  return {args: {envelope: e, record: r, context: c}, caps, p};
}

test('redteam_r1 caller fund_id must match the attested token', async () => {
  const f = fixture();
  f.args.context.fund_id = 'victim-credit-fund';
  assert.notEqual(f.args.context.fund_id, f.args.envelope.fund_id || f.args.envelope.token_id);
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'fund_id_unbound');
});

test('redteam_r1 stale UpToDate quote must expire', async () => {
  const f = fixture();
  f.p.timestamp = 1_600_000_000;
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'attestation_expired');
});

test('redteam_r1 a future quote beyond five minutes must expire', async () => {
  const f = fixture();
  f.p.timestamp = Math.floor(Date.now() / 1000) + 10 * 60;
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'attestation_expired');
  const fresh = fixture();
  fresh.p.timestamp = Math.floor(Date.now() / 1000) + 60;
  assert.equal((await matchWithCapabilities(fresh.args, fresh.caps)).status, 'attested');
});

test('redteam_r1 caller fund_id is required', async () => {
  const f = fixture();
  delete f.args.context.fund_id;
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'fund_id_unbound');
});
