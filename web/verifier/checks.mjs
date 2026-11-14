// Verifier panel data layer (no layout, no CSS, no framework). Every check returns
//   { id, label, state: "live" | "recorded" | "unchecked" | "fail", detail, evidenceDate?, source }
//   live       read from the live registry over public RPC now, or a signature / hash computed now from the published files
//   recorded   taken from a committed evidence file; evidenceDate says when that evidence was captured
//   unchecked  honestly not checked here (the detail says why and where it can be checked)
//   fail       a comparison failed: wrong hash, bad signature, wrong signer, expired binding, unreadable evidence
// Rules: a chain read that fails never yields live (it yields unchecked), a local comparison that fails yields fail even
// when the chain is unreachable, and an exception anywhere in a check yields fail, never a pass.
// Read only: view calls and view_account only. No keys, no transactions.
import { view as chainView, codeHash as chainCodeHash, DEFAULT_CONTRACT, DEFAULT_RPC } from "../chain.mjs";
import { replyProblem, replyObject } from "../../tee/reply.mjs";
import { eip191Recover, sha256Hex, base64ToBytes } from "./eip191.mjs";

export const STATES = Object.freeze(["live", "recorded", "unchecked", "fail"]);
/** Same constant as tee/underwrite.mjs VERDICT_TTL_MS (the test checks they agree). */
export const VERDICT_TTL_MS = 30 * 24 * 3600 * 1000;
/** Same format as tee/underwrite.mjs bindingFor (the test checks they agree). */
export const bindingFor = (contract, expiresAtMs) => `truenav-verdict-v1|${contract}|${{ testnet: "testnet", near: "mainnet" }[contract.split(".").pop()] || contract.split(".").pop()}|${expiresAtMs}`;
const ungroup = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const lower = (xs) => (Array.isArray(xs) ? xs : []).map((x) => String(x).toLowerCase()).sort();
const sameList = (a, b) => JSON.stringify(lower(a)) === JSON.stringify(lower(b));

/** A chain read failed (network, HTTP, RPC error). Turns a check into unchecked, never live. */
export class ChainReadError extends Error {}

function result(id, label, state, detail, source, evidenceDate) {
  if (!STATES.includes(state)) throw new Error(`bad state ${state}`);
  const r = { id, label, state, detail: String(detail), source };
  if (evidenceDate) r.evidenceDate = evidenceDate;
  return Object.freeze(r);
}

/** Wrap view/codeHash so every failure is a ChainReadError, and results come back as plain data. */
export const DEFAULT_RECEIPTS = "receipts.tnlab-718ca9.testnet";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const STORAGE_DEPOSIT_V3 = "350000000000000000000000";

/** NEAR account code_hash is base58 of sha256(wasm). */
export function codeHashFromSha256(hex) {
  const h = String(hex || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("pin is not a sha256 hex");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n = n / 58n;
  }
  let pad = 0;
  for (const b of bytes) {
    if (b === 0) pad++;
    else break;
  }
  return `${B58[0].repeat(pad)}${out}`;
}

function nearFromYocto(y) {
  const s = String(y ?? "");
  if (!/^\d+$/.test(s)) return s || "missing";
  const padded = s.padStart(25, "0");
  const i = padded.slice(0, -24);
  const f = padded.slice(-24).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

function receiptsExpect(ev) {
  const r = ev.receipts || {};
  const paths = ev.paths || {};
  const pinPath = paths.receiptsPin || "receipts/pinned-builds.json";
  const buildPath = paths.receiptsBuild || "receipts/v3-build.json";
  const sha256 = String(r.sha256 || "").toLowerCase();
  const engineSha256 = String(r.engineSha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${pinPath} has no receipts sha256`);
  if (!/^[0-9a-f]{64}$/.test(engineSha256)) throw new Error(`${buildPath} has no engine sha256`);
  return {
    account: r.account || DEFAULT_RECEIPTS,
    sha256,
    engineSha256,
    method: r.method || "truenav-v3.0.1",
    storage_deposit: String(r.storage_deposit || STORAGE_DEPOSIT_V3),
    outlayer_tgas: Number(r.outlayer_tgas ?? 200),
    callback_tgas: Number(r.callback_tgas ?? 80),
    outlayer: r.outlayer || "outlayer.testnet",
    codeHash: codeHashFromSha256(sha256),
    pinPath,
    buildPath,
  };
}

function receiptsApi(c, account) {
  const missing = (what) => async () => { throw new ChainReadError(`could not read ${account}: no receipts ${what}`); };
  return {
    account: c.receipts || account,
    receiptsCodeHash: typeof c.receiptsCodeHash === "function" ? c.receiptsCodeHash : missing("code hash"),
    receiptsView: typeof c.receiptsView === "function" ? c.receiptsView : missing("view"),
  };
}

export function chainReader({ contract = DEFAULT_CONTRACT, url = DEFAULT_RPC, view = chainView, codeHash = chainCodeHash, receipts = DEFAULT_RECEIPTS, receiptsView, receiptsCodeHash } = {}) {
  const wrap = (id) => (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e instanceof ChainReadError) throw e;
      throw new ChainReadError(`could not read ${id}: ${e && e.message ? e.message : String(e)}`);
    }
  };
  const wrapC = wrap(contract);
  const wrapR = wrap(receipts);
  return {
    contract,
    url,
    receipts,
    view: wrapC((m, args = {}) => view(contract, m, args, url)),
    codeHash: wrapC(() => codeHash(contract, url)),
    receiptsView: wrapR((m, args = {}) => (receiptsView ? receiptsView(m, args) : view(receipts, m, args, url))),
    receiptsCodeHash: wrapR(() => (receiptsCodeHash ? receiptsCodeHash() : codeHash(receipts, url))),
  };
}

/** Records of the verdict file whose signature recovers to the expected signer and whose reply passes the reply rule. */
function checkRecord(file, r, teeSigner) {
  const on = r && r.onchain;
  if (!on || typeof on.response_body !== "string") return { sig: "missing onchain record", reply: "missing onchain record" };
  let sig = null;
  try {
    const rec = eip191Recover(`${file.model}:${on.request_sha256}:${sha256Hex(on.response_body)}`, on.signature);
    if (rec !== teeSigner) sig = `signature recovers to ${rec}, not the attested signer`;
    else if (String(on.signer).toLowerCase() !== teeSigner) sig = "record names another signer";
  } catch (e) {
    sig = `signature does not parse (${e.message})`;
  }
  let reply = replyProblem(on.response_body);
  if (reply === null) {
    const p = replyObject(on.response_body);
    if (!p) reply = "signed reply cannot be read";
    else if (ungroup(p.reply.loan_hash) !== r.loan_hash || on.loan_hash !== r.loan_hash) reply = "signed reply names another loan_hash";
    else if (String(p.reply.binding || "").replace(/\s+/g, "") !== file.binding) reply = "signed reply echoes another binding";
    else if (!r.verdict || r.verdict.verdict !== p.reply.verdict || JSON.stringify(r.verdict.anomalies) !== JSON.stringify(p.reply.anomalies)) reply = "recorded verdict does not match the signed reply";
  }
  return { sig, reply };
}

/**
 * Run every verifier check.
 * @param {object} p
 * @param {{status:object, liveRegistry:object, verdicts:object, reportB64:string, paths?:object}} p.evidence  see loadEvidence()
 * @param {ReturnType<typeof chainReader>} [p.chain]  defaults to the public testnet RPC for the registry in status.json
 * @param {number} [p.now]  ms since epoch (default Date.now())
 * @returns {Promise<Readonly<{id,label,state,detail,source,evidenceDate?}>[]>}
 */
export async function runVerifierChecks({ evidence, chain, now = Date.now() } = {}) {
  const ev = evidence || {};
  const status = ev.status || {};
  const expected = ev.liveRegistry || {};
  const file = ev.verdicts || {};
  const paths = { status: "tee/status.json", liveRegistry: "certify/live-registry.json", verdicts: status.verdicts_file || "tee/fixtures/verdicts-368aa2.json", report: status.report_file || "tee/fixtures/attestation-report-368aa2.json.b64", ...(ev.paths || {}) };
  const contract = status.registry || expected.contract || DEFAULT_CONTRACT;
  const c = chain || chainReader({ contract });
  const teeSigner = String(status.tee_signer || "").toLowerCase();
  const rpcSrc = (m) => `${c.url || "rpc"} ${m} on ${contract}`;
  const out = [];

  // Each check runs isolated: ChainReadError -> unchecked, any other exception -> fail.
  const run = async (id, label, source, fn) => {
    try {
      out.push(await fn());
    } catch (e) {
      const chainDown = e instanceof ChainReadError;
      out.push(result(id, label, chainDown ? "unchecked" : "fail", chainDown ? `${e.message}. Not checked; no result is shown as current.` : `check could not complete: ${e && e.message ? e.message : e}`, source));
    }
  };

  await run("registry-code", "Deployed contract code hash", rpcSrc("view_account"), async () => {
    if (!expected.code_hash) throw new Error(`${paths.liveRegistry} has no code_hash`);
    const h = await c.codeHash();
    return h === expected.code_hash
      ? result("registry-code", "Deployed contract code hash", "live", `${contract} code hash ${h} equals the hash in ${paths.liveRegistry}`, rpcSrc("view_account"))
      : result("registry-code", "Deployed contract code hash", "fail", `chain code hash ${h} differs from ${expected.code_hash} in ${paths.liveRegistry}`, rpcSrc("view_account"));
  });

  let expectedReceipts;
  try { expectedReceipts = receiptsExpect(ev); } catch (e) { expectedReceipts = { error: e }; }
  const receiptsSrc = (m) => `${c.url || "rpc"} ${m} on ${(expectedReceipts.account || DEFAULT_RECEIPTS)}`;

  await run("receipts-code", "Deployed receipts contract code hash", receiptsSrc("view_account"), async () => {
    if (expectedReceipts.error) throw expectedReceipts.error;
    const api = receiptsApi(c, expectedReceipts.account);
    const h = await api.receiptsCodeHash();
    const src = receiptsSrc("view_account");
    return h === expectedReceipts.codeHash
      ? result("receipts-code", "Deployed receipts contract code hash", "live", `${expectedReceipts.account} code hash ${h} equals the pinned receipts build (sha256 ${expectedReceipts.sha256} in ${expectedReceipts.pinPath})`, src)
      : result("receipts-code", "Deployed receipts contract code hash", "fail", `${expectedReceipts.account} code hash ${h} differs from the pinned receipts build ${expectedReceipts.codeHash} (sha256 ${expectedReceipts.sha256} in ${expectedReceipts.pinPath}). Redeploy pending.`, src);
  });

  await run("receipts-config", "Receipts contract config", receiptsSrc("get_config"), async () => {
    if (expectedReceipts.error) throw expectedReceipts.error;
    const api = receiptsApi(c, expectedReceipts.account);
    const raw = await api.receiptsView("get_config", {});
    const cfg = raw && raw.config ? raw.config : {};
    const diffs = [];
    if (cfg.method !== expectedReceipts.method) diffs.push(`method ${cfg.method || "missing"} (expected ${expectedReceipts.method})`);
    if (String(cfg.version_key || "").toLowerCase() !== expectedReceipts.engineSha256) diffs.push(`version_key ${cfg.version_key || "missing"} (expected ${expectedReceipts.engineSha256})`);
    try {
      if (BigInt(String(cfg.storage_deposit ?? "")) !== BigInt(expectedReceipts.storage_deposit)) diffs.push(`storage_deposit ${nearFromYocto(cfg.storage_deposit)} NEAR (expected ${nearFromYocto(expectedReceipts.storage_deposit)})`);
    } catch {
      diffs.push(`storage_deposit ${cfg.storage_deposit || "missing"} (expected ${nearFromYocto(expectedReceipts.storage_deposit)} NEAR)`);
    }
    if (Number(cfg.outlayer_tgas) !== expectedReceipts.outlayer_tgas) diffs.push(`outlayer_tgas ${cfg.outlayer_tgas ?? "missing"} (expected ${expectedReceipts.outlayer_tgas})`);
    if (Number(cfg.callback_tgas) !== expectedReceipts.callback_tgas) diffs.push(`callback_tgas ${cfg.callback_tgas ?? "missing"} (expected ${expectedReceipts.callback_tgas})`);
    if (cfg.outlayer !== expectedReceipts.outlayer) diffs.push(`outlayer ${cfg.outlayer || "missing"} (expected ${expectedReceipts.outlayer})`);
    const src = receiptsSrc("get_config");
    if (diffs.length) {
      return result("receipts-config", "Receipts contract config", "fail", `get_config on ${expectedReceipts.account} does not match the expected v3 config (redeploy pending): ${diffs.join(", ")}.`, src);
    }
    const receiptProblems = [];
    let tokens = [];
    try { tokens = await api.receiptsView("list_tokens", { from: 0, limit: 100 }); } catch { tokens = []; }
    const stored = (Array.isArray(tokens) ? tokens : []).filter((t) => Number(t && t.receipts) > 0);
    for (const t of stored) {
      let latest;
      try { latest = await api.receiptsView("get_latest_receipt", { token_id: t.token_id }); } catch {
        try { latest = await api.receiptsView("get_latest", { token_id: t.token_id }); } catch (e) {
          receiptProblems.push(`could not read the latest receipt on ${t.token_id}`);
          continue;
        }
      }
      const sha = latest && (latest.engine_code_sha256 || latest.engine_version_key);
      if (String(sha || "").toLowerCase() !== expectedReceipts.engineSha256) {
        receiptProblems.push(`latest receipt on ${t.token_id} has engine_code_sha256 ${sha || "missing"} (expected ${expectedReceipts.engineSha256})`);
      }
    }
    if (receiptProblems.length) {
      return result("receipts-config", "Receipts contract config", "fail", `get_config on ${expectedReceipts.account} matches the expected v3 config, but ${receiptProblems.join("; ")}.`, src);
    }
    const receiptNote = stored.length ? `The latest stored receipt engine_code_sha256 equals the pin.` : "No stored receipt yet.";
    return result("receipts-config", "Receipts contract config", "live", `get_config on ${expectedReceipts.account} matches ${expectedReceipts.method}, version_key ${expectedReceipts.engineSha256}, storage_deposit ${nearFromYocto(expectedReceipts.storage_deposit)} NEAR, ${expectedReceipts.outlayer_tgas} and ${expectedReceipts.callback_tgas} Tgas, outlayer ${expectedReceipts.outlayer}. ${receiptNote}`, src);
  });

  await run("registry-roles", "Contract roles and pause flag", rpcSrc("get_roles"), async () => {
    const roles = await c.view("get_roles");
    const bad = ["admin", "registrar", "pauser", "servicer", "paused"].filter((k) => !expected.roles || roles?.[k] !== expected.roles[k]);
    return bad.length === 0
      ? result("registry-roles", "Contract roles and pause flag", "live", `roles match ${paths.liveRegistry}; paused is ${roles.paused}`, rpcSrc("get_roles"))
      : result("registry-roles", "Contract roles and pause flag", "fail", `differs from ${paths.liveRegistry}: ${bad.join(", ")}`, rpcSrc("get_roles"));
  });

  await run("tee-signer", "Registered TEE signer", rpcSrc("get_tee_signers"), async () => {
    const tee = await c.view("get_tee_signers");
    const problems = [];
    if (!Array.isArray(tee) || tee.length !== 1) problems.push(`expected exactly one TEE signer, chain has ${Array.isArray(tee) ? tee.length : "none"}`);
    const t = (Array.isArray(tee) ? tee : []).find((x) => String(x.address).toLowerCase() === teeSigner);
    if (!teeSigner) problems.push(`${paths.status} names no tee_signer`);
    else if (!t) problems.push(`${teeSigner} is not registered`);
    else {
      if (t.model_id !== status.model) problems.push(`model ${t.model_id} is not ${status.model}`);
      if (t.attestation_sha256 !== status.report_sha256) problems.push("stored attestation hash differs from tee/status.json");
    }
    return problems.length === 0
      ? result("tee-signer", "Registered TEE signer", "live", `the only TEE signer is ${teeSigner}, model ${status.model}`, rpcSrc("get_tee_signers"))
      : result("tee-signer", "Registered TEE signer", "fail", problems.join("; "), rpcSrc("get_tee_signers"));
  });

  await run("attestation-hash", "Published attestation report hash", `${paths.report}; ${rpcSrc("get_tee_signers")}`, async () => {
    const src = `${paths.report}; ${rpcSrc("get_tee_signers")}`;
    const sha = sha256Hex(base64ToBytes(ev.reportB64 ?? ""));
    if (!ev.reportB64 || sha !== status.report_sha256 || sha !== file.attestation?.report_sha256) {
      return result("attestation-hash", "Published attestation report hash", "fail", `sha256 of the published report (${sha.slice(0, 16)}...) does not equal the hash in ${paths.status} and ${paths.verdicts}`, src);
    }
    const tee = await c.view("get_tee_signers"); // after the local check: a local mismatch is a fail even offline
    const onchain = (Array.isArray(tee) ? tee : []).some((t) => t.attestation_sha256 === sha && String(t.address).toLowerCase() === teeSigner);
    return onchain
      ? result("attestation-hash", "Published attestation report hash", "live", `sha256 ${sha} computed now from the published report equals the hash the contract stores for ${teeSigner}`, src)
      : result("attestation-hash", "Published attestation report hash", "fail", "the contract stores no TEE signer with this report hash", src);
  });

  await run("attestation-quote", "TEE attestation (Intel TDX quote, NVIDIA GPU evidence)", `${paths.verdicts} attestation; ${paths.report}`, async () => {
    const src = `${paths.verdicts} attestation; ${paths.report}`;
    const att = file.attestation;
    const date = att?.checked_at;
    const sections = Array.isArray(att?.sections) ? att.sections : [];
    const checks = sections.flatMap((s) => (Array.isArray(s.checks) ? s.checks : []));
    const failed = checks.filter((x) => x.pass !== true);
    const report = JSON.parse(new TextDecoder().decode(base64ToBytes(ev.reportB64 ?? "")));
    const model = (report.model_attestations || [])[0] || {};
    const problems = [];
    if (sha256Hex(base64ToBytes(ev.reportB64 ?? "")) !== att?.report_sha256) problems.push("the published report is not the report these checks were recorded for (sha256 differs)");
    if (sections.length < 2 || checks.length === 0) problems.push("no recorded gateway and model checks");
    if (failed.length) problems.push(`${failed.length} recorded check(s) did not pass: ${failed.map((x) => x.check).join("; ")}`);
    if (String(model.signing_address).toLowerCase() !== teeSigner) problems.push("the report's model signing address is not the TEE signer");
    if (model.request_nonce !== att?.nonce) problems.push("the report's request nonce is not the recorded nonce");
    if (!att?.signers?.some((s) => String(s.signing_address).toLowerCase() === teeSigner)) problems.push("the recorded attested signers do not include the TEE signer");
    if (problems.length) return result("attestation-quote", "TEE attestation (Intel TDX quote, NVIDIA GPU evidence)", "fail", problems.join("; "), src, date);
    return result("attestation-quote", "TEE attestation (Intel TDX quote, NVIDIA GPU evidence)", "recorded", `${checks.length} checks passed when captured (quote and collateral, TCB UpToDate, debug off, key and nonce bound, NVIDIA evidence). Not re-verified in the browser; run npm run verify:attestation to re-verify now.`, src, date);
  });

  await run("verdict-signatures", "TEE signatures on recorded verdicts", paths.verdicts, async () => {
    const recs = Array.isArray(file.results) ? file.results : [];
    if (!teeSigner || recs.length === 0) return result("verdict-signatures", "TEE signatures on recorded verdicts", "fail", "no signer or no recorded verdicts", paths.verdicts);
    const bad = recs.map((r, i) => [i, checkRecord(file, r, teeSigner).sig]).filter(([, p]) => p);
    return bad.length === 0
      ? result("verdict-signatures", "TEE signatures on recorded verdicts", "live", `all ${recs.length} EIP-191 signatures over model:request_sha256:response_sha256 recovered now to ${teeSigner}`, paths.verdicts)
      : result("verdict-signatures", "TEE signatures on recorded verdicts", "fail", `${bad.length} of ${recs.length} fail: ${bad.slice(0, 3).map(([i, p]) => `results[${i}] ${p}`).join("; ")}`, paths.verdicts);
  });

  await run("verdict-replies", "Signed replies follow the reply rule", paths.verdicts, async () => {
    const recs = Array.isArray(file.results) ? file.results : [];
    if (recs.length === 0) return result("verdict-replies", "Signed replies follow the reply rule", "fail", "no recorded verdicts", paths.verdicts);
    const bad = recs.map((r, i) => [i, checkRecord(file, r, teeSigner).reply]).filter(([, p]) => p);
    return bad.length === 0
      ? result("verdict-replies", "Signed replies follow the reply rule", "live", `all ${recs.length} signed replies hold only the allowed keys and name their own loan_hash and binding (tee/reply.mjs, checked now)`, paths.verdicts)
      : result("verdict-replies", "Signed replies follow the reply rule", "fail", `${bad.length} of ${recs.length} fail: ${bad.slice(0, 3).map(([i, p]) => `results[${i}] ${p}`).join("; ")}`, paths.verdicts);
  });

  // Same boundary as the contract (lib.rs: require!(expires_at_ms >= now)): expiry equal to now is current.
  await run("verdict-binding", "Verdict binding and expiry", paths.verdicts, async () => {
    const problems = [];
    if (file.contract_id !== contract) problems.push(`verdicts are bound to ${file.contract_id}, not ${contract}`);
    if (!Number.isSafeInteger(file.expires_at_ms) || file.binding !== bindingFor(String(file.contract_id), file.expires_at_ms)) problems.push("binding does not match contract, network and expiry");
    if (file.expires_at_ms - file.signed_at_ms !== VERDICT_TTL_MS) problems.push("lifetime is not 30 days");
    if (!(now <= file.expires_at_ms)) problems.push(`expired at ${new Date(file.expires_at_ms).toISOString()}`);
    return problems.length === 0
      ? result("verdict-binding", "Verdict binding and expiry", "live", `bound to ${contract} on testnet; current until ${new Date(file.expires_at_ms).toISOString()} (${((file.expires_at_ms - now) / 86400000).toFixed(1)} days left). Expiry is set by the servicer at signing; the TEE run time is not checked.`, paths.verdicts)
      : result("verdict-binding", "Verdict binding and expiry", "fail", problems.join("; "), paths.verdicts);
  });

  await run("onchain-verdicts", "On-chain verdicts match signed replies", rpcSrc("get_latest_verdict"), async () => {
    const src = rpcSrc("get_latest_verdict, get_lock");
    const recs = Array.isArray(file.results) ? file.results : [];
    const byResp = new Map(recs.filter((r) => r?.onchain?.response_body).map((r) => [sha256Hex(r.onchain.response_body), r]));
    const hashes = [...new Set(recs.map((r) => r.loan_hash))];
    let matched = 0;
    let absent = 0;
    const problems = [];
    for (const h of hashes) {
      const v = await c.view("get_latest_verdict", { loan_hash: h });
      if (v === null || v === undefined) { absent++; continue; }
      // NEW-05: the deployed registry also returns a verdict stored in the same millisecond as the current pledge,
      // which can be the previous pledge's verdict. Same rule as engine/src/score.mjs: strictly after the lock.
      const lock = await c.view("get_lock", { loan_hash: h });
      if (!lock || !(Number(v.at_ms) > Number(lock.locked_at_ms))) {
        problems.push(`${h.slice(0, 12)}... latest verdict is not after the current pledge time (pledge generation ambiguous)`);
        continue;
      }
      const r = byResp.get(v.response_sha256);
      const ok = r && r.loan_hash === h && checkRecord(file, r, teeSigner).sig === null && String(v.signer).toLowerCase() === teeSigner && v.model_id === file.model && v.request_sha256 === r.onchain.request_sha256 && v.attestation_sha256 === status.report_sha256 && v.verdict === r.verdict?.verdict && JSON.stringify(v.anomalies) === JSON.stringify(r.verdict?.anomalies);
      if (ok) matched++;
      else problems.push(`${h.slice(0, 12)}... latest verdict on chain does not match a recorded signed reply`);
    }
    if (problems.length) return result("onchain-verdicts", "On-chain verdicts match signed replies", "fail", problems.slice(0, 3).join("; "), src);
    if (matched === 0) return result("onchain-verdicts", "On-chain verdicts match signed replies", "fail", "no recorded verdict is on chain", src);
    return result("onchain-verdicts", "On-chain verdicts match signed replies", "live", `${matched} latest on-chain verdicts each equal a recorded reply whose signature recovered now to ${teeSigner}; ${absent} recorded loan(s) have no on-chain verdict`, src);
  });

  await run("certificate-signers", "Certificate signers and pledge key", rpcSrc("get_signers"), async () => {
    const src = rpcSrc("get_signers, get_servicer_pledge_key");
    const [signers, pledgeKey] = [await c.view("get_signers"), await c.view("get_servicer_pledge_key")];
    const problems = [];
    if (!sameList(signers, expected.certificate_signers)) problems.push(`certificate signers differ from ${paths.liveRegistry}`);
    if (String(pledgeKey).toLowerCase() !== String(expected.servicer_pledge_address).toLowerCase()) problems.push("servicer pledge key differs");
    return problems.length === 0
      ? result("certificate-signers", "Certificate signers and pledge key", "live", `certificate signers ${lower(signers).join(", ")} and the pledge key match ${paths.liveRegistry}`, src)
      : result("certificate-signers", "Certificate signers and pledge key", "fail", problems.join("; "), src);
  });

  await run("certificates", "Latest fund certificates", rpcSrc("get_latest_certificate"), async () => {
    const src = rpcSrc("get_latest_certificate");
    const funds = [...new Set((Array.isArray(file.results) ? file.results : []).map((r) => r.fund_id))];
    const signers = lower(expected.certificate_signers);
    const rows = [];
    for (const f of funds) {
      const cert = await c.view("get_latest_certificate", { fund_id: f });
      if (!cert) return result("certificates", "Latest fund certificates", "fail", `${f} has no certificate on chain`, src);
      if (cert.certificate?.fund_id !== f || !signers.includes(String(cert.signer).toLowerCase())) return result("certificates", "Latest fund certificates", "fail", `${f} certificate is for another fund or by an unlisted signer`, src);
      rows.push(`${f} ${cert.certificate.band} ${cert.certificate.score}`);
    }
    return result("certificates", "Latest fund certificates", "live", `${rows.join("; ")}; signer recorded by the contract is a listed signer. The contract checked each signature at submission and does not store it, so the panel cannot re-verify it.`, src);
  });

  out.push(result("image-measurements", "TEE image measurements pinned", "unchecked", "the attestation proves a genuine TDX and GPU TEE with debug off; the image measurements (MRTD, RTMR0 to RTMR2) are not compared with a known build", paths.report));
  out.push(result("prompt-binding", "Our prompt and policy ran", "unchecked", "the signature covers sha256 of the request, which stays private; a signed pass proves the attested model replied, not that our prompt ran. A document holder can recompute the request hash to audit it.", paths.verdicts));
  out.push(result("wasm-source", "Deployed code built from this source", "unchecked", "the code hash is compared with the expected hash; the deployed WASM is not rebuilt from source here", paths.liveRegistry));
  return out;
}

/** Checks that need a chain read: when one of them is not live, the panel has no current chain result. */
export const CHAIN_CHECK_IDS = Object.freeze(["registry-code", "receipts-code", "receipts-config", "registry-roles", "tee-signer", "attestation-hash", "onchain-verdicts", "certificate-signers", "certificates"]);

/** Counts per state. green is true only when nothing failed and every chain check was read live just now. */
export function summarize(results) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of results) counts[r.state] = (counts[r.state] || 0) + 1;
  const chainLive = CHAIN_CHECK_IDS.every((id) => results.some((r) => r.id === id && r.state === "live"));
  return { counts, anyFail: counts.fail > 0, chainLive, green: counts.fail === 0 && chainLive };
}

/** Account, live code hash and engine version for the Verify summary. Pending when either receipts check failed. */
export function deploymentStatus(results) {
  const rows = Array.isArray(results) ? results : [];
  const code = rows.find((r) => r.id === "receipts-code");
  const cfg = rows.find((r) => r.id === "receipts-config");
  const account = DEFAULT_RECEIPTS;
  const hashRe = /code hash ([1-9A-HJ-NP-Za-km-z]{32,44})/;
  const keyRe = /version_key ([0-9a-f]{64})/i;
  const codeHash = (code && code.detail && (code.detail.match(hashRe) || [])[1]) || "";
  const engineVersion = (cfg && cfg.detail && (cfg.detail.match(keyRe) || [])[1]) || "";
  const pendingRedeploy = (code && code.state === "fail") || (cfg && cfg.state === "fail") || false;
  const parts = [account];
  if (codeHash) parts.push(`code hash ${codeHash}`);
  if (engineVersion) parts.push(`engine version ${engineVersion}`);
  let line = parts.join(", ");
  if (pendingRedeploy) line = `${line}. Redeploy pending.`;
  else if ((code && code.state === "unchecked") || (cfg && cfg.state === "unchecked")) line = `${line}. Receipts deployment not checked.`;
  else if (code && cfg && code.state === "live" && cfg.state === "live") line = `${line}. Matches the pinned v3 build.`;
  return { account, codeHash, engineVersion, pendingRedeploy, line };
}
