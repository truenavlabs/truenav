// Prints the cashflow-v2.1.0 result for each synthetic demo fund: score, band, the reason for every red-flag cap,
// and the public aggregates only (no names, no unit ids, cohorts under 5 suppressed). All data is synthetic.
//   npm run cashflow:demo
import { datasets, AS_OF, PERIOD, DAYS_IN_PERIOD } from "./data.mjs";
import { runFund } from "../run.mjs";
import { COHORTS } from "../metrics.mjs";
import { METHOD } from "../../spec/v2/score.mjs";

const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const usd = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
console.log(`TrueNav ${METHOD}, period ${PERIOD}, as of ${AS_OF}. SYNTHETIC DATA: every fund, borrower, tenant and bank record is fictional.\n`);
for (const ds of datasets()) {
  const r = runFund(ds, { key: "demo-pseudonym-key-not-secret", asOf: `${AS_OF}T00:00:00Z`, period: PERIOD, daysInPeriod: DAYS_IN_PERIOD, bankFetchedAt: "2026-10-31T22:00:00Z" });
  const m = r.public_metrics;
  console.log(`${ds.name} (${ds.id}, ${ds.kind}): TrueNav score ${r.score.score} ${r.score.band}${r.score.caps.length ? ` (uncapped ${r.score.uncapped_score})` : ""}`);
  for (const c of r.score.caps) console.log(`  ${c.reason}`);
  console.log(`  cash match ${pct(m.cash_match_bps)} of ${usd(m.claimed_cash_cents)} claimed; never settled ${usd(m.exceptions.claimed_not_settled_cents)}`);
  if (m.kind === "credit") console.log(`  reported yield ${pct(m.reported_yield_bps)}, cash yield ${pct(m.cash_yield_bps)}; interest added to loans ${usd(m.capitalized_interest_cents)} (not cash)`);
  else console.log(`  rent collected ${usd(m.rent_collected_cents)} of ${usd(m.rent_due_cents)} due (collection ${pct(m.collection_rate_bps)}, occupancy ${pct(m.occupancy_bps)}); net operating cash ${usd(m.net_operating_cash_cents)} vs payouts ${usd(m.distributions_cents)} (coverage ${(m.rental_coverage_bps / 10000).toFixed(2)})`);
  const c = m.collection;
  console.log(`  collection ${c.period} (cutoff ${c.cutoff}): ${c.status === "verified" ? `${pct(c.rate_bps)} of ${usd(c.dues_cents)} contractual dues bank-confirmed` : c.status === "pending" ? "pending" : "no dues (N/A)"}`);
  for (const h of r.score.holds || []) console.log(`  ${h.reason}`);
  console.log(`  late cohorts: ${COHORTS.map(([k]) => [k, m.cohorts[k]]).map(([k, v]) => `${k} ${v.suppressed ? "fewer than 5" : v.units}`).join(", ")}`);
  console.log(`  evidence: ${r.passport.map((p) => `${p.source} tier ${p.tier}${p.synthetic ? " (synthetic)" : ""}`).join("; ")}\n`);
}
