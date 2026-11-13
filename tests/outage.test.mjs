// G12 outage behaviour: every chain-reading and attestation CLI, with its endpoint unreachable, prints one line that
// names the endpoint and says it is a network failure, exits 2, and prints no stack trace. Endpoints are pointed at
// http://127.0.0.1:9 (a port fetch refuses to use) or a closed local port through the scripts' env overrides; scripts
// with a fixed endpoint run under tests/fixtures/offline-fetch.mjs, so no request leaves the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { NetworkError, isNetworkError, nameEndpoint, networkSummary, describeEndpoint, failLine } from "../certify/net-guard.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OFFLINE = fileURLToPath(new URL("./fixtures/offline-fetch.mjs", import.meta.url));
const DEAD = "http://127.0.0.1:9";
const STACK = /^\s+at\s|node:internal|Node\.js v\d/m;

function run(args, env = {}, preload = false) {
  const r = spawnSync(process.execPath, [...(preload ? ["--import", OFFLINE] : []), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function closedPort() {
  const s = net.createServer();
  await new Promise((res) => s.listen(0, "127.0.0.1", res));
  const { port } = s.address();
  await new Promise((res) => s.close(res));
  return port;
}

// [name, argv, env overrides, endpoint label, override hint]
const DEAD_ALL = { TRUENAV_RPC: DEAD, TRUENAV_TX_API: "http://127.0.0.2:9", TRUENAV_OUTLAYER_API: DEAD, TRUENAV_PCCS_URL: "http://127.0.0.3:9", TRUENAV_NRAS_URL: "http://127.0.0.4:9" };
const CLIS = [
  ["chain:read", ["certify/chain-read.mjs"], "NEAR RPC", "TRUENAV_RPC"],
  ["check:chain-replies", ["certify/check-chain-replies.mjs"], "NEAR RPC", "TRUENAV_RPC"],
  ["rt17:check", ["certify/key-audit.mjs", "--check", "--contract", "registry.tnlab-368aa2.testnet", "--contract", "tnlab-368aa2.testnet"], "NEAR RPC", "TRUENAV_RPC"],
  ["tee:chain-check", ["tee/chain-check.mjs"], "NEAR RPC", "TRUENAV_RPC"],
  ["verify:live-signer", ["certify/verify-live-signer.mjs"], "NEAR RPC", "TRUENAV_RPC"],
  ["verify:fingerprints", ["tee/verify-fingerprints.mjs"], "NEAR RPC", "TRUENAV_RPC"],
  ["tee:tx-review", ["tee/tx-review.mjs", "11111111111111111111111111111111111111111111", "--sender", "a.testnet"], "NEAR RPC", "TRUENAV_RPC"],
];

for (const [name, argv, label, hint] of CLIS) {
  test(`${name}: unreachable ${label} gives one network-failure line, exit 2, no stack trace`, () => {
    const r = run(argv, DEAD_ALL);
    assert.equal(r.code, 2, r.err);
    const lines = r.err.trim().split("\n");
    assert.equal(lines.length, 1, r.err);
    assert.match(lines[0], new RegExp(`^network failure: could not reach ${label} at http://127\\.0\\.0\\.1:9 \\(bad port\\); set .*${hint}`));
    assert.doesNotMatch(r.err + r.out, STACK);
  });
}

test("verify:attestation: unreachable RPC, PCCS and NRAS end with one network-failure line naming all three, exit 2", () => {
  const r = run(["tee/verify-attestation.mjs"], DEAD_ALL);
  assert.equal(r.code, 2, r.err);
  assert.match(r.out, /Attestation NOT verified\./);
  const lines = r.err.trim().split("\n");
  assert.equal(lines.length, 1, r.err);
  assert.match(lines[0], /^network failure: could not reach NEAR RPC at http:\/\/127\.0\.0\.1:9 \(bad port\), PCCS collateral server at http:\/\/127\.0\.0\.3:9 \(bad port\), NRAS at http:\/\/127\.0\.0\.4:9 \(bad port\); set TRUENAV_RPC or TRUENAV_PCCS_URL or TRUENAV_NRAS_URL/);
  assert.doesNotMatch(r.err + r.out, STACK);
  assert.doesNotMatch(r.out, /Attestation checks passed/);
});

test("check:chain-replies: RPC up, FastNEAR transactions API unreachable: names the transactions API, exit 2", async () => {
  // A local JSON-RPC stand-in answers get_roles; the transactions API is dead, so the script fails after its retries.
  const roles = { admin: "tnlab-368aa2.testnet", registrar: null, pauser: null, servicer: null };
  const srv = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "truenav", result: { result: [...Buffer.from(JSON.stringify(roles))] } }));
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["certify/check-chain-replies.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, TRUENAV_RPC: `http://127.0.0.1:${srv.address().port}`, TRUENAV_TX_API: DEAD } });
      let err = "", out = "";
      child.stderr.on("data", (d) => (err += d));
      child.stdout.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, err, out }));
    });
    assert.equal(r.code, 2, r.err);
    assert.equal(r.err.trim(), "network failure: could not reach transactions API at http://127.0.0.1:9 (bad port); set TRUENAV_TX_API to use another endpoint");
    assert.doesNotMatch(r.err + r.out, STACK);
  } finally {
    srv.close();
  }
});

test("verify:attestation: an NRAS override never counts as a pass", async () => {
  const { checkGpu } = await import("../tee/attest.mjs");
  const nonce = "ab".repeat(32);
  process.env.TRUENAV_NRAS_URL = DEAD;
  try {
    const [c] = await checkGpu({ nvidia_payload: JSON.stringify({ nonce }) }, nonce);
    assert.equal(c.pass, false);
    assert.match(c.detail, /network failure: could not reach .*127\.0\.0\.1:9/);
  } finally {
    delete process.env.TRUENAV_NRAS_URL;
  }
});

test("chain:read: a closed local port is reported as ECONNREFUSED", async () => {
  const port = await closedPort();
  const r = run(["certify/chain-read.mjs"], { TRUENAV_RPC: `http://127.0.0.1:${port}` });
  assert.equal(r.code, 2, r.err);
  assert.equal(r.err.trim(), `network failure: could not reach NEAR RPC at http://127.0.0.1:${port} (ECONNREFUSED); set TRUENAV_RPC to use another endpoint`);
});

test("default endpoints offline: chain:read names FastNEAR and both backup RPCs in one line", () => {
  const r = run(["certify/chain-read.mjs"], {}, true);
  assert.equal(r.code, 2, r.err);
  const lines = r.err.trim().split("\n");
  assert.equal(lines.length, 1, r.err);
  assert.match(lines[0], /^network failure: could not reach FastNEAR RPC at https:\/\/test\.rpc\.fastnear\.com \(ECONNREFUSED\), dRPC NEAR RPC \(backup\) at https:\/\/near-testnet\.drpc\.org .*Intea NEAR RPC \(backup\)/);
});

test("check-protocol --fetch offline: names the OutLayer API, exit 2, no stack trace", () => {
  const r = run(["receipts/attestation/check-protocol.mjs", "--fetch"], {}, true);
  assert.equal(r.code, 2, r.err);
  assert.equal(r.err.trim(), "network failure: could not reach OutLayer API at https://testnet-api.outlayer.ai (ECONNREFUSED)");
});

test("check-protocol --recorded still needs no network and passes", () => {
  const r = run(["receipts/attestation/check-protocol.mjs", "--recorded"], {}, true);
  assert.equal(r.code, 0, r.err + r.out);
});

test("net-guard: an HTTP error status is not a network failure; the response is returned unchanged", async () => {
  const srv = createServer((req, res) => { res.statusCode = 503; res.end("busy"); });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    assert.equal(r.status, 503);
    assert.equal(await r.text(), "busy");
  } finally {
    srv.close();
  }
});

test("net-guard: a refused fetch becomes a NetworkError with the endpoint, a registered name and its override", async () => {
  const port = await closedPort();
  const url = `http://127.0.0.1:${port}/x`;
  nameEndpoint(url, "Test RPC", "TEST_RPC");
  const e = await fetch(url).then(() => null, (x) => x);
  assert.ok(e instanceof NetworkError);
  assert.ok(isNetworkError(e));
  assert.equal(e.origin, `http://127.0.0.1:${port}`);
  assert.equal(e.code, "ECONNREFUSED");
  assert.equal(e.message, `network failure: could not reach Test RPC at http://127.0.0.1:${port} (ECONNREFUSED); set TEST_RPC to use another endpoint`);
  assert.match(networkSummary(e), /Test RPC/);
  assert.equal(failLine(new Error("plain")), "error: plain");
  assert.ok(e.cause, "the original error is kept as the cause");
});

test("net-guard: known public hosts are named by service", () => {
  for (const [origin, label] of [
    ["https://test.rpc.fastnear.com", "FastNEAR RPC"],
    ["https://tx.test.fastnear.com", "FastNEAR transactions API"],
    ["https://api.trustedservices.intel.com", "Intel PCS"],
    ["https://pccs.phala.network", "Phala PCCS"],
    ["https://nras.attestation.nvidia.com", "NVIDIA NRAS"],
    ["https://testnet-api.outlayer.ai", "OutLayer API"],
    ["https://api.nearblocks.io", "NearBlocks API"],
  ]) assert.equal(describeEndpoint(origin).label, label, origin);
});
