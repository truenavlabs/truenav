// Round 1b. Simulated quote capability only. No live attestation is fetched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from '../../api/server.mjs';
import {matchWithCapabilities, bodyOf, canonical, sha, QUOTE_RUN_WINDOW_SEC, RECEIPT_STALE_AFTER_SEC} from './match-core.mjs';
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

function reseal(f) {
  const {receipt_sha256: _dropped, ...preimage} = f.args.envelope;
  f.args.envelope.receipt_sha256 = sha(canonical(preimage));
  f.p.output_hash = sha(canonical(bodyOf(f.args.envelope)));
  f.args.record.receipt_sha256 = f.args.envelope.receipt_sha256;
  f.args.record.body_sha256 = f.p.output_hash;
}

test('redteam_r1b quote window is inclusive at both edges', async () => {
  const early = fixture();
  const anchor = Math.floor(Date.parse(early.args.envelope.valuation_time) / 1000);
  early.p.timestamp = anchor - QUOTE_RUN_WINDOW_SEC.before;
  assert.equal((await matchWithCapabilities(early.args, early.caps)).status, 'attested');
  const just_out = fixture();
  just_out.p.timestamp = anchor - QUOTE_RUN_WINDOW_SEC.before - 1;
  const out = await matchWithCapabilities(just_out.args, just_out.caps);
  assert.equal(out.status, 'invalid');
  assert.equal(out.reason, 'attestation_unbound');
  const late = fixture();
  late.p.timestamp = anchor + QUOTE_RUN_WINDOW_SEC.after;
  assert.equal((await matchWithCapabilities(late.args, late.caps)).status, 'attested');
  const past = fixture();
  past.p.timestamp = anchor + QUOTE_RUN_WINDOW_SEC.after + 1;
  const past_out = await matchWithCapabilities(past.args, past.caps);
  assert.equal(past_out.status, 'invalid');
  assert.equal(past_out.reason, 'attestation_unbound');
});

test('redteam_r1b a quote that is not UpToDate is not attested', async () => {
  for (const status of ['OutOfDate', 'Revoked', 'SWHardeningNeeded']) {
    const f = fixture();
    f.caps.verifyQuote = async () => ({status});
    const out = await matchWithCapabilities(f.args, f.caps);
    assert.notEqual(out.status, 'attested', status);
  }
});

test('redteam_r1b receipt age is reported and is not a validity failure', async () => {
  const stale = fixture();
  const old = Math.floor(Date.now() / 1000) - RECEIPT_STALE_AFTER_SEC - 30;
  stale.args.envelope.valuation_time = new Date(old * 1000).toISOString().replace('.000Z', 'Z');
  stale.p.timestamp = old;
  reseal(stale);
  const out = await matchWithCapabilities(stale.args, stale.caps);
  assert.equal(out.status, 'attested');
  assert.equal(out.stale, true);
  const fresh = fixture();
  const recent = Math.floor(Date.now() / 1000) - 3600;
  fresh.args.envelope.valuation_time = new Date(recent * 1000).toISOString().replace('.000Z', 'Z');
  fresh.p.timestamp = recent;
  reseal(fresh);
  const young = await matchWithCapabilities(fresh.args, fresh.caps);
  assert.equal(young.status, 'attested');
  assert.equal(young.stale, false);
});

test('redteam_r1b empty envelope fund_id does not fall back to token_id', async () => {
  const f = fixture();
  f.args.envelope.fund_id = '';
  f.args.context.fund_id = f.args.envelope.token_id;
  reseal(f);
  const out = await matchWithCapabilities(f.args, f.caps);
  assert.notEqual(out.status, 'attested');
  assert.equal(out.reason, 'fund_id_unbound');
});

test('redteam_r1b a failed head must not be served as the previous green score', async () => {
  const envelope = structuredClone(read('schema/vectors/engine-v3-derived.json').vectors[0].envelope);
  assert.equal(envelope.band, 'green');
  assert.ok(envelope.score >= 85);
  envelope.head_status = 'failed';
  const record = {
    token_id: envelope.token_id,
    seq: Number(envelope.seq),
    method: envelope.method_version,
    version_key: envelope.engine_version_key,
    score: 0,
    band: 'red',
    caps: envelope.caps,
    holds: envelope.holds,
    period: `${envelope.period_start}/${envelope.period_end}`,
    as_of: envelope.valuation_time,
    receipt: JSON.stringify(envelope),
    block_height: 1,
  };
  // fix 14 (F3): the wrapper hash is sha256 of the stored body, as the contract writes it; a failed head is only a
  // genuine run_failed (409) once it verifies. The same head under the old, non-matching hash is 502, still no score.
  record.receipt_sha256 = sha(record.receipt);
  const bad = {...record, receipt_sha256: envelope.receipt_sha256};
  assert.notEqual(bad.receipt_sha256, record.receipt_sha256);
  let served = record;
  const server = createServer({
    chain: {async view() { return served; }, async nowNs() { return 0n; }, async redeem() { return 0; }},
    receipts: 'receipts.test',
    query: 'query.test',
    fee: '1',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/fund/${envelope.token_id}/score`);
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.error, 'run_failed');
    assert.notEqual(body.score, envelope.score);
    served = bad;
    const badResponse = await fetch(`http://127.0.0.1:${server.address().port}/fund/${envelope.token_id}/score`);
    const badBody = await badResponse.json();
    assert.equal(badResponse.status, 502, JSON.stringify(badBody));
    assert.equal(badBody.error, 'receipt_sha256_mismatch');
    assert.equal(badBody.score, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
