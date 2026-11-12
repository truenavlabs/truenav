// certify/key-audit.mjs against a local fake RPC: report, single-key check, DeleteKey preparation, and read-only behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KeyPair, decodeTransaction, baseEncode } from "near-api-js";

const cli = fileURLToPath(new URL("./key-audit.mjs", import.meta.url));
const pub = () => KeyPair.fromRandom("ed25519").getPublicKey().toString();
const pk58 = (p) => `ed25519:${baseEncode(new Uint8Array(p.ed25519Key.data))}`;
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(9));
const ACCOUNT = "registry.keyaudit-test.testnet";

function fakeRpc(keys) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      calls.push({ method: j.method, request_type: j.params?.request_type });
      let result;
      if (j.method === "query" && j.params.request_type === "view_access_key_list") {
        result = { block_hash: BLOCK_HASH, block_height: 4242, keys };
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { message: `unexpected ${j.method}` } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
const fa = (public_key, nonce) => ({ public_key, access_key: { nonce, permission: "FullAccess" } });
const fc = (public_key, nonce) => ({ public_key, access_key: { nonce, permission: { FunctionCall: { allowance: null, receiver_id: ACCOUNT, method_names: ["pledge_loan"] } } } });

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function withRpc(keys, fn) {
  const r = await fakeRpc(keys);
  try { return await fn(r); } finally { r.server.close(); }
}

test("report lists every key, its permission and the full-access count, and prepares nothing without a hint", async () => {
  const [a, b, c] = [pub(), pub(), pub()];
  await withRpc([fa(a, 100), fa(b, 200), fc(c, 5)], async ({ url }) => {
    const r = await run(["--contract", ACCOUNT, "--rpc", url]);
    assert.equal(r.code, 0, r.stderr);
    for (const k of [a, b, c]) assert.ok(r.stdout.includes(k));
    assert.match(r.stdout, /full-access keys: 2/);
    assert.match(r.stdout, /FunctionCall .* \[pledge_loan\]/);
    assert.match(r.stdout, /no transaction prepared: the chain does not say which/);
    assert.doesNotMatch(r.stdout, /unsigned DeleteKey transaction/);
  });
});

test("--check passes with exactly one full-access key and fails with two or none", async () => {
  const [a, b, c] = [pub(), pub(), pub()];
  await withRpc([fa(a, 1), fc(c, 5)], async ({ url }) => {
    const r = await run(["--check", "--contract", ACCOUNT, "--rpc", url]);
    assert.equal(r.code, 0); assert.match(r.stdout, /PASS .* 1 full-access key/);
  });
  await withRpc([fa(a, 1), fa(b, 2)], async ({ url }) => {
    const r = await run(["--check", "--contract", ACCOUNT, "--rpc", url]);
    assert.equal(r.code, 1); assert.match(r.stdout, /FAIL .* 2 full-access keys/);
  });
  await withRpc([fc(c, 5)], async ({ url }) => {
    const r = await run(["--check", "--contract", ACCOUNT, "--rpc", url]);
    assert.equal(r.code, 1); assert.match(r.stdout, /FAIL .* 0 full-access keys, expected exactly 1/);
  });
});

test("--check takes several --contract values and fails if any one of them is wrong", async () => {
  const [a, b] = [pub(), pub()];
  await withRpc([fa(a, 1)], async ({ url }) => {
    const r = await run(["--check", "--contract", ACCOUNT, "--contract", "tnlab-keyaudit-test.testnet", "--rpc", url]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((r.stdout.match(/^PASS /gm) || []).length, 2);
  });
  await withRpc([fa(a, 1), fa(b, 2)], async ({ url }) => {
    const r = await run(["--check", "--contract", ACCOUNT, "--contract", "tnlab-keyaudit-test.testnet", "--rpc", url]);
    assert.equal(r.code, 1);
    assert.equal((r.stdout.match(/^FAIL /gm) || []).length, 2);
  });
  // several accounts are only for --check
  assert.equal((await run(["--contract", ACCOUNT, "--contract", "tnlab-keyaudit-test.testnet"])).code, 2);
});

test("--backup-key or --owner-key with exactly two full-access keys prints the exact DeleteKey transaction", async () => {
  const [owner, backup] = [pub(), pub()];
  for (const hint of [["--backup-key", backup], ["--owner-key", owner]]) {
    await withRpc([fa(owner, 700), fa(backup, 900)], async ({ url }) => {
      const r = await run(["--contract", ACCOUNT, "--rpc", url, ...hint]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`owner key \\(stays\\):\\s+${owner}`));
      assert.match(r.stdout, new RegExp(`backup key \\(removed\\):\\s+${backup}`));
      assert.match(r.stdout, /NOT SENT/);
      const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.indexOf("\n}\n") + 2));
      assert.deepEqual(json, { signer_id: ACCOUNT, public_key: owner, receiver_id: ACCOUNT, nonce: "701", block_hash: BLOCK_HASH, actions: [{ DeleteKey: { public_key: backup } }] });
      // the base64 bytes decode to the same transaction
      const b64 = /borsh, base64: (\S+)/.exec(r.stdout)[1];
      const tx = decodeTransaction(Buffer.from(b64, "base64"));
      assert.equal(tx.signerId, ACCOUNT); assert.equal(tx.receiverId, ACCOUNT); assert.equal(tx.nonce, 701n);
      assert.equal(pk58(tx.publicKey), owner);
      assert.equal(tx.actions.length, 1); assert.equal(pk58(tx.actions[0].deleteKey.publicKey), backup);
    });
  }
});

test("a hint that is not a full-access key on the account, or three full-access keys, prepares nothing", async () => {
  const [a, b, c, d] = [pub(), pub(), pub(), pub()];
  await withRpc([fa(a, 1), fa(b, 2), fc(c, 3)], async ({ url }) => {
    const r = await run(["--contract", ACCOUNT, "--rpc", url, "--backup-key", c]);
    assert.equal(r.code, 2); assert.match(r.stderr, /not a full-access key on this account/);
    const r2 = await run(["--contract", ACCOUNT, "--rpc", url, "--owner-key", d]);
    assert.equal(r2.code, 2);
  });
  await withRpc([fa(a, 1), fa(b, 2), fa(c, 3)], async ({ url }) => {
    const r = await run(["--contract", ACCOUNT, "--rpc", url, "--backup-key", b]);
    assert.equal(r.code, 0); assert.match(r.stdout, /exactly 2/); assert.doesNotMatch(r.stdout, /unsigned DeleteKey transaction/);
  });
});

test("a secret key is refused and never echoed, and bad arguments exit 2", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const secret = kp.toString();
  const r = await run(["--contract", ACCOUNT, "--backup-key", secret]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /SECRET key/);
  assert.ok(!r.stdout.includes(secret.slice(8)) && !r.stderr.includes(secret.slice(8)));
  for (const bad of [["--nope"], ["--backup-key"], ["--backup-key", "not-a-key"], ["--check", "--owner-key", pub()], ["--owner-key", "ed25519:abc"]]) {
    assert.equal((await run(bad)).code, 2, JSON.stringify(bad));
  }
});

test("only view_access_key_list queries reach the RPC: nothing is signed or broadcast", async () => {
  const [owner, backup] = [pub(), pub()];
  await withRpc([fa(owner, 1), fa(backup, 2)], async ({ url, calls }) => {
    await run(["--contract", ACCOUNT, "--rpc", url, "--backup-key", backup]);
    await run(["--check", "--contract", ACCOUNT, "--rpc", url]);
    assert.ok(calls.length >= 2);
    for (const c of calls) { assert.equal(c.method, "query"); assert.equal(c.request_type, "view_access_key_list"); }
  });
  // the source has no way to sign or send
  const src = (await import("node:fs")).readFileSync(cli, "utf8");
  assert.doesNotMatch(src, /broadcast_tx|send_tx|signTransaction|signAndSend|KeyPair\b|private_key/);
});
