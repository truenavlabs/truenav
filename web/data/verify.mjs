// Web wrapper over the verifier data layer (web/verifier). Adds two things the panel needs:
// 1. Checks that need the signature and hash library show as "unchecked" with a plain reason while @noble is not
//    approved for the web build (the bundle stubs it; see web/src/lib/crypto-pending.mjs). They never show as passed.
// 2. A tamper test that changes recorded evidence in memory only and re-runs, so a visitor can watch a row turn red.
import { runVerifierChecks, summarize, CHAIN_CHECK_IDS } from "../verifier/index.mjs";

export const PENDING_RE = /crypto library pending approval/;
export const PENDING_DETAIL = "Needs the signature and hash library, which is pending approval for the web build. Not checked in this browser; run npm run judge or npm run verify:attestation to check it locally.";

export const TAMPERS = Object.freeze({
  none: "No tamper: the evidence exactly as committed.",
  signer: "Change one character of the recorded TEE signer address.",
  reply: "Change the verdict inside one recorded signed reply from pass to flag.",
  binding: "Move the recorded verdict expiry by one millisecond, so the binding no longer matches.",
});

function tampered(evidence, kind) {
  if (!kind || kind === "none") return evidence;
  const ev = JSON.parse(JSON.stringify({ status: evidence.status, liveRegistry: evidence.liveRegistry, verdicts: evidence.verdicts, paths: evidence.paths }));
  ev.reportB64 = evidence.reportB64;
  if (kind === "signer") {
    const s = String(ev.status.tee_signer);
    ev.status.tee_signer = s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
  } else if (kind === "reply") {
    const PASS = '\\"verdict\\":\\"pass\\"';
    const r = ev.verdicts.results.find((x) => x.onchain && typeof x.onchain.response_body === "string" && x.onchain.response_body.includes(PASS));
    if (r) r.onchain.response_body = r.onchain.response_body.replace(PASS, PASS.replace("pass", "flag"));
  } else if (kind === "binding") {
    ev.verdicts.expires_at_ms = Number(ev.verdicts.expires_at_ms) + 1;
  } else throw new Error(`unknown tamper ${kind}`);
  return ev;
}

/** Run the checks; returns { checks, summary, tamper }. */
export async function runWebChecks({ evidence, chain, now, tamper = "none" } = {}) {
  const ev = tampered(evidence, tamper);
  const raw = await runVerifierChecks({ evidence: ev, chain, now });
  let checks = raw.map((r) => (r.state === "fail" && PENDING_RE.test(r.detail) ? Object.freeze({ ...r, state: "unchecked", detail: PENDING_DETAIL, pendingLibrary: true }) : r));
  // The report hash needs only sha256, which every browser has built in (WebCrypto): run it with that instead.
  const i = checks.findIndex((c) => c.id === "attestation-hash" && c.pendingLibrary);
  if (i >= 0 && globalThis.crypto && globalThis.crypto.subtle && chain) {
    checks = checks.slice();
    checks[i] = await attestationHashWebCrypto(ev, chain, checks[i]);
  }
  return { checks, summary: webSummary(checks), tamper };
}

async function sha256HexWeb(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
const b64Bytes = (b64) => Uint8Array.from(atob(String(b64).replace(/\s+/g, "")), (c) => c.charCodeAt(0));

/** Same rule as the verifier's attestation-hash check, with WebCrypto sha256. */
export async function attestationHashWebCrypto(ev, chain, prev) {
  const status = ev.status || {}, file = ev.verdicts || {};
  const teeSigner = String(status.tee_signer || "").toLowerCase();
  const base = { id: "attestation-hash", label: "Published attestation report hash", source: prev ? prev.source : "attestation report; get_tee_signers" };
  const sha = ev.reportB64 ? await sha256HexWeb(b64Bytes(ev.reportB64)) : "";
  if (!sha || sha !== status.report_sha256 || sha !== (file.attestation && file.attestation.report_sha256)) {
    return Object.freeze({ ...base, state: "fail", detail: `sha256 of the published report (${sha.slice(0, 16)}...) does not equal the hash in tee/status.json and the verdicts file`, webCrypto: true });
  }
  let tee;
  try { tee = await chain.view("get_tee_signers"); } catch (e) {
    return Object.freeze({ ...base, state: "unchecked", detail: `could not read the registry: ${e && e.message ? e.message : e}. Not checked.`, webCrypto: true });
  }
  const ok = (Array.isArray(tee) ? tee : []).some((t) => t.attestation_sha256 === sha && String(t.address).toLowerCase() === teeSigner);
  return Object.freeze({ ...base, state: ok ? "live" : "fail", detail: ok ? `sha256 ${sha} computed now in this browser (WebCrypto) equals the hash the contract stores for ${teeSigner}` : "the contract stores no TEE signer with this report hash", webCrypto: true });
}

/** Like summarize(), plus what this browser could run: green only if nothing failed and every runnable chain check was live. */
export function webSummary(checks) {
  const base = summarize(checks);
  const pending = checks.filter((c) => c.pendingLibrary).map((c) => c.id);
  const runnableChain = CHAIN_CHECK_IDS.filter((id) => !pending.includes(id));
  const runnableLive = runnableChain.every((id) => checks.some((c) => c.id === id && c.state === "live"));
  return { ...base, pending, runnableGreen: base.counts.fail === 0 && runnableLive };
}
