// Recompute each fund's TrueNav score in the browser, exactly as certify/chain-read.mjs does from the command line:
// the engine (engine/src/score.mjs, no imports) runs on the committed engine input (spec/nav/fixtures.json) plus the
// TEE verdict store read live from the registry, then the result is compared with the signed certificate on chain.
import { scorePortfolio } from "../../engine/src/score.mjs";

/** The engine's TEE verdict store from a loadRegistry() result (same shape web/chain.mjs loadChainState builds). */
export function teeStoreFrom(reg) {
  const store = {};
  for (const l of reg.loans || []) {
    if (!l.lock) continue;
    store[l.loan_hash] = { fund_id: l.lock.fund_id, pledged_at_ms: l.lock.locked_at_ms, latest: l.latest ? { verdict: l.latest.verdict, anomalies: l.latest.anomalies, at_ms: l.latest.at_ms } : null };
  }
  return store;
}

/**
 * @param {{fixtures:object, loanMap:{fund_id,loan_id,loan_hash}[], teeStore:object}} p
 * @returns per fund: engine result plus rawX100 rounded the way the certificate stores it
 */
export function recomputeScores({ fixtures, loanMap, teeStore }) {
  const funds = JSON.parse(JSON.stringify(fixtures.funds));
  for (const f of funds) for (const l of f.loans) {
    const m = loanMap.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
    if (m) l.loan_hash = m.loan_hash;
  }
  const results = scorePortfolio({ pd: fixtures.pd, lgd: fixtures.lgd }, funds, { now: fixtures.valuation_time, certStore: fixtures.cert_store, teeStore });
  return results.map((r) => ({ ...r, rawX100: Math.round(r.raw * 100), rawRounded: Math.round(r.raw * 100) / 100 }));
}

/** Compare one recomputed result with the stored certificate: score, band, raw, TrueVal and TrueRange. */
export function compareWithCertificate(r, stored) {
  const c = stored && stored.certificate;
  if (!c) return { match: false, reason: "no certificate on chain", rows: [] };
  const cents = (x) => Math.round(x * 100);
  const rows = [
    ["raw score x100", r.rawX100, c.raw_x100],
    ["score", r.score, c.score],
    ["band", r.band || "", c.band],
    ["TrueVal (cents)", cents(r.trueVal), Number(c.true_val_cents)],
    ["TrueRange (cents)", cents(r.trueRange), Number(c.true_range_cents)],
    ["policy NAV (cents)", cents(r.policyNav), Number(c.policy_nav_cents)],
    ["headline NAV (cents)", cents(r.headline), Number(c.headline_cents)],
  ].map(([k, mine, chain]) => ({ k, mine, chain, ok: k.includes("cents") ? Math.abs(mine - chain) <= 1 : mine === chain }));
  return { match: rows.every((x) => x.ok), rows };
}

/** Plain-language reasons behind a score, from the engine result (holds, caps, exclusions, pillars). */
export function whyThisScore(r) {
  const out = [];
  if (r.gap && r.gap.beyond > 0) out.push({ kind: "gap", text: `Reported NAV is ${r.gap.boundSide === "over" ? "above" : "below"} TrueRange by $${Math.round(r.gap.beyond).toLocaleString("en-US")}.` });
  if (r.unverified && r.unverified.reasons && r.unverified.reasons.length) for (const u of r.unverified.reasons) out.push({ kind: "excluded", text: `Loan ${u.id} left out of TrueVal: ${u.reason}.` });
  if (r.penaltyDetail && r.penaltyDetail.attemptsCounted) out.push({ kind: "penalty", text: `${r.penaltyDetail.attemptsCounted} blocked double pledge attempt(s) in the last 90 days cost ${r.penaltyDetail.own.toFixed(1)} points.` });
  if (r.concentration && r.concentration.largestBreach) out.push({ kind: "concentration", text: `Largest loan is ${(r.concentration.largestShare * 100).toFixed(0)}% of exposure (flag only, no score impact).` });
  if (r.noGreenCapApplied) out.push({ kind: "cap", text: "Capped below green." });
  if (r.tee) out.push({ kind: "tee", text: `Enclave verdicts: ${r.tee.pass} pass, ${r.tee.flag} flag, ${r.tee.pending} pending, ${r.tee.overdue} overdue.` });
  if (r.dataAgeHours !== undefined && r.dataAgeHours !== null) out.push({ kind: "freshness", text: `Servicer data was ${r.dataAgeHours} hours old at valuation.` });
  return out;
}
