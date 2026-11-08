// Operator scripts: RPC errors are redacted (no URL, host, path or query in any output), a pending or reorged
// transaction is retried, and the mirror and MPC addresses come from the receipts contract. Local only: a fake RPC
// on 127.0.0.1 stands in for NEAR and Base; no live network, no keys beyond a throwaway test key.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { HttpRequestError, TimeoutError, TransactionReceiptNotFoundError } from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { KeyPair } from 'near-api-js';
import { guardClient, safeMessage, RedactedError } from '../safe.mjs';
import { mirrorAddresses, parseArgs } from '../config.mjs';
import { confirmFinalized, waitForFinality } from '../confirm.mjs';
import { PATH } from '../abi.mjs';

const vectors = JSON.parse(await readFile(new URL('../fixtures/vectors.json', import.meta.url), 'utf8'));
const v = vectors[0];
const event = { nonce: v.nonce, seq: v.seq, signed_tx: v.signed, tx_hash: v.tx_hash };
const KEY = 'FAKEKEY-9f3b2c71d0e44a8b';
const RECEIPTS = 'receipts.fake.testnet';
const ADMIN = 'admin.fake.testnet';
const leakFree = (text) => !text.includes(KEY) && !text.includes('/v2/') && !text.includes('apikey') && !text.includes('base-sepolia.fake');

// a fake MPC root whose derivation for RECEIPTS is the fixture's signing key (root = child - tweak * G)
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let s = ''; while (n > 0n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; } return s; };
const tweak = BigInt('0x' + Buffer.from(sha3_256(new TextEncoder().encode(`near-mpc-recovery v0.1.0 epsilon derivation:${RECEIPTS},${PATH}`))).toString('hex')) % secp256k1.Point.Fn.ORDER;
const child = secp256k1.Point.fromBytes(Buffer.concat([Buffer.from([4]), Buffer.from(v.public_key, 'hex')]));
const root = child.subtract(secp256k1.Point.BASE.multiply(tweak)).toBytes(false).slice(1);
const ROOT = `secp256k1:${b58(root)}`;
const DERIVED = `secp256k1:${b58(Buffer.from(v.public_key, 'hex'))}`;
const MIRROR_CONFIG = { config: { chain_id: 84532, mirror_address: v.to, fee_cap: 100000000000, public_key: v.public_key }, next_nonce: 0, pending: 0 };
const views = { [`${RECEIPTS}.get_mirror_config`]: MIRROR_CONFIG, [`${RECEIPTS}.get_config`]: { admin: ADMIN }, 'v1.signer-prod.testnet.public_key': ROOT, 'v1.signer-prod.testnet.derived_public_key': DERIVED };
const fakeView = async (c, m) => { const k = `${c}.${m}`; if (!(k in views)) throw Error(`no view ${k}`); return views[k]; };

// one local server: /near is a NEAR JSON-RPC, /fail/... answers 500, /hang/... never answers
const hanging = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/fail/')) { res.writeHead(500); res.end('boom'); return; }
    if (req.url.startsWith('/hang/')) { hanging.push(res); return; }
    const { id, method, params } = JSON.parse(body);
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
    if (method === 'status') return reply({ chain_id: 'testnet', version: { version: 'fake', build: 'fake' }, sync_info: {}, validators: [] });
    if (method === 'query' && params.request_type === 'call_function') {
      const k = `${params.account_id}.${params.method_name}`;
      return reply({ result: [...Buffer.from(JSON.stringify(views[k] ?? null))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' });
    }
    res.writeHead(400); res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const NEAR = `http://127.0.0.1:${PORT}/near`;
const dir = await mkdtemp(join(tmpdir(), 'truenav-mirror-scripts-'));
const logs = join(dir, 'logs.json');
await writeFile(logs, JSON.stringify(['EVENT_JSON:' + JSON.stringify({ standard: 'truenav-receipts', version: '1.0.0', event: 'mirror_signed', data: [event] })]));
const keyfile = join(dir, 'admin.json');
await writeFile(keyfile, JSON.stringify({ account_id: ADMIN, private_key: KeyPair.fromRandom('ed25519').toString() }), { mode: 0o600 });
after(async () => { hanging.forEach((r) => r.destroy()); server.close(); await rm(dir, { recursive: true, force: true }); });

function run(script, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL(`../${script}`, import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, TRUENAV_RPC: NEAR, TRUENAV_RECEIPTS_ACCOUNT: RECEIPTS, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const keyedUrl = (kind) => `http://127.0.0.1:${PORT}/${kind}/v2/${KEY}?apikey=${KEY}`;

test('guarded Base calls turn HttpRequestError and TimeoutError into a fixed message with no URL, key or cause', async () => {
  const url = `https://base-sepolia.fake.example/v2/${KEY}?apikey=${KEY}`;
  for (const [cls, make] of [['HttpRequestError', () => new HttpRequestError({ url, body: { method: 'eth_chainId' }, status: 500, details: `bad ${KEY}` })], ['TimeoutError', () => new TimeoutError({ url, body: { method: 'eth_chainId' } })]]) {
    const raw = make();
    assert.ok(raw.message.includes(KEY), 'viem itself puts the URL in the message');
    const client = guardClient({ getChainId: async () => { throw raw; } });
    const e = await client.getChainId().catch((x) => x);
    assert.ok(e instanceof RedactedError);
    assert.equal(e.message, `base rpc error: ${cls}`);
    assert.equal(e.cause, undefined);
    for (const text of [e.message, String(e.stack), inspect(e, { depth: 5 }), safeMessage(e)]) assert.ok(leakFree(text), text);
  }
  // an unexpected error with a URL in it is scrubbed too
  assert.ok(leakFree(safeMessage(new Error(`fetch failed for https://base-sepolia.fake.example/v2/${KEY}`))));
  assert.ok(leakFree(safeMessage(new Error(`dial base-sepolia.fake.example:443/v2/${KEY}`))));
});

test('broadcast CLI: a 500 and a timeout from a keyed BASE_RPC_URL print only the redacted line, exit 1', async () => {
  for (const [kind, cls] of [['fail', 'HttpRequestError'], ['hang', 'TimeoutError']]) {
    const r = await run('broadcast.mjs', [logs, '--execute'], { BASE_RPC_URL: keyedUrl(kind), BASE_RPC_TIMEOUT_MS: '300' });
    assert.equal(r.code, 1, r.err);
    assert.equal(r.err.trim(), `base rpc error: ${cls}`);
    assert.equal(r.out, '');
    assert.ok(leakFree(r.out + r.err), r.out + r.err);
  }
});

test('confirm CLI: a 500 and a timeout from a keyed BASE_RPC_URL print only the redacted line, nothing is confirmed', async () => {
  for (const [kind, cls] of [['fail', 'HttpRequestError'], ['hang', 'TimeoutError']]) {
    const r = await run('confirm.mjs', [logs, '--execute'], { BASE_RPC_URL: keyedUrl(kind), BASE_RPC_TIMEOUT_MS: '300', TRUENAV_ADMIN_ACCOUNT: ADMIN, TRUENAV_SIGNER_KEYFILE: keyfile });
    assert.equal(r.code, 1, r.err);
    assert.equal(r.err.trim(), `base rpc error: ${cls}`);
    assert.ok(leakFree(r.out + r.err), r.out + r.err);
  }
});

test('CLIs read the addresses from get_mirror_config; a differing --mirror or --mpc, or a URL argument, aborts', async () => {
  const dry = await run('broadcast.mjs', [logs], {});
  assert.equal(dry.code, 0, dry.err);
  const out = JSON.parse(dry.out);
  assert.deepEqual([out.dry_run, out.mirror_address, out.mpc_address], [true, `0x${v.to}`, v.mpc_address.toLowerCase()]);
  assert.equal((await run('confirm.mjs', [logs, '--mirror', `0x${v.to}`, '--mpc', v.mpc_address], {})).code, 0, 'matching assertions pass');
  for (const [args, msg] of [[['--mirror', '0x' + '22'.repeat(20)], '--mirror differs'], [['--mpc', '0x' + '33'.repeat(20)], '--mpc differs']]) {
    for (const script of ['broadcast.mjs', 'confirm.mjs']) {
      const r = await run(script, [logs, ...args, '--execute'], { BASE_RPC_URL: keyedUrl('fail') });
      assert.equal(r.code, 1);
      assert.match(r.err, new RegExp(msg));
    }
  }
  const url = await run('broadcast.mjs', [logs, `https://base-sepolia.fake.example/v2/${KEY}`], {});
  assert.equal(url.code, 1);
  assert.match(url.err, /BASE_RPC_URL/);
  assert.ok(leakFree(url.out + url.err), url.err);
  const unset = await run('broadcast.mjs', [logs, '--execute'], {});
  assert.match(unset.err, /BASE_RPC_URL is not set/);
});

test('mirrorAddresses refuses a config key that is not the MPC derivation for the receipts account', async () => {
  const good = await mirrorAddresses({ view: fakeView, receipts: RECEIPTS });
  assert.deepEqual(good, { mirrorAddress: `0x${v.to}`, mpcAddress: v.mpc_address.toLowerCase(), pending: 0 });
  const wrongKey = async (c, m) => (m === 'get_mirror_config' ? { ...MIRROR_CONFIG, config: { ...MIRROR_CONFIG.config, public_key: 'ab'.repeat(64) } } : fakeView(c, m));
  await assert.rejects(mirrorAddresses({ view: wrongKey, receipts: RECEIPTS }), /not the MPC key derived/);
  await assert.rejects(mirrorAddresses({ view: async () => null, receipts: RECEIPTS }), /no valid mirror config/);
  assert.throws(() => parseArgs([logs, 'extra']), /BASE_RPC_URL/);
});

test('confirmer retries a pending (receipt not found) and a reorged receipt, then confirms once in the same safety order', async () => {
  const calls = [];
  const order = [];
  let step = 0;
  const client = {
    getChainId: async () => 84532,
    getTransactionReceipt: async ({ hash }) => {
      order.push('receipt');
      if (step === 0) throw new TransactionReceiptNotFoundError({ hash });
      return { transactionHash: '0x' + event.tx_hash, status: 'success', blockNumber: 10n, blockHash: step === 1 ? '0xold' : '0xnew' };
    },
    getBlock: async (a) => { order.push(a.blockTag ? 'finalized' : 'canonical'); return a.blockTag ? { number: 12n } : { hash: '0xnew' }; },
  };
  const near = { confirm: async (a) => { order.push('confirm'); calls.push(a); } };
  const ok = await waitForFinality(event, { client, near, mirrorAddress: `0x${v.to}`, mpcAddress: v.mpc_address }, { attempts: 4, delay: async () => { step++; } });
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ nonce: 0, tx_hash: event.tx_hash }]);
  assert.deepEqual(order, ['receipt', 'receipt', 'finalized', 'canonical', 'receipt', 'finalized', 'canonical', 'confirm']);
  // a reverted transaction is final and wrong: it throws, never retried into a confirm
  await assert.rejects(confirmFinalized(event, { client: { ...client, getTransactionReceipt: async () => ({ status: 'reverted', transactionHash: '0x' + event.tx_hash }) }, near, mirrorAddress: `0x${v.to}`, mpcAddress: v.mpc_address }), /successful mirror transaction required/);
  // any other RPC error is redacted and stops the wait
  const bad = { ...client, getTransactionReceipt: async () => { throw new HttpRequestError({ url: `https://x.fake.example/v2/${KEY}`, body: {} }); } };
  const e = await waitForFinality(event, { client: bad, near, mirrorAddress: `0x${v.to}`, mpcAddress: v.mpc_address }, { attempts: 2, delay: async () => {} }).catch((x) => x);
  assert.equal(e.message, 'base rpc error: HttpRequestError');
  assert.equal(calls.length, 1);
});
