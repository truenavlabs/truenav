// Fixture-backed dashboard client. Same read shapes as the lab/dashboard-api routes
// (/funds, /fund/:id/history, /fund/:id/alerts, /watchlist), served from local files.
// No network, no wallet, no transaction. Only read routes exist here.
import { NAMES } from "../copy";
import { scores } from "../data";
import { bandOf, publicV3, type Band, type PublicReceipt } from "../public";

export type FundRow = { kind: "fixture"; token_id: string; name: string; receipt: PublicReceipt };

// Example rows: illustrative, not fixtures, never a receipt. Money in integer cents like the receipt fields.
export type ExampleRow = {
  kind: "example";
  id: string;
  name: string;
  score: number;
  band: Band;
  trueval: string;
  truerange_low: string;
  truerange_high: string;
  reported_nav: string;
  nav_result: "inside" | "outside_high" | "outside_low";
  loans: string;
  attempts: number;
};

export const EXAMPLE_ROWS: ExampleRow[] = [
  { kind: "example", id: "ex1", name: "Example Receivables I", score: 88, band: bandOf(88), trueval: "212000000", truerange_low: "198000000", truerange_high: "226000000", reported_nav: "205000000", nav_result: "inside", loans: "from_20_to_49", attempts: 0 },
  { kind: "example", id: "ex2", name: "Example SME Term Loans", score: 71, band: bandOf(71), trueval: "58000000", truerange_low: "49000000", truerange_high: "67000000", reported_nav: "64000000", nav_result: "inside", loans: "from_10_to_19", attempts: 0 },
];

export type HistoryPoint = { label: string; score: number; source: "example" | "fixture" };

// Score series: example data. The last point of each series is the fixture receipt.
const SERIES: Record<string, [string, number][]> = {
  "harbor-credit-fund": [["Jun", 99], ["Jul", 99], ["Aug", 96], ["Sep", 99], ["Oct", 99]],
  "meridian-yield-fund": [["Jun", 78], ["Jul", 74], ["Aug", 71], ["Sep", 68], ["Oct", 64]],
};

export type Alert = { at: string; kind: "score_drop" | "band_change" | "nav_outside_range"; text: string; source: "example" | "fixture" };

export function listFunds(): FundRow[] {
  return scores.map((s) => {
    const receipt = publicV3(s);
    return { kind: "fixture", token_id: receipt.token_id, name: NAMES[receipt.token_id] ?? receipt.token_id, receipt };
  });
}

export function getFund(tokenId: string): FundRow | undefined {
  return listFunds().find((f) => f.token_id === tokenId);
}

export function history(tokenId: string): HistoryPoint[] {
  const fund = getFund(tokenId);
  if (!fund || fund.receipt.score === null) return [];
  const pts: HistoryPoint[] = (SERIES[tokenId] ?? []).map(([label, score]) => ({ label, score, source: "example" }));
  pts.push({ label: "Nov", score: fund.receipt.score, source: "fixture" });
  return pts;
}

// Alert rule from the dashboard API: a drop of 10 points or more, a band change, or NAV outside TrueRange.
export function alerts(tokenId: string): Alert[] {
  const pts = history(tokenId);
  const fund = getFund(tokenId);
  const out: Alert[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const src = b.source;
    if (a.score - b.score >= 10) out.push({ at: b.label, kind: "score_drop", text: `score fell ${a.score - b.score} points, ${a.score} to ${b.score}`, source: src });
    if (bandOf(a.score) !== bandOf(b.score)) out.push({ at: b.label, kind: "band_change", text: `band moved ${bandOf(a.score)} to ${bandOf(b.score)}`, source: src });
  }
  if (fund && fund.receipt.nav_result !== "inside") out.push({ at: "Nov", kind: "nav_outside_range", text: "reported NAV is outside TrueRange", source: "fixture" });
  return out.reverse();
}

const WATCH_KEY = "truenav-watchlist";
export function watchlist(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export function toggleWatch(tokenId: string): string[] {
  const cur = new Set(watchlist());
  if (cur.has(tokenId)) cur.delete(tokenId);
  else cur.add(tokenId);
  const next = [...cur];
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(next));
  } catch {
    /* private mode: keep it in memory only */
  }
  return next;
}
