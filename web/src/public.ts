// The disclosure guard for public views. Same 37 fields as PUBLIC_V3_FIELDS in api/receipt.mjs
// (lab/dashboard-api). A public view reads a receipt only through publicV3().
export const PUBLIC_V3_FIELDS = [
  "receipt_version", "token_id", "seq", "method_version", "engine_version_key", "period_start", "period_end",
  "data_as_of", "valuation_time", "score", "band", "parts_band", "caps", "holds", "freshness_band", "currency",
  "reported_nav", "trueval", "truerange_low", "truerange_high", "nav_result", "nav_gap_band", "unverified_share_band",
  "pledge_scope", "pledge_result", "pledge_coverage_bps", "loans_checked", "blocked_attempts", "cash_evidence_status",
  "cash_match_band", "yield_gap_band", "collection_rate_band", "late_share_band", "late_loan_cohorts", "exceptions",
  "synthetic", "receipt_sha256",
] as const;

export type PublicField = (typeof PUBLIC_V3_FIELDS)[number];
export type Band = "green" | "yellow" | "red";

export type PublicReceipt = {
  receipt_version: string;
  token_id: string;
  seq: string;
  method_version: string;
  engine_version_key: string;
  period_start: string;
  period_end: string;
  data_as_of: string;
  valuation_time: string;
  score: number | null;
  band: Band | string;
  parts_band: { coverage: string; nav_gap: string; freshness: string; penalty: string };
  caps: string[];
  holds: string[];
  freshness_band: string;
  currency: string;
  reported_nav: string;
  trueval: string;
  truerange_low: string;
  truerange_high: string;
  nav_result: string;
  nav_gap_band: string;
  unverified_share_band: string;
  pledge_scope: { registry_account: string; block_height: string; block_hash: string; scope_id: string; coverage_status: string };
  pledge_result: string;
  pledge_coverage_bps: number;
  loans_checked: string;
  blocked_attempts: string;
  cash_evidence_status: string;
  cash_match_band: string;
  yield_gap_band: string;
  collection_rate_band: string;
  late_share_band: string;
  late_loan_cohorts: Record<string, string | number>;
  exceptions: { code: string; band: string }[];
  synthetic: boolean;
  receipt_sha256: string;
};

const ALLOWED = new Set<string>(PUBLIC_V3_FIELDS);

// Keeps only allowlisted keys and refuses a non-integer public score.
export function publicV3(receipt: object): PublicReceipt {
  const src = receipt as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_V3_FIELDS) if (Object.hasOwn(src, k)) out[k] = src[k];
  const score = out.score;
  if (score !== null && score !== undefined && !(typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100)) {
    throw new Error("public score must be a whole number from 0 to 100");
  }
  return out as PublicReceipt;
}

export const isPublicField = (k: string) => ALLOWED.has(k);

export function bandOf(score: number): Band {
  if (score >= 85) return "green";
  if (score >= 60) return "yellow";
  return "red";
}
