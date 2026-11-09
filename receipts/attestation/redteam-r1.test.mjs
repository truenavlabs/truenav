// Red team round 1. Simulated quote capability only. No live attestation is fetched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {matchWithCapabilities, bodyOf, canonical, sha, QUOTE_RUN_WINDOW_SEC} from './match-core.mjs';
import {taskHash, quoteFields} from '../../tee/fingerprint.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL('../../' + p, import.meta.url)));

function fixture() {
  const e = structuredClone(read('schema/vectors/engine-v3-derived.json').vectors[0].envelope);
  const real = read('tee/fixtures/fingerprint-attestation-sample.json');
  const m = quoteFields(Buffer.from(real.tdx_quote, 'base64'));
  const p = {
    ...real,
    timestamp: Math.floor(Date.parse(e.valuation_time) / 1000),
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

function reseal(f) {
  const {receipt_sha256: _dropped, ...preimage} = f.args.envelope;
  f.args.envelope.receipt_sha256 = sha(canonical(preimage));
  f.p.output_hash = sha(canonical(bodyOf(f.args.envelope)));
  f.args.record.receipt_sha256 = f.args.envelope.receipt_sha256;
  f.args.record.body_sha256 = f.p.output_hash;
}

test('redteam_r1 an old receipt with a matching quote stays attested and is flagged stale', async () => {
  const f = fixture();
  const old = '2020-01-01T00:00:00Z';
  f.args.envelope.valuation_time = old;
  f.p.timestamp = Math.floor(Date.parse(old) / 1000);
  reseal(f);
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'attested');
  assert.equal(out.reason, 'ok');
  assert.equal(out.stale, true);
  assert.ok(out.receipt_age_days >= 7);
});

test('redteam_r1 a quote far from valuation_time is unbound', async () => {
  const f = fixture();
  const anchor = Math.floor(Date.parse(f.args.envelope.valuation_time) / 1000);
  f.p.timestamp = anchor - QUOTE_RUN_WINDOW_SEC.before - 60;
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'attestation_unbound');
});

test('redteam_r1 a quote past the run window is rejected', async () => {
  const f = fixture();
  const anchor = Math.floor(Date.parse(f.args.envelope.valuation_time) / 1000);
  f.p.timestamp = anchor + QUOTE_RUN_WINDOW_SEC.after + 60;
  const late = await matchWithCapabilities(f.args, f.caps);
  assert.equal(late.status, 'invalid');
  assert.equal(late.reason, 'attestation_unbound');
  const inside = fixture();
  const anchor2 = Math.floor(Date.parse(inside.args.envelope.valuation_time) / 1000);
  inside.p.timestamp = anchor2 + QUOTE_RUN_WINDOW_SEC.after;
  assert.equal((await matchWithCapabilities(inside.args, inside.caps)).status, 'attested');
});

test('redteam_r1 caller fund_id is required', async () => {
  const f = fixture();
  delete f.args.context.fund_id;
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'fund_id_unbound');
});
