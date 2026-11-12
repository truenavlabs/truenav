import { canonical } from "./canonical";

export type StepName = "signature" | "attestation" | "fund binding" | "freshness";
export type Step = { name: StepName; result: "pass" | "fail"; detail: string };

export type VerifierResult = {
  attestation_status: "verified" | "unavailable" | "invalid";
  reason_codes: string[];
};

const BINDING: Record<string, string> = {
  "harbor-credit-fund": "harbor.sim.testnet",
  "meridian-yield-fund": "meridian.sim.testnet",
};

const FRESH_PASS = new Set(["lte_24h", "gt_24_lte_72h"]);

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function failAll(detail: string): { steps: Step[]; verifier: VerifierResult } {
  const names: StepName[] = ["signature", "attestation", "fund binding", "freshness"];
  return {
    steps: names.map((name) => ({ name, result: "fail", detail })),
    verifier: { attestation_status: "invalid", reason_codes: ["schema_invalid"] },
  };
}

export async function mockCheck(value: unknown): Promise<{ steps: Step[]; verifier: VerifierResult }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failAll("body must be JSON");
  const receipt = value as Record<string, unknown>;
  const keys = Array.isArray(receipt.source_key_ids) ? receipt.source_key_ids : [];
  const sigOk =
    keys.length === 4 &&
    keys.every((row) => !!row && typeof row === "object" && (row as { sig_ok?: unknown }).sig_ok === true);
  let hashOk = false;
  if (typeof receipt.receipt_sha256 === "string") {
    const { receipt_sha256: hash, ...preimage } = receipt;
    hashOk = (await sha256Hex(canonical(preimage))) === hash;
  }
  const attestationRef = receipt.attestation_ref;
  const attestationShape = typeof attestationRef === "string" && /^sha256:[0-9a-f]{64}$/.test(attestationRef);
  const token = typeof receipt.token_id === "string" ? receipt.token_id : "";
  const account = typeof receipt.fund_account === "string" ? receipt.fund_account : "";
  const bindingPass = account.length > 0 && BINDING[token] === account;
  const fresh = typeof receipt.freshness_band === "string" ? receipt.freshness_band : "";
  const freshPass = FRESH_PASS.has(fresh);

  const reasons: string[] = [];
  if (!sigOk) reasons.push("source_signature_invalid");
  if (!hashOk) reasons.push("hash_mismatch");
  let attestation_status: VerifierResult["attestation_status"] = "invalid";
  if (attestationRef === null) {
    attestation_status = "unavailable";
    reasons.push("attestation_missing");
  } else if (!attestationShape) {
    reasons.push("attestation_invalid");
  } else {
    attestation_status = "unavailable";
    reasons.push("evidence_unavailable");
  }
  if (!token || !account) reasons.push("schema_invalid");

  return {
    verifier: { attestation_status, reason_codes: [...new Set(reasons)] },
    steps: [
      {
        name: "signature",
        result: sigOk && hashOk ? "pass" : "fail",
        detail: sigOk && hashOk ? "source signatures ok and receipt_sha256 matches" : "source signature or receipt_sha256 check failed",
      },
      {
        name: "attestation",
        result: attestationShape ? "pass" : "fail",
        detail: attestationRef === null ? "attestation_ref is null" : attestationShape ? "attestation_ref present" : "attestation_ref is not a sha256 ref",
      },
      {
        name: "fund binding",
        result: bindingPass ? "pass" : "fail",
        detail: bindingPass ? "token_id is bound to fund_account" : "token_id is not bound to fund_account",
      },
      {
        name: "freshness",
        result: freshPass ? "pass" : "fail",
        detail: fresh ? `freshness_band ${fresh}` : "freshness_band missing",
      },
    ],
  };
}
