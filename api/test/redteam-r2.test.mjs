// Red team round 2. Each test asserts the property that should hold.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {KeyPair} from 'near-api-js';
import {createServer, queryHash, spendMessage, BUYER_LIMIT} from '../server.mjs';
import {initSpendStore, reserveSpend} from '../spend-store.mjs';
import {canonical} from '../receipt.mjs';

const v3 = JSON.parse(readFileSync(new URL('../../schema/vectors/engine-v3-derived.json', import.meta.url))).vectors[0].envelope;
const record = (e, score = e.score) => ({token_id: e.token_id, seq: Number(e.seq), method: e.method_version, version_key: e.engine_version_key, score, band: e.band, caps: e.caps, holds: e.holds, period: `${e.period_start}/${e.period_end}`, as_of: e.valuation_time, receipt_sha256: e.receipt_sha256, receipt: JSON.stringify(e), block_height: 100});
const sha = (s) => createHash('sha256').update(s).digest('hex');

const buyerKey = KeyPair.fromRandom('ed25519');
const EXP = '60000';
const buyerProof = (id, kind, token, {audience = 'query.test', nonce = randomBytes(16).toString('hex'), exp = EXP} = {}) => {
  const sig = Buffer.from(buyerKey.sign(spendMessage({audience, id, kind, token, nonce, exp})).signature).toString('base64');
  return {nonce, exp, sig, headers: {'x-truenav-entitlement': id, 'x-truenav-buyer': 'buyer.testnet', 'x-truenav-buyer-sig': sig, 'x-truenav-buyer-nonce': nonce, 'x-truenav-buyer-exp': exp}};
};
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
async function serve(chain, fn, spendStore = initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-r2-'))), opts = {}) {
  try { initSpendStore(spendStore); } catch (error) { if (error.code !== 'spend_store_closed') throw error; }
  const s = createServer({chain, receipts: 'receipts.test', query: 'query.test', fee: '1', spendStore, ...opts});
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${s.address().port}`, spendStore); } finally { await new Promise((r) => s.close(r)); }
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
    const victim = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: buyerProof('buyer-report-0001', 'report', v3.token_id).headers});
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
    const headers = buyerProof('buyer-report-0002', 'report', v3.token_id).headers;
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
  e.valuation_time = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); e.holds = []; e.caps = [];
  const {receipt_sha256, ...pre} = e; e.receipt_sha256 = sha(canonical(pre));
  const d = decide(e.token_id, record(e));
  assert.equal(d.action, 'review');
  assert.equal(d.reason, 'unattested');
  assert.match(d.detail, /unattested/);
  e.attestation_ref = 'https://testnet-api.outlayer.ai/attestations/by-request/9';
  const {receipt_sha256: _drop, ...pre2} = e; e.receipt_sha256 = sha(canonical(pre2));
  const named = decide(e.token_id, record(e));
  assert.notEqual(named.action, 'approve', `a non-empty unverified ref was treated as a pass (${JSON.stringify(named)})`);
  assert.equal(named.reason, 'unattested');
});

test('redteam_r2 N6 spend proof rejects expiry, wrong audience, replay and buyer rate', async () => {
  const q = queryChain(record(v3));
  const file = initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-n6-')));
  q.buy('buyer.testnet', 'buyer-report-0003', 'report', v3.token_id);
  const replay = buyerProof('buyer-report-0003', 'report', v3.token_id);
  await serve(q.chain, async (url) => {
    const expired = buyerProof('buyer-report-0003', 'report', v3.token_id, {exp: '0'});
    const old = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: expired.headers});
    assert.equal(old.status, 403, `expired proof was accepted (${old.status})`);
    const foreign = buyerProof('buyer-report-0003', 'report', v3.token_id, {audience: 'other.near'});
    const wrong = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: foreign.headers});
    assert.notEqual(wrong.status, 200, 'a proof for another audience was accepted');
    const first = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: replay.headers});
    assert.equal(first.status, 200, await first.text());
  }, file);
  q.buy('buyer.testnet', 'buyer-report-0003', 'report', v3.token_id);
  await serve(q.chain, async (url) => {
    const again = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: replay.headers});
    assert.equal(again.status, 403, `a reused nonce survived a new process (${again.status})`);
    const body = await again.json();
    assert.equal(body.error, 'spend nonce reused');
  }, file);
  const limited = queryChain(record(v3));
  for (let i = 0; i < BUYER_LIMIT + 1; i++) limited.buy('buyer.testnet', `buyer-rate-${String(i).padStart(4, '0')}`, 'report', v3.token_id);
  await serve(limited.chain, async (url) => {
    const statuses = [];
    for (let i = 0; i < BUYER_LIMIT + 1; i++) {
      const id = `buyer-rate-${String(i).padStart(4, '0')}`;
      const res = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: buyerProof(id, 'report', v3.token_id).headers});
      statuses.push(res.status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, BUYER_LIMIT);
    assert.equal(statuses[BUYER_LIMIT], 429);
  });
});

function raceWorker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL('./spend-race-worker.mjs', import.meta.url).pathname, ...args], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => resolve({code, out: out.trim()}));
  });
}

test('redteam_r2 N6 two processes never accept one nonce twice', async () => {
  const dir = initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-race-')));
  for (let i = 0; i < 120; i++) {
    const nonce = `race${i.toString(16).padStart(16, '0')}`;
    const pair = await Promise.all([0, 1].map(() => raceWorker([dir, 'once', nonce, 'buyer.testnet', '5000', '65000', '1', '100000'])));
    const accepts = pair.filter((row) => row.out === 'accept').length;
    assert.equal(accepts, 1, `trial ${i} accepted ${accepts} times (${pair.map((row) => row.out).join(' | ')})`);
  }
});

test('redteam_r2 N6 two processes cannot overshoot the buyer rate limit', async () => {
  const dir = initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-rate-')));
  const pair = await Promise.all(['A', 'B'].map((prefix) => raceWorker([dir, 'burst', prefix, 'buyer.testnet', '5000', '65000', '8'])));
  const total = pair.reduce((sum, row) => sum + Number(row.out), 0);
  assert.equal(total, BUYER_LIMIT, pair.map((row) => row.out).join(' '));
});

test('redteam_r2 N6 a corrupt or deleted store fails closed and is not reset', async () => {
  const dir = initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-closed-')));
  const state = join(dir, 'state.json');
  writeFileSync(state, '{not json');
  const q = queryChain(record(v3));
  q.buy('buyer.testnet', 'buyer-closed-0001', 'report', v3.token_id);
  await serve(q.chain, async (url) => {
    const res = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: buyerProof('buyer-closed-0001', 'report', v3.token_id).headers});
    assert.equal(res.status, 503);
    assert.equal(readFileSync(state, 'utf8'), '{not json');
  }, dir);
  unlinkSync(state);
  await serve(q.chain, async (url) => {
    const res = await fetch(`${url}/fund/${v3.token_id}/report`, {headers: buyerProof('buyer-closed-0001', 'report', v3.token_id).headers});
    assert.equal(res.status, 503);
    assert.equal(existsSync(state), false);
  }, dir);
});

test('redteam_r2 N6 bad report traffic is limited before any chain view', async () => {
  let views = 0;
  const q = queryChain(record(v3));
  const inner = q.chain.view.bind(q.chain);
  q.chain.view = async (...args) => { views += 1; return inner(...args); };
  await serve(q.chain, async (url) => {
    const headers = {'x-truenav-entitlement': 'buyer-report-0001', 'x-truenav-buyer': 'buyer.testnet'};
    const rs = await Promise.all(Array.from({length: 200}, () => fetch(`${url}/fund/${v3.token_id}/report`, {headers})));
    const limited = rs.filter((r) => r.status === 429).length;
    assert.ok(limited > 100, `only ${limited} of 200 were limited`);
    assert.ok(views < 80, `bad traffic made ${views} RPC views`);
  }, initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-ip-'))), {preIpLimit: 20, preBuyerLimit: 20});
});

test('redteam_r2 N6 expired buyers and nonces are pruned', () => {
  const dir = initSpendStore(mkdtempSync(join(tmpdir(), 'truenav-prune-')));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({v: 1, nonces: {old: 1, keep: 200000}, buyers: {gone: [0], stay: [90000]}}));
  const result = reserveSpend(dir, {buyer: 'stay', nonce: 'fresh', nowMs: 100000, exp: 160000, limit: 8, windowMs: 60000});
  assert.equal(result.ok, true);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(state.nonces.old, undefined);
  assert.equal(state.buyers.gone, undefined);
  assert.ok(state.buyers.stay.includes(90000));
});

test('redteam_r2 N6 production refuses to start without TRUENAV_SPEND_STORE', async () => {
  const {spawnSync} = await import('node:child_process');
  const child = spawnSync(process.execPath, [new URL('../main.mjs', import.meta.url).pathname], {encoding: 'utf8'});
  assert.equal(child.status, 2);
  assert.match(child.stderr, /TRUENAV_SPEND_STORE/);
});

test('redteam_r2 RT2-14 a malformed percent-escape is a client error, not a chain failure', async () => {
  const q = queryChain(record(v3));
  await serve(q.chain, async (url) => {
    const r = await fetch(`${url}/fund/%E0%A4%A/score`);
    assert.equal(r.status, 400, `got ${r.status} ${await r.text()}`);
  });
});
