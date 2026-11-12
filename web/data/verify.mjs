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
  const raw = await runVerifierChecks({ evidence: tampered(evidence, tamper), chain, now });
  const checks = raw.map((r) => (r.state === "fail" && PENDING_RE.test(r.detail) ? Object.freeze({ ...r, state: "unchecked", detail: PENDING_DETAIL, pendingLibrary: true }) : r));
  return { checks, summary: webSummary(checks), tamper };
}

/** Like summarize(), plus what this browser could run: green only if nothing failed and every runnable chain check was live. */
export function webSummary(checks) {
  const base = summarize(checks);
  const pending = checks.filter((c) => c.pendingLibrary).map((c) => c.id);
  const runnableChain = CHAIN_CHECK_IDS.filter((id) => !pending.includes(id));
  const runnableLive = runnableChain.every((id) => checks.some((c) => c.id === id && c.state === "live"));
  return { ...base, pending, runnableGreen: base.counts.fail === 0 && runnableLive };
}
