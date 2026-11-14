// View helpers for the recorded attestation evidence (web/data/recorded/attestation-evidence.json). Text only.

export type AttestationEvidence = {
  schema: string;
  commit: string;
  ok: boolean;
  commands: string[];
  outlayer: {
    project: string; wasm_sha256: string; api: string; worker_registry: string; loans_checked: number; distinct_quotes: number;
    approved_measurement_sets: number; checks_per_record: string[];
    records: { document_id: string; asset_type: string; loan_hash: string; call_id: string; proof_url: string; pass: boolean }[];
  };
  near_ai: {
    contract: string; recorded_set: string; model: string; signer: string; report_sha256: string; nonce: string;
    report_captured_at: string; verdicts_signed: number; checks: { section: string | null; check: string; pass: boolean }[];
  };
  proves: string[];
  not_proves: string[];
  ephemeral: { generated_at: string; wall_ms: number; node: string };
  evidence_hash: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
const BANGKOK_OFFSET_MS = 7 * 3600 * 1000;

/** "14 Nov 18:55" from a time already shifted into the zone's wall clock (read with the UTC getters). */
function wall(shifted: Date): string {
  return `${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]} ${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}`;
}

/** One line: when the recorded run was made, in Bangkok and UTC time, on which commit, and that it was not re-run in the browser. */
export function lastVerifiedLine(s: Pick<AttestationEvidence, "commit" | "ephemeral">): string {
  const t = Date.parse(s.ephemeral.generated_at);
  if (Number.isNaN(t)) throw new Error("attestation evidence has no valid generated_at time");
  return `Last verified ${wall(new Date(t + BANGKOK_OFFSET_MS))} Bangkok (${wall(new Date(t))} UTC) on commit ${s.commit.slice(0, 7)}. This is a recorded run of npm run verify:fingerprints and npm run verify:attestation, not a check made in your browser.`;
}
