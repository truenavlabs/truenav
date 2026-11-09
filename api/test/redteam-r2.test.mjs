// Red team round 2. Each test asserts the property that should hold.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {KeyPair} from 'near-api-js';
import {createServer, queryHash, spendMessage} from '../server.mjs';
import {canonical} from '../receipt.mjs';

const v3 = JSON.parse(readFileSync(new URL('../../schema/vectors/engine-v3-derived.json', import.meta.url))).vectors[0].envelope;
const record = (e, score = e.score) => ({token_id: e.token_id, seq: Number(e.seq), method: e.method_version, version_key: e.engine_version_key, score, band: e.band, caps: e.caps, holds: e.holds, period: `${e.period_start}/${e.period_end}`, as_of: e.valuation_time, receipt_sha256: e.receipt_sha256, receipt: JSON.stringify(e), block_height: 100});
const sha = (s) => createHash('sha256').update(s).digest('hex');

const buyerKey = KeyPair.fromRandom('ed25519');
const buyerSig = (id, kind, token) => Buffer.from(buyerKey.sign(spendMessage(id, kind, token)).signature).toString('base64');
function queryChain(rec, {redeemDelayMs = 0} = {}) {
  const ents = new Map();
  let redeemCalls = 0;
  return {
    ents,
    redeemCalls: () => redeemCalls,
    buy(buyer, id, kind, token) { ents.set(id, {request_id: id, buyer, kind, query_hash: queryHash(kind, token), expires_ns: '999999999999999999999', uses_left: kind === 'report' ? 1 : 20}); },
    chain: {
      async view(_c, m, a) { if (m === 'get_latest') return rec; if (m === 'get_entitlement') { const e = ents.get(a.request_id); return e ? {...e} : null; } return null; },
      async accessKeys(account) { return account === 'buyer.testnet' ? [{public_key: buyerKey.getPublicKey().toString()}] : []; },
      async nowNs() { return 0n; },
      async redeem(id, qh) {
        redeemCalls++;
        await new Promise((r) => setTimeout(r, redeemDelayMs));
        const e = ents.get(id);
        if (!e || e.query_hash !== qh || e.uses_left < 1) throw new Error('entitlement already used');
        e.uses_left -= 1; return e.uses_left;
      },
    },
  };
}
async function serve(chain, fn) {
  const s = createServer({chain, receipts: 'receipts.test', query: 'query.test', fee: '1'});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${s.address().port}`); } finally { await new Promise((r) => s.close(r)); }
}

test('redteam_r2 RT2-05 an entitlement id seen on chain must not be spendable by someone else', async () => {
  const q = queryChain(record(v3));
  q.buy('buyer.testnet', 'buyer-report-0001', 'report', v3.token_id);
  await serve(q.chain, async (url) => {
    // The public buy_query transaction shows the request id and the buyer account. Neither is a proof.
    // The attached repro sent two identical requests, which cannot tell the buyer from the attacker.
    // The buyer signs truenav-spend with a key on their account. The attacker does not.
    const stolen = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: {'x-truenav-entitlement': 'buyer-report-0001'}});
    const named = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: {'x-truenav-entitlement': 'buyer-report-0001', 'x-truenav-buyer': 'buyer.testnet'}});
    const victim = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: {'x-truenav-entitlement': 'buyer-report-0001', 'x-truenav-buyer': 'buyer.testnet', 'x-truenav-buyer-sig': buyerSig('buyer-report-0001', 'report', v3.token_id)}});
    assert.notEqual(named.status, 200, 'the public buyer account id was enough to spend');
    assert.notEqual(stolen.status, 200, 'API served a paid report to a caller who never proved they are the buyer');
    assert.equal(victim.status, 200, `the buyer lost the paid use (status ${victim.status})`);
    assert.equal(q.redeemCalls(), 1);
  });
});

test('redteam_r2 RT2-06 concurrent reports on one single-use entitlement must send at most one redeem tx', async () => {
  const q = queryChain(record(v3), {redeemDelayMs: 50});
  q.buy('buyer.testnet', 'buyer-report-0002', 'report', v3.token_id);
  await serve(q.chain, async (url) => {
    const headers = {'x-truenav-entitlement': 'buyer-report-0002', 'x-truenav-buyer': 'buyer.testnet', 'x-truenav-buyer-sig': buyerSig('buyer-report-0002', 'report', v3.token_id)};
    const rs = await Promise.all(Array.from({length: 25}, () => fetch(`${url}/fund/${v3.token_id}/report`, {headers})));
    const ok = rs.filter((r) => r.status === 200).length;
    assert.equal(ok, 1);
    assert.ok(q.redeemCalls() <= 1, `one paid use made the redeemer sign ${q.redeemCalls()} transactions (gas paid by the API account)`);
  });
});

test('redteam_r2 RT2-11 a stored verification_failed receipt must not be reported as run_failed', async () => {
  const e = structuredClone(v3);
  Object.assign(e, {status: 'verification_failed', score: null, band: 'red', caps: [], holds: ['source_signature_invalid']});
  const {receipt_sha256, ...pre} = e; e.receipt_sha256 = sha(canonical(pre));
  const q = queryChain(record(e, 0));
  await serve(q.chain, async (url) => {
    const r = await fetch(`${url}/fund/${e.token_id}/score`);
    const body = await r.json();
    assert.equal(r.status, 200, `a valid stored receipt was answered ${r.status} ${JSON.stringify(body)}, its hold is hidden`);
    assert.deepEqual(body.holds, ['source_signature_invalid']);
  });
});

test('redteam_r2 RT2-08 the agent must not approve a receipt whose TEE attestation was never checked', async () => {
  const {decide} = await import('../../agent/agent.mjs');
  const e = structuredClone(v3);
  e.valuation_time = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); e.holds = [];
  const {receipt_sha256, ...pre} = e; e.receipt_sha256 = sha(canonical(pre));
  const d = decide(e.token_id, record(e));
  assert.notEqual(d.action, 'approve', `approved on the receipt hash alone (${JSON.stringify(d)}); attestation_ref is null and no proof was matched`);
});

test('redteam_r2 RT2-14 a malformed percent-escape is a client error, not a chain failure', async () => {
  const q = queryChain(record(v3));
  await serve(q.chain, async (url) => {
    const r = await fetch(`${url}/fund/%E0%A4%A/score`);
    assert.equal(r.status, 400, `got ${r.status} ${await r.text()}`);
  });
});
