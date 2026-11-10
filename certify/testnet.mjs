// Live end to end on NEAR testnet: deploy the registry, register the signer and both demo funds, store the
// engine's signed certificates, read them back, and show the double-pledge refusal. A refusal is not counted.
//
//   TRUENAV_TESTNET_ACCOUNT=<your-throwaway>.testnet npm run e2e:testnet
//
// The account must be a throwaway testnet account whose key is in ~/.near-credentials/testnet/<account>.json
// (the legacy keychain that `cargo near create-dev-account ... save-to-legacy-keychain` writes). The script
// never prints or stores that key anywhere else. Testnet only: it refuses any account not ending in .testnet.
//
// It creates (or reuses) three sub-accounts of your account: registry.<you> (the contract), harbor.<you> and
// meridian.<you> (the two fund accounts). Your account is the admin and the servicer.
//
// Certificate signer: TEST KEY, NOT TEE. A fresh random secp256k1 key is generated per account and kept in
// .keys/ (gitignored). Owner decision 6 Nov: the live contract never trusts the public fixed test key; the
// script also submits one certificate signed with that public key (32 bytes of 0x07) to show the contract
// rejects it. The TEE signer from NEAR AI Cloud replaces the test key later.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";
import { scorePortfolio } from "../engine/src/score.mjs";
import { replyProblem } from "../tee/reply.mjs";
import { toCertificate, signCertificate, signEip191, addressOf, newSecretKey } from "./certificate.mjs";
import { networkOf, pledgeMessage } from "../tee/pledge-ticket.mjs";

const root = new URL("../", import.meta.url);
// Public testnet RPC listed in docs.near.org/api/rpc/providers (rpc.testnet.near.org is deprecated and rate limited).
const RPC = process.env.TRUENAV_RPC || "https://test.rpc.fastnear.com";
// TRUENAV_NETWORK=sandbox is set only by certify/sandbox.mjs (local node, published sandbox dev key, temp keychain).
const SANDBOX = process.env.TRUENAV_NETWORK === "sandbox";
const EXPLORER = SANDBOX ? "sandbox tx " : "https://explorer.testnet.near.org/transactions/";
const master = process.env.TRUENAV_TESTNET_ACCOUNT;
const credDir = SANDBOX ? process.env.TRUENAV_CRED_DIR : `${homedir()}/.near-credentials/testnet`;
const wasmPath = new URL("contract/target/near/truenav_registry.wasm", root);

function stop(lines) {
  for (const l of lines) console.log(l);
  process.exit(2);
}
if (!master) {
  stop([
    "Set TRUENAV_TESTNET_ACCOUNT to a throwaway testnet account whose key is in ~/.near-credentials/testnet/.",
    "Create one with the faucet (about 10 testnet NEAR), for example:",
    "  cargo near create-dev-account use-specific-account-id <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create",
    "Then: TRUENAV_TESTNET_ACCOUNT=<name>.testnet npm run e2e:testnet",
    "Offline check without any account: npm run e2e",
  ]);
}
if (!SANDBOX && !master.endsWith(".testnet")) stop(["Testnet only: TRUENAV_TESTNET_ACCOUNT must end in .testnet."]);
if (!existsSync(`${credDir}/${master}.json`)) stop([`No key file ${credDir}/${master}.json (legacy keychain).`]);
if (!existsSync(wasmPath)) {
  console.log("Building the contract: cd contract && cargo near build non-reproducible-wasm");
  execSync("cargo near build non-reproducible-wasm", { cwd: new URL("contract/", root), stdio: "inherit" });
}

const provider = new JsonRpcProvider({ url: RPC });
const loadKey = (id) => JSON.parse(readFileSync(`${credDir}/${id}.json`, "utf8")).private_key;
const accountOf = (id) => new Account(id, provider, loadKey(id));
const admin = accountOf(master);
// Roles (owner decision 6 Nov): the runner's account is admin and registrar; pauser and servicer get their own
// sub-accounts so the split is real on chain.
const ids = { registry: `registry.${master}`, harbor: `harbor.${master}`, meridian: `meridian.${master}`, pauser: `pauser.${master}`, servicer: `servicer.${master}` };
const FUND_ACCOUNT = { "harbor-credit-fund": ids.harbor, "meridian-yield-fund": ids.meridian };
const log = [];

async function exists(id) {
  try {
    await provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}

/** Create a sub-account with a fresh key saved to the legacy keychain (mode 600), unless it exists. */
async function ensureSub(id, near) {
  if (await exists(id)) return { id, created: false };
  const kp = KeyPair.fromRandom("ed25519");
  mkdirSync(credDir, { recursive: true });
  // "wx": created exclusively, so an existing key file is never overwritten (the write fails instead)
  writeFileSync(`${credDir}/${id}.json`, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600, flag: "wx" });
  const tx = await admin.signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(nearToYocto(near)), actions.addFullAccessKey(kp.getPublicKey())],
    waitUntil: "FINAL", // the next step reads this account's state
  });
  record(`create ${id}`, tx);
  return { id, created: true };
}

function decode(tx) {
  const ok = tx.status && tx.status.SuccessValue !== undefined;
  let value = null;
  if (ok && tx.status.SuccessValue) value = JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString());
  const failure = ok ? null : JSON.stringify(tx.status && tx.status.Failure).slice(0, 300);
  return { ok, value, failure };
}

function record(step, tx, expectFailure = false) {
  const hash = tx.transaction_outcome ? tx.transaction_outcome.id : tx.transaction && tx.transaction.hash;
  const d = decode(tx);
  log.push({ step, tx: hash, url: EXPLORER + hash, ok: d.ok, ...(d.failure ? { failure: d.failure } : {}) });
  const tag = d.ok ? "ok  " : expectFailure ? "rejected as expected" : "FAIL";
  console.log(`${tag} ${step}  ${EXPLORER}${hash}`);
  return d;
}

/** Function call that returns the decoded result and records the transaction, never throwing on failure. */
// Admin, servicer and pledge calls must carry exactly 1 yoctoNEAR (full-access key check in the contract).
const ONE_YOCTO = new Set(["add_signer", "remove_signer", "register_fund", "pledge_loan", "release_loan", "add_tee_signer", "remove_tee_signer", "submit_verdict", "set_role", "pause", "unpause", "set_servicer_pledge_key", "add_pledge_signer", "remove_pledge_signer"]);
async function call(signer, step, methodName, args, gasT = "100", expectFailure = false) {
  const tx = await signer.signAndSendTransaction({
    receiverId: ids.registry,
    actions: [actions.functionCall(methodName, args, teraToGas(gasT), ONE_YOCTO.has(methodName) ? 1n : 0n)],
    throwOnFailure: false,
    waitUntil: "FINAL", // read-after-write: state is final before the script checks it
  });
  return record(step, tx, expectFailure);
}

const view = (method, args = {}) => provider.callFunction({ contractId: ids.registry, method, args, blockQuery: { finality: "final" } });

function expect(cond, what) {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}`);
  if (!cond) process.exitCode = 1;
  log.push({ check: what, pass: !!cond });
}

// ---------- 1. accounts and deploy ----------
console.log(`Testnet run as ${master} (RPC ${RPC})`);
await ensureSub(ids.registry, "4");
await ensureSub(ids.harbor, "0.3");
await ensureSub(ids.meridian, "0.3");
await ensureSub(ids.pauser, "0.2");
await ensureSub(ids.servicer, "0.3");
const registry = accountOf(ids.registry);
const harbor = accountOf(ids.harbor);
const meridian = accountOf(ids.meridian);

let initialized = true;
try {
  await view("get_signers");
} catch {
  initialized = false;
}
let hasTee = initialized;
if (initialized) {
  try {
    await view("get_tee_signers");
  } catch {
    hasTee = false; // deployed with the previous state layout: migrate after deploying the new code
  }
}
const wasm = readFileSync(wasmPath);
const deployActions = [actions.deployContract(new Uint8Array(wasm))];
if (initialized && !hasTee) stop([`${ids.registry} holds an older contract layout; use a fresh throwaway account (this release has no migration).`]);
if (!initialized) deployActions.push(actions.functionCall("new", { admin: master, servicer: master }, teraToGas("50"), 0n));
const deployStep = !initialized ? "deploy contract and init" : "redeploy contract (state kept)";
record(deployStep, await registry.signAndSendTransaction({ receiverId: ids.registry, actions: deployActions, throwOnFailure: false, waitUntil: "FINAL" }));

// ---------- 1b. roles ----------
const pauserAcc = accountOf(ids.pauser);
const servicerAcc = accountOf(ids.servicer);
{
  const roles = await view("get_roles");
  if (roles.pauser !== ids.pauser) await call(admin, "set_role pauser", "set_role", { role: "pauser", account_id: ids.pauser });
  if (roles.servicer !== ids.servicer) await call(admin, "set_role servicer", "set_role", { role: "servicer", account_id: ids.servicer });
  const now = await view("get_roles");
  expect(now.admin === master && now.registrar === master && now.pauser === ids.pauser && now.servicer === ids.servicer && !now.paused, `roles: admin and registrar ${master}, pauser ${ids.pauser}, servicer ${ids.servicer}`);
}

// ---------- 2. signer (test key, not TEE) and funds ----------
const keyFile = new URL(`.keys/testnet-signer-${master}.json`, root);
let secretKey;
if (existsSync(keyFile)) secretKey = Uint8Array.from(Buffer.from(JSON.parse(readFileSync(keyFile, "utf8")).secret_hex, "hex"));
else {
  secretKey = newSecretKey();
  mkdirSync(new URL(".keys/", root), { recursive: true });
  writeFileSync(keyFile, JSON.stringify({ note: "test key, not TEE; throwaway testnet certificate signer; never commit", secret_hex: Buffer.from(secretKey).toString("hex") }), { mode: 0o600, flag: "wx" });
}
const signerAddress = addressOf(secretKey);
if (!(await view("get_signers")).includes(signerAddress)) await call(admin, "add_signer (test key, not TEE)", "add_signer", { address: signerAddress });
if ((await view("get_servicer_pledge_key")) !== signerAddress) await call(admin, "set_servicer_pledge_key (test key, not TEE)", "set_servicer_pledge_key", { address: signerAddress });

function pledgeArgs(fundAccount, loanHash, assetType) {
  const nonce = randomBytes(32).toString("hex");
  const expiry_ms = Date.now() + 60 * 60 * 1000;
  const message = pledgeMessage(ids.registry, networkOf(ids.registry), loanHash, fundAccount, assetType, nonce, expiry_ms);
  return { loan_hash: loanHash, asset_type: assetType, fund_account: fundAccount, nonce, expiry_ms, servicer_signature: signEip191(message, secretKey), ticket_signature: null };
}

const fx = JSON.parse(readFileSync(new URL("spec/nav/fixtures.json", root), "utf8"));
const funds = JSON.parse(JSON.stringify(fx.funds));
for (const f of funds) {
  const managerId = f.certificate && (f.certificate.manager_id || f.certificate.signer);
  const registered = await view("get_fund", { fund_id: f.fund_id });
  if (!registered) await call(admin, `register_fund ${f.fund_id}`, "register_fund", { fund_id: f.fund_id, account_id: FUND_ACCOUNT[f.fund_id], manager_id: managerId });
}

// ---------- 2b. pledge every demo loan by its fingerprint ----------
// loan_hash is the lab demo fingerprint (owner decision 6 Nov): sha256("truenav-demo-v1|" + asset + "|" + document id),
// guessable for real identifiers; production uses an HMAC inside a TEE (next step).
const demo = JSON.parse(readFileSync(new URL("tee/loans.json", root), "utf8")).loans.filter((l) => !l.tampered);
const fundAccount = { "harbor-credit-fund": harbor, "meridian-yield-fund": meridian };
for (const l of demo) {
  const lock = await view("get_lock", { loan_hash: l.loan_hash });
  if (lock) continue;
  const d = await call(fundAccount[l.fund_id], `${l.fund_id} pledges ${l.loan_id}`, "pledge_loan", pledgeArgs(fundAccount[l.fund_id], l.loan_hash, l.asset_type));
  expect(d.ok && d.value && d.value.outcome === "pledged", `${l.loan_id} pledged, token minted`);
}

// ---------- 2c. TEE underwriter verdicts ----------
// Each recorded verdict set was produced by node tee/underwrite.mjs --contract <id>: the NEAR AI Cloud model TEE
// read each document after its signer was attested with a fresh nonce, and every reply is bound to one contract,
// network, version and a 30-day expiry (owner decision 6 Nov). A set signed for another contract cannot be used
// here; on an instance with no matching set the loans stay pending (7-day grace, score unchanged).
const sets = ["tee/fixtures/verdicts.json", "tee/fixtures/verdicts-sandbox.json"].map((f) => JSON.parse(readFileSync(new URL(f, root), "utf8")));
const tee = sets.find((t) => t.contract_id === ids.registry) || null;
const teeSigner = tee ? tee.attestation.signers[0].signing_address.toLowerCase() : null;
if (!tee) {
  console.log(`note no recorded TEE verdicts for ${ids.registry}; loans stay pending. With a NEAR AI Cloud key: node tee/underwrite.mjs --contract ${ids.registry} --out tee/fixtures/verdicts-own.json`);
} else {
  // Every submitted response body becomes public transaction data, even when the call fails: never send a reply
  // with anything beyond the allowed keys (owner decision 7 Nov). The contract refuses them too.
  const leaky = tee.results.filter((x) => replyProblem(x.onchain.response_body));
  if (leaky.length) stop([`${leaky.length} recorded replies in this set break the reply rule (${replyProblem(leaky[0].onchain.response_body)}); re-sign the set.`]);
  // The TEE signer is registered with the hash of the published attestation report: it must be that report.
  if (!SANDBOX) {
    const pub = Buffer.from(readFileSync(new URL("tee/fixtures/attestation-report.json.b64", root), "utf8").replace(/\s+/g, ""), "base64");
    const pubSha = createHash("sha256").update(pub).digest("hex");
    if (pubSha !== tee.attestation.report_sha256) stop([`The published attestation report (sha256 ${pubSha.slice(0, 16)}...) is not the one this verdict set was signed under (${String(tee.attestation.report_sha256).slice(0, 16)}...). Re-sign the set: node tee/underwrite.mjs --contract ${ids.registry} --out tee/fixtures/verdicts.json`]);
  }
  const left = tee.expires_at_ms - Date.now();
  expect(left > 0, `recorded TEE verdicts valid for ${(left / 86400000).toFixed(1)} more days`);
  const teeSigners = await view("get_tee_signers");
  if (!teeSigners.some((t) => t.address === teeSigner)) {
    await call(admin, "add_tee_signer (registrar; attested NEAR AI Cloud model TEE)", "add_tee_signer", { address: teeSigner, model_id: tee.model, attestation_ref: `tee/attest.mjs nonce ${tee.attestation.nonce} at ${tee.attestation.checked_at}`, attestation_sha256: tee.attestation.report_sha256 });
  }
  for (const r of tee.results.filter((x) => !x.tampered)) {
    if (await view("get_latest_verdict", { loan_hash: r.loan_hash })) continue;
    const o = r.onchain;
    const d = await call(servicerAcc, `servicer submits verdict ${r.loan_id} (${r.verdict.verdict})`, "submit_verdict", { loan_hash: o.loan_hash, model_id: o.model_id, request_sha256: o.request_sha256, response_body: o.response_body, signature: o.signature });
    expect(d.ok && d.value && d.value.signer === teeSigner && d.value.attestation_sha256 === tee.attestation.report_sha256, `${r.loan_id} TEE verdict verified on chain: ${d.value && d.value.verdict}`);
  }
  // A rival fund holding a genuine TEE flag on Harbor's loan is refused (only the servicer submits).
  const t1 = tee.results.find((x) => x.tampered && x.tampered.id === "T1-altered-amount").onchain;
  const rv = await call(meridian, "Meridian submits a TEE flag on Harbor's loan (must be rejected)", "submit_verdict", { loan_hash: t1.loan_hash, model_id: t1.model_id, request_sha256: t1.request_sha256, response_body: t1.response_body, signature: t1.signature }, "100", true);
  expect(!rv.ok && /servicer only|deposit/.test(rv.failure || ""), "rival verdict rejected: servicer only");
  // A TEE verdict with its reply edited (flag turned into pass) must fail the TEE signature check.
  const forged = t1.response_body.replace('\\"verdict\\":\\"flag\\"', '\\"verdict\\":\\"pass\\"');
  if (forged === t1.response_body) throw new Error("edited-reply check did not change the reply");
  const d = await call(servicerAcc, "submit_verdict with an edited reply (must be rejected)", "submit_verdict", { loan_hash: t1.loan_hash, model_id: t1.model_id, request_sha256: t1.request_sha256, response_body: forged, signature: t1.signature }, "100", true);
  expect(!d.ok && /TEE signer not registered|bad signature|verdict and anomalies disagree/.test(d.failure || ""), "edited TEE verdict rejected");
  // Sandbox only (a refused call still publishes its arguments): a REAL TEE-signed reply from 6 Nov that echoed
  // document_id, asset and amount is refused by the contract's reply rule.
  if (SANDBOX) {
    const lk = JSON.parse(readFileSync(new URL("tee/fixtures/leaky-reply-sandbox.json", root), "utf8")).record;
    const lr = await call(servicerAcc, "submit_verdict with a reply that echoes document fields (must be rejected)", "submit_verdict", { loan_hash: lk.loan_hash, model_id: lk.model_id, request_sha256: lk.request_sha256, response_body: lk.response_body, signature: lk.signature }, "100", true);
    expect(!lr.ok && /reply has a key outside the allowed list/.test(lr.failure || ""), "reply with document fields rejected: allowed keys only");
  }
}

// ---------- 2d. score from chain data ----------
// The engine reads the TEE verdict store from the chain (owner decision 6 Nov), never the TEE itself.
const teeStore = {};
for (const l of demo) {
  const lock = await view("get_lock", { loan_hash: l.loan_hash });
  const latest = await view("get_latest_verdict", { loan_hash: l.loan_hash });
  teeStore[l.loan_hash] = { fund_id: lock ? lock.fund_id : null, pledged_at_ms: lock ? lock.locked_at_ms : null, latest: latest ? { verdict: latest.verdict, anomalies: latest.anomalies, at_ms: latest.at_ms } : null };
  const loan = funds.find((f) => f.fund_id === l.fund_id).loans.find((x) => x.id === l.loan_id);
  loan.loan_hash = l.loan_hash;
}
const results = scorePortfolio({ pd: fx.pd, lgd: fx.lgd }, funds, { now: fx.valuation_time, certStore: fx.cert_store, teeStore });
for (const r of results) expect(r.tee.checked && r.tee.flag === 0 && r.tee.overdue === 0 && (!tee || r.tee.pending === 0), `${r.fundId} TEE from chain: ${r.tee.pass} pass, ${r.tee.pending} pending, ${r.tee.flag} flag`);

// ---------- 3. signed certificates ----------
// Scores are computed as of the fixture valuation time (the demo pins); the certificate is signed now, because
// the contract refuses a signed_at in the future and requires it to move forward per fund.
let engineCommit = "unknown";
try {
  engineCommit = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {}
const nowMs = Date.now();
const certs = {};
for (const r of results) {
  const certificate = toCertificate(r, { fund_account: FUND_ACCOUNT[r.fundId], manager_id: r.managerId }, { nowMs, engineCommit });
  certs[r.fundId] = { certificate, raw: Math.round(r.raw * 100) / 100 };
  await call(admin, `submit_certificate ${r.fundId}`, "submit_certificate", { certificate, signature: signCertificate(ids.registry, certificate, secretKey) });
}
// Same certificate, re-signed with the public fixed test key: the contract must reject it.
{
  const c = { ...certs["harbor-credit-fund"].certificate, signed_at_ms: nowMs + 1 };
  const d = await call(admin, "submit_certificate signed with the public test key (must be rejected)", "submit_certificate", { certificate: c, signature: signCertificate(ids.registry, c, new Uint8Array(32).fill(7)) }, "100", true);
  expect(!d.ok && /signer not registered/.test(d.failure || ""), "public test key rejected: signer not registered");
}
for (const [fundId, { certificate, raw }] of Object.entries(certs)) {
  const got = await view("get_latest_certificate", { fund_id: fundId });
  expect(got && got.signer === signerAddress && got.certificate.signed_at_ms === nowMs, `${fundId} certificate stored, signer ${signerAddress}`);
  expect(got && got.certificate.raw_x100 === certificate.raw_x100, `${fundId} raw read back from chain: ${got && got.certificate.raw_x100 / 100} (engine ${raw})`);
}
expect(certs["harbor-credit-fund"].certificate.raw_x100 === 9917 && certs["harbor-credit-fund"].certificate.band === "green", "Harbor pin 99.17 green");
expect(certs["meridian-yield-fund"].certificate.raw_x100 === 4284 && certs["meridian-yield-fund"].certificate.band === "red", "Meridian pin 42.84 red");

// ---------- 4. double pledge ----------
// Meridian tries to pledge Harbor's H-RE-03, which Harbor already pledged above.
const loanHash = demo.find((l) => l.loan_id === "H-RE-03").loan_hash;
const attemptsBefore = (await view("get_attempts_page", { fund_id: "harbor-credit-fund", from_index: 0, limit: 1 })).count;
const alertsBefore = await view("get_alert_count", { fund_id: "harbor-credit-fund" });
const p2 = await call(meridian, "Meridian pledges Harbor's H-RE-03", "pledge_loan", pledgeArgs(ids.meridian, loanHash, "real_estate"));
expect(p2.ok && p2.value && p2.value.outcome === "refused" && p2.value.message === "already pledged elsewhere", "Meridian refused: already pledged elsewhere");
const attemptsAfter = (await view("get_attempts_page", { fund_id: "harbor-credit-fund", from_index: 0, limit: 1 })).count;
expect(attemptsAfter === attemptsBefore, `Harbor blocked attempts stay ${attemptsBefore} (refusal is not counted against the signed fund)`);
expect((await view("get_alert_count", { fund_id: "harbor-credit-fund" })) === alertsBefore, "Harbor is not alerted by the refusal");
const token = await view("nft_token", { token_id: loanHash });
expect(token && token.owner_id === ids.harbor, `token ${loanHash.slice(0, 12)}... owned by ${ids.harbor}`);

// ---------- 4b. sandbox only: every rejection path on a real node ----------
// Role boundaries, the pause switch on every guarded call, and the verdict rules that need a signed reply
// (unpledged loan, expired binding, another network or contract). A throwaway test TEE key, generated for this run
// and registered only on the local sandbox, signs synthetic replies the way the NEAR AI Cloud TEE signs real ones.
// Never on testnet: a refused call still publishes its arguments.
if (SANDBOX) {
  const reject = async (who, label, method, args, pattern) => {
    const d = await call(who, `${label} (must be rejected)`, method, args, "100", true);
    expect(!d.ok && pattern.test(d.failure || ""), `${label}: ${pattern.source}`);
  };
  // Role boundaries: each role is refused another role's job.
  await reject(servicerAcc, "servicer pauses", "pause", {}, /pauser only/);
  await reject(pauserAcc, "pauser sets a role", "set_role", { role: "servicer", account_id: ids.pauser }, /admin only/);
  await reject(pauserAcc, "pauser adds a certificate signer", "add_signer", { address: "0x" + "11".repeat(20) }, /registrar only/);
  await reject(harbor, "a fund releases its own loan", "release_loan", { loan_hash: demo[0].loan_hash }, /servicer only/);
  await reject(meridian, "a fund registers a fund", "register_fund", { fund_id: "rogue-fund", account_id: ids.meridian, manager_id: "rogue" }, /admin only/);
  await reject(admin, "the admin submits a verdict", "submit_verdict", { loan_hash: demo[0].loan_hash, model_id: "m", request_sha256: "0".repeat(64), response_body: "{}", signature: "0x00" }, /servicer only/);

  // Synthetic TEE replies, signed by a test key registered only on this sandbox.
  const teeKey = newSecretKey();
  const TEST_MODEL = "Test/Model";
  await call(admin, "add_tee_signer (sandbox test key, not TEE)", "add_tee_signer", { address: addressOf(teeKey), model_id: TEST_MODEL, attestation_ref: "sandbox test key", attestation_sha256: "a".repeat(64) });
  const group = (h) => h.match(/.{8}/g).join(" ");
  const signedReply = (loanHash, bindingText, salt) => {
    const content = JSON.stringify({ loan_hash: group(loanHash), binding: bindingText, id_mismatch: "ok", asset_mismatch: "ok", amount_mismatch: "ok", duplicate_document: "ok", duplicate_evidence_line: "ok", injection_attempt: "ok", unreadable: "ok", verdict: "pass", anomalies: [] });
    const response_body = JSON.stringify({ id: `chatcmpl-sandbox-${salt}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    const request_sha256 = createHash("sha256").update(`sandbox-request-${salt}`).digest("hex");
    const resp = createHash("sha256").update(response_body).digest("hex");
    return { model_id: TEST_MODEL, request_sha256, response_body, signature: signEip191(`${TEST_MODEL}:${request_sha256}:${resp}`, teeKey) };
  };
  const later = Date.now() + 10 * 86400000;
  const bind = (contract, network, exp) => `truenav-verdict-v1|${contract}|${network}|${exp}`;
  const pledged = demo[0].loan_hash;
  const unpledged = createHash("sha256").update("sandbox-unpledged-loan").digest("hex");
  await reject(servicerAcc, "verdict on an unpledged loan", "submit_verdict", { loan_hash: unpledged, ...signedReply(unpledged, bind(ids.registry, "sandbox", later), "u") }, /loan not pledged/);
  await reject(servicerAcc, "verdict with an expired binding", "submit_verdict", { loan_hash: pledged, ...signedReply(pledged, bind(ids.registry, "sandbox", Date.now() - 86400000), "e") }, /verdict expired/);
  await reject(servicerAcc, "verdict bound to another network", "submit_verdict", { loan_hash: pledged, ...signedReply(pledged, bind(ids.registry, "testnet", later), "n") }, /bound to another network/);
  await reject(servicerAcc, "verdict bound to another contract", "submit_verdict", { loan_hash: pledged, ...signedReply(pledged, bind("registry.other.sandbox", "sandbox", later), "c") }, /bound to another contract/);

  // Pause: every guarded call is refused, views and role changes keep working, unpause restores the flow.
  await call(pauserAcc, "pauser pauses", "pause", {});
  expect((await view("get_roles")).paused === true, "paused: get_roles still answers and shows paused");
  const fresh = createHash("sha256").update("sandbox-pause-loan").digest("hex");
  await reject(harbor, "pledge while paused", "pledge_loan", pledgeArgs(ids.harbor, fresh, "real_estate"), /paused/);
  await reject(servicerAcc, "release while paused", "release_loan", { loan_hash: pledged }, /paused/);
  await reject(servicerAcc, "verdict while paused", "submit_verdict", { loan_hash: pledged, ...signedReply(pledged, bind(ids.registry, "sandbox", later), "p") }, /paused/);
  {
    const c = { ...certs["harbor-credit-fund"].certificate, signed_at_ms: nowMs + 2 };
    await reject(admin, "certificate while paused", "submit_certificate", { certificate: c, signature: signCertificate(ids.registry, c, secretKey) }, /paused/);
  }
  const rc = await call(admin, "set_role while paused (allowed)", "set_role", { role: "servicer", account_id: ids.servicer });
  expect(rc.ok, "role change still works while paused");
  await call(pauserAcc, "pauser unpauses", "unpause", {});
  const pr = await call(harbor, "pledge after unpause", "pledge_loan", pledgeArgs(ids.harbor, fresh, "real_estate"));
  expect(pr.ok && pr.value && pr.value.outcome === "pledged", "unpaused: pledging works again");
  const rl = await call(servicerAcc, "servicer releases the extra loan", "release_loan", { loan_hash: fresh });
  expect(rl.ok, "release works after unpause");
}

// ---------- 5. write the run record ----------
const out = {
  note: "Live testnet run of certify/testnet.mjs. Certificate signer is a test key, not TEE; loan verdicts are signed by the attested NEAR AI Cloud model TEE.",
  network: SANDBOX ? "sandbox" : "testnet",
  rpc: RPC,
  contract_id: ids.registry,
  admin_and_servicer: master,
  fund_accounts: FUND_ACCOUNT,
  signer_address: signerAddress,
  signer_kind: "test key, not TEE",
  engine_commit: engineCommit,
  signed_at_ms: nowMs,
  double_pledge_loan_hash: loanHash,
  tee_signer: teeSigner,
  tee_model: tee.model,
  scores_from_chain: results.map((r) => ({ fund_id: r.fundId, status: r.status, raw: Math.round(r.raw * 100) / 100, band: r.band, tee: { pass: r.tee.pass, pending: r.tee.pending, flag: r.tee.flag, overdue: r.tee.overdue } })),
  steps: log,
};
mkdirSync(new URL("out/", root), { recursive: true });
const runFile = SANDBOX ? "out/sandbox-run.json" : "out/testnet-run.json";
writeFileSync(new URL(runFile, root), JSON.stringify(out, null, 2) + "\n");
if (!SANDBOX) console.log(`\nContract: https://explorer.testnet.near.org/accounts/${ids.registry}`);
console.log(`Run record: ${runFile}${process.exitCode ? "  (some checks FAILED)" : "  (all checks passed)"}`);
