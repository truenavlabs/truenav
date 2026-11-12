// Committed evidence files, bundled at build time and tagged "recorded" wherever shown.
import statusJson from "../../../tee/status.json";
import liveRegistryJson from "../../../certify/live-registry.json";
import verdictsJson from "../../../tee/fixtures/verdicts-368aa2.json";

export type VerdictRecord = {
  loan_id: string; fund_id: string; loan_hash: string; tampered: { id: string; expected_anomaly: string } | null;
  tries?: { request_sha256: string; response_sha256: string; verdict: string; anomalies: string[]; checks_passed: boolean }[];
  verdict: { verdict: string; anomalies: string[]; [k: string]: unknown };
  checks: Record<string, boolean>; ok: boolean;
  onchain?: { loan_hash: string; model_id: string; request_sha256: string; response_body: string; signature: string; signer: string; [k: string]: unknown };
};
export const STATUS = statusJson as Record<string, string | number>;
export const LIVE_REGISTRY = liveRegistryJson as Record<string, unknown> & { roles: Record<string, string | boolean>; code_hash: string; certificate_signers: string[]; servicer_pledge_address: string };
export const VERDICTS = verdictsJson as unknown as { model: string; contract_id: string; binding: string; signed_at_ms: number; expires_at_ms: number; attestation: { nonce: string; checked_at: string; report_sha256?: string; signers: { signing_address: string }[]; sections: { name: string; checks: { check: string; pass: boolean; detail: string }[] }[] }; results: VerdictRecord[] };
export const recordFor = (hash: string) => VERDICTS.results.find((r) => r.loan_hash === hash && !r.tampered) ?? null;

/** Evidence object for the verifier data layer; the 388 KB attestation report loads only when asked for. */
export async function loadVerifierEvidence() {
  const reportB64 = (await import("../../../tee/fixtures/attestation-report-368aa2.json.b64?raw")).default as string;
  return { status: statusJson, liveRegistry: liveRegistryJson, verdicts: verdictsJson, reportB64, paths: { status: "tee/status.json", liveRegistry: "certify/live-registry.json", verdicts: STATUS.verdicts_file, report: STATUS.report_file } };
}
