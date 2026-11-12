// receipts/deploy-testnet.mjs: the master account comes from --master or TRUENAV_MASTER and has no default, and D0 to D4
// print the right plan in print-only mode. The print-only runs use the real script in a child process against a local
// fake NEAR RPC (TRUENAV_RPC, refused with --execute), a synthetic fresh master with a throwaway key file in a temp dir,
// and fake wasm files whose sha256 go into a temp pins file (TRUENAV_PINS_FILE). Nothing here touches a network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { parseDeployArgs, UsageError, USED_MASTERS, DEFAULT_RPC } from "../deploy-args.mjs";

const SCRIPT = new URL("../deploy-testnet.mjs", import.meta.url).pathname;
const MASTER = "fresh-master-test.testnet";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const throws = (argv, env, re) => assert.throws(() => parseDeployArgs(argv, env), (e) => e instanceof UsageError && re.test(e.message), `${argv.join(" ")} ${JSON.stringify(env)}`);

test("the master comes from --master or TRUENAV_MASTER; there is no default", () => {
  assert.equal(parseDeployArgs(["D0", "--master", MASTER], {}).master, MASTER);
  assert.equal(parseDeployArgs(["D0"], { TRUENAV_MASTER: MASTER }).master, MASTER);
  assert.equal(parseDeployArgs(["--master", MASTER, "D2"], {}).step, "D2");
  assert.equal(parseDeployArgs(["D0", "--master", MASTER], { TRUENAV_MASTER: MASTER }).master, MASTER, "flag and env agree");
  throws(["D0"], {}, /no master account.*There is no default/);
  throws(["D0", "--master", MASTER], { TRUENAV_MASTER: "other-master.testnet" }, /differ/);
  throws(["D0", "--master"], {}, /needs an account id/);
  throws(["D0", "--master", "--execute"], {}, /needs an account id/);
});

test("steps, flags and the master's shape are checked", () => {
  throws([], { TRUENAV_MASTER: MASTER }, /a step is required/);
  throws(["D5"], { TRUENAV_MASTER: MASTER }, /a step is required/);
  throws(["D0", "D1"], { TRUENAV_MASTER: MASTER }, /unexpected argument D1/);
  throws(["D0", "--force"], { TRUENAV_MASTER: MASTER }, /unknown flag --force/);
  for (const bad of ["Fresh.testnet", "fresh.near", "fresh", "a.b.testnet", "-x.testnet", `${"a".repeat(41)}.testnet`, "x y.testnet", ""]) {
    throws(["D0"], { TRUENAV_MASTER: bad || " " }, /lowercase named testnet account/);
  }
  assert.equal(parseDeployArgs(["D0", "--master", "a1.testnet"], {}).master, "a1.testnet");
});

test("--execute is refused on an earlier master and with an RPC or pins override; read-only runs are allowed", () => {
  for (const m of USED_MASTERS) {
    assert.equal(parseDeployArgs(["D0", "--master", m], {}).master, m, "read-only on an earlier master is fine");
    throws(["D1", "--master", m, "--execute"], {}, /refusing to execute on .* hosted an earlier deploy/);
  }
  assert.ok(USED_MASTERS.includes("tnlab-718ca9.testnet") && USED_MASTERS.includes("tnlab-368aa2.testnet"));
  throws(["D1", "--master", MASTER, "--execute"], { TRUENAV_RPC: "http://127.0.0.1:1" }, /print-only runs; refused with --execute/);
  throws(["D1", "--master", MASTER, "--execute"], { TRUENAV_PINS_FILE: "/tmp/x.json" }, /print-only runs; refused with --execute/);
  const ok = parseDeployArgs(["D1", "--master", MASTER, "--execute"], {});
  assert.deepEqual([ok.execute, ok.rpc, ok.pinsFile], [true, DEFAULT_RPC, null]);
  assert.equal(parseDeployArgs(["D1", "--master", MASTER], { TRUENAV_RPC: "http://127.0.0.1:1" }).rpc, "http://127.0.0.1:1");
});

// ---- the real script, print-only, against a fake chain ---------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "truenav-deploy-test-"));
const keyPair = KeyPair.fromRandom("ed25519");
const keyfile = join(dir, "master.json");
writeFileSync(keyfile, JSON.stringify({ account_id: MASTER, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }), { mode: 0o600 });
const wasmDir = join(dir, "wasm");
await import("node:fs").then(({ mkdirSync }) => mkdirSync(wasmDir));
const receiptsWasm = Buffer.from("fake receipts wasm bytes for the print-only test");
const queryWasm = Buffer.from("fake query wasm bytes for the print-only test, longer");
writeFileSync(join(wasmDir, "truenav_receipts.wasm"), receiptsWasm);
writeFileSync(join(wasmDir, "truenav_query.wasm"), queryWasm);
const pinsFile = join(dir, "pins.json");
writeFileSync(pinsFile, JSON.stringify({ receipts: sha(receiptsWasm), query: sha(queryWasm) }));

const calls = [];
const BALANCE = (10n * 10n ** 24n).toString();
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    calls.push(method === "query" ? `query:${params.request_type}` : method);
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, ...o })); };
    const at = { block_height: 1, block_hash: "11111111111111111111111111111111" };
    if (method === "status") return send({ result: { chain_id: "testnet", version: { version: "fake", build: "fake" }, sync_info: {}, validators: [] } });
    if (method === "query" && params.request_type === "view_account") {
      if (params.account_id === MASTER) return send({ result: { amount: BALANCE, locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, storage_paid_at: 0, ...at } });
      return send({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id, ...at } }, code: -32000, message: "Server error", data: `account ${params.account_id} does not exist while viewing` } });
    }
    if (method === "query" && params.request_type === "view_access_key") return send({ result: { nonce: 1, permission: "FullAccess", ...at } });
    send({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_METHOD", info: {} }, code: -32601, message: "fake rpc does not serve this", data: method } });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const RPC = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: dir, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
const printOnly = (step) => run([step, "--master", MASTER], { TRUENAV_RPC: RPC, TRUENAV_PINS_FILE: pinsFile, TRUENAV_WASM_DIR: wasmDir, TRUENAV_SIGNER_KEYFILE: keyfile });

test("the script without a master stops with exit 2 before any file, key or network access", async () => {
  const r = await run(["D0"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no master account.*There is no default/s);
  assert.equal(r.out, "");
  assert.equal(calls.length, 0, "no RPC call was made");
  const used = await run(["D1", "--master", "tnlab-718ca9.testnet", "--execute"]);
  assert.equal(used.code, 2);
  assert.match(used.err, /hosted an earlier deploy/);
});

test("D0 to D4 print-only for a fresh master print the plan the script's constants define, and send nothing", async () => {
  const engine = readFileSync(new URL("../../outlayer/engine-v2/BUILD.md", import.meta.url), "utf8").match(/^\| wasm sha256 \| `([0-9a-f]{64})`/m)[1];
  const out = {};
  for (const s of ["D0", "D1", "D2", "D3", "D4"]) {
    const r = await printOnly(s);
    assert.equal(r.code, 0, `${s}: ${r.err}${r.out.slice(-300)}`);
    out[s] = r.out;
    assert.match(r.out, new RegExp(`step 4 deploy, ${s} \\(print only\\), master ${MASTER}`));
    assert.match(r.out, new RegExp(`signer key file .*master.json: public key ${keyPair.getPublicKey().toString()}, a full-access key of ${MASTER}`));
    assert.match(r.out, /D1 still needs 8\.2500 NEAR .*all four: 8\.2 \+ 0\.05/);
    assert.match(r.out, new RegExp(`receipts wasm .*is the pinned build ${sha(receiptsWasm)}`));
    assert.match(r.out, new RegExp(`query wasm .*is the pinned build ${sha(queryWasm)}`));
    assert.match(r.out, new RegExp(`engine build pinned in the receipt config: ${engine}`));
    for (const sub of ["receipts", "query", "runner", "api"]) assert.match(r.out, new RegExp(`${sub}\\.${MASTER}: free`));
    assert.ok(!r.out.includes(keyPair.toString()) && !r.err.includes(keyPair.toString()), `${s}: the private key is never printed`);
    if (s !== "D0") assert.match(r.out, /print only: nothing was sent/);
  }
  // D1: the funding and the preflight
  assert.match(out.D1, /Cost: 8\.2 NEAR .*\(receipts 6, query 1\.7, runner 0\.4, api 0\.1\).*preflight needs 8\.2 \+ 0\.05/);
  for (const [sub, amt] of [["receipts", 6], ["query", 1.7], ["runner", 0.4], ["api", 0.1]]) {
    assert.match(out.D1, new RegExp(`tx to ${sub}\\.${MASTER}:\\n\\s+CreateAccount\\n\\s+Transfer ${amt} NEAR\\n\\s+AddKey <new ed25519 key>, FullAccess`));
  }
  // D2: the v2 init path, the master as admin and pauser, the receipts account as project and secrets owner
  assert.match(out.D2, /initializes the compatibility v2 path, not the v3 migration/);
  const d2 = out.D2.match(/FunctionCall new (\{.*\}) gas 50 Tgas deposit 0/)[1];
  const args = JSON.parse(d2);
  assert.deepEqual([args.admin, args.pauser], [MASTER, MASTER]);
  assert.equal(args.config.project_id, `receipts.${MASTER}/truenav-engine`);
  assert.equal(args.config.secrets_owner, `receipts.${MASTER}`);
  assert.equal(args.config.version_key, engine);
  assert.equal(args.config.method, "cashflow-v2.1.0");
  assert.equal(args.config.outlayer_deposit, "10000000000000000000000");
  assert.match(out.D2, new RegExp(`DeployContract sha256 ${sha(receiptsWasm)}`));
  // D3: four tokens and the runner, 1 yocto each, signed by the master
  for (const [t, k] of [["DEMO-CREDIT", "credit"], ["DEMO-RENTAL", "rental"], ["HONEST-CREDIT", "credit"], ["HONEST-RENTAL", "rental"]]) {
    assert.match(out.D3, new RegExp(`register_token \\{"token_id":"${t}","kind":"${k}"\\} gas 30 Tgas deposit 1 yocto \\(signed by ${MASTER}\\)`));
  }
  assert.match(out.D3, new RegExp(`set_runner \\{"account":"runner\\.${MASTER}","allowed":true\\}`));
  // D4: the query contract, fee 0.01 NEAR, redeemer api
  assert.match(out.D4, new RegExp(`FunctionCall new \\{"admin":"${MASTER}","redeemer":"api\\.${MASTER}","fee":"10000000000000000000000"\\} gas 50 Tgas deposit 0`));
  assert.match(out.D4, new RegExp(`DeployContract sha256 ${sha(queryWasm)}`));
  // nothing was ever signed or sent: only reads reached the chain
  assert.ok(calls.length > 0 && calls.every((c) => c === "status" || c.startsWith("query:view_")), `only read calls: ${[...new Set(calls)].join(", ")}`);
});

test("a wasm that does not match the pins stops the run (exit 1) and the stale receipts/dist is refused", async () => {
  writeFileSync(join(wasmDir, "truenav_query.wasm"), "tampered");
  const r = await printOnly("D0");
  assert.equal(r.code, 1);
  assert.match(r.err + r.out, /query wasm .* is not the pinned build/);
  writeFileSync(join(wasmDir, "truenav_query.wasm"), queryWasm);
  const stale = await run(["D0", "--master", MASTER], { TRUENAV_RPC: RPC, TRUENAV_SIGNER_KEYFILE: keyfile, TRUENAV_WASM_DIR: new URL("../dist", import.meta.url).pathname });
  assert.equal(stale.code, 1, "the committed receipts/dist does not match the real pins");
});
