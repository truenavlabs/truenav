// Browser recompute wiring: engine input (spec/nav/fixtures.json, recorded) + live TEE verdict store -> engine result.
import { useMemo } from "react";
import fixturesJson from "../../../spec/nav/fixtures.json";
import loanMapJson from "../../data/loan-map.json";
import { compareWithCertificate, recomputeScores, teeStoreFrom, whyThisScore } from "../../data/recompute.mjs";
import type { Registry } from "./store";

export const FIXTURES = fixturesJson as unknown as {
  valuation_time: string; pd: Record<string, number>; lgd: Record<string, number>; cert_store: unknown;
  funds: { fund_id: string; name: string; headline_nav: number; policy_markdown: Record<string, number>; blocked_attempts: { action_id: string; age_days: number }[]; loans: FixtureLoan[] }[];
};
export type FixtureLoan = { id: string; asset: string; principal: number; accrued: number; repaid: number; bucket: string; nft: boolean; anomaly: boolean; servicer_asof: string; note?: string; dpd?: number };
export const LOAN_MAP = (loanMapJson as { loans: { fund_id: string; loan_id: string; loan_hash: string; asset_type: string }[] }).loans;
export type EngineResult = ReturnType<typeof recomputeScores>[number];

export const loanIdOf = (hash: string) => LOAN_MAP.find((l) => l.loan_hash === hash)?.loan_id ?? null;
export const fixtureLoan = (loanId: string | null) => {
  if (!loanId) return null;
  for (const f of FIXTURES.funds) for (const l of f.loans) if (l.id === loanId) return { fund: f.fund_id, loan: l };
  return null;
};

export function runRecompute(view: Registry, fixtures = FIXTURES, teeOverride?: Record<string, unknown>) {
  const teeStore = teeOverride ?? teeStoreFrom(view);
  const results = recomputeScores({ fixtures, loanMap: LOAN_MAP, teeStore });
  return results.map((r) => {
    const stored = view.funds.find((f) => f.fund_id === r.fundId)?.certificate ?? null;
    return { r, cmp: compareWithCertificate(r, stored), why: whyThisScore(r) };
  });
}

export function useRecompute(view: Registry) {
  return useMemo(() => runRecompute(view), [view]);
}
