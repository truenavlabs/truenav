// Committed evidence files, bundled at build time and tagged "recorded" wherever shown.
import statusJson from "../../../tee/status.json";
import liveRegistryJson from "../../../certify/live-registry.json";
import verdictsJson from "../../../tee/fixtures/verdicts-368aa2.json";
import v3BuildJson from "../../../receipts/v3-build.json";
import pinnedBuildsJson from "../../../receipts/pinned-builds.json";
import receiptsLiveJson from "../../data/recorded/receipts-live.json";

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
  const build = v3BuildJson as { method_version?: string; engine?: { sha256?: string } };
  const pinned = pinnedBuildsJson as { receipts?: string };
  // The known live v2 build (plan B), from the committed read of the live contract. v3 is pinned, not deployed.
  const live = receiptsLiveJson as { code_sha256?: string; get_config?: { config?: { method?: string; version_key?: string } } };
  return {
    status: statusJson,
    liveRegistry: liveRegistryJson,
    verdicts: verdictsJson,
    reportB64,
    receipts: {
      account: "receipts.tnlab-718ca9.testnet",
      sha256: pinned.receipts,
      engineSha256: build.engine && build.engine.sha256,
      method: build.method_version || "truenav-v3.0.1",
      storage_deposit: "350000000000000000000000",
      outlayer_tgas: 200,
      callback_tgas: 80,
      outlayer: "outlayer.testnet",
      liveV2: { sha256: live.code_sha256, method: live.get_config?.config?.method, version_key: live.get_config?.config?.version_key },
    },
    paths: { status: "tee/status.json", liveRegistry: "certify/live-registry.json", verdicts: STATUS.verdicts_file, report: STATUS.report_file, receiptsPin: "receipts/pinned-builds.json", receiptsBuild: "receipts/v3-build.json" },
  };
}
