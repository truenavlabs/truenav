// Every number the marketing pages show, derived from the committed testnet fixtures (src/fixtures) through the
// public 37-field guard. Nothing here is typed in by hand: change a fixture and these change with it.
import { reports, scores } from "../data";
import { NAMES } from "../copy";
import { human, usdM } from "../format";
import { publicV3 } from "../public";

const rows = scores.map(publicV3);

// Public receipts carry blocked_attempts as a band. Only the exact bands are summed; anything else is not a count.
const EXACT: Record<string, number> = { zero: 0, one: 1 };

export type Count = { value: string; label: string; source: string };

export function counts(): Count[] {
  const blocked = rows.map((r) => EXACT[r.blocked_attempts]);
  const exact = blocked.every((n) => n !== undefined);
  return [
    { value: String(rows.length), label: "demo funds scored", source: "src/fixtures/*-score.json" },
    { value: String(reports.filter((r) => r.receipt && r.receipt_sha256).length), label: "demo receipts issued", source: "src/fixtures/*-report.json" },
    {
      value: exact ? String(blocked.reduce((a, b) => a + b, 0)) : "n/a",
      label: "demo double pledges refused",
      source: "blocked_attempts in src/fixtures/*-score.json",
    },
  ];
}

export type FundFact = {
  id: string; name: string; score: number; band: string; reported: string; trueval: string; low: string; high: string;
  inside: boolean; result: string; gap: string; sha: string; pledge: string; method: string;
};

export function fund(id: string): FundFact {
  const r = rows.find((x) => x.token_id === id);
  if (!r) throw new Error(`no fixture for ${id}`);
  return {
    id, name: NAMES[id] ?? id, score: r.score ?? 0, band: r.band, reported: usdM(r.reported_nav), trueval: usdM(r.trueval),
    low: usdM(r.truerange_low), high: usdM(r.truerange_high), inside: r.nav_result === "inside", result: human(r.nav_result),
    gap: human(r.nav_gap_band), sha: r.receipt_sha256, pledge: human(r.pledge_result), method: r.method_version,
  };
}

export const HARBOR = "harbor-credit-fund";
export const MERIDIAN = "meridian-yield-fund";

// Public receipt JSON as the manager card shows it: only allowlisted fields, no loan rows.
export function publicLines(id: string): [string, string][] {
  const r = rows.find((x) => x.token_id === id)!;
  return [
    ["token_id", r.token_id], ["seq", r.seq], ["score", String(r.score)], ["band", r.band], ["nav_result", r.nav_result],
    ["pledge_result", r.pledge_result], ["loans_checked", r.loans_checked], ["synthetic", String(r.synthetic)],
    ["receipt_sha256", r.receipt_sha256.slice(0, 16) + "..."],
  ];
}

export const PUBLIC_FIELD_COUNT = 37;
