// Checks spec/nav/fixtures.json against the score engine. No second copy of the maths: it imports the engine.
// Usage: node spec/nav/check.mjs   (exits 1 on any mismatch)
import { readFileSync } from "node:fs";
import { scoreFund } from "../../engine/src/score.mjs";

const data = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const model = { pd: data.pd, lgd: data.lgd };

let failed = 0;
for (const fund of data.funds) {
  const r = scoreFund(model, fund, { now: data.valuation_time, certStore: data.cert_store });
  const got = {
    headline: r.headline,
    policy: Math.round(r.policyNav),
    trueVal: Math.round(r.trueVal),
    trueRange: Math.round(r.trueRange),
    trueRangeLow: Math.round(r.trueRangeLow),
    trueRangeHigh: Math.round(r.trueRangeHigh),
    raw: r.rawDisplay,
    score: r.score,
    band: r.band,
    status: r.status,
  };
  console.log(fund.name);
  if (r.flags.includes("no cert store: previously_certified not verifiable")) failed++;
  console.log(`  gap ${r.pillars.gap.toFixed(2)}  coverage ${r.pillars.coverage.toFixed(2)}  freshness ${r.pillars.freshness.toFixed(2)}  penalty ${r.pillars.penalty.toFixed(2)}  raw ${r.raw.toFixed(2)}`);
  for (const [k, v] of Object.entries(fund.expected)) {
    const ok = got[k] === v;
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${k}: expected ${v}, got ${got[k]}`);
  }
}
if (failed) {
  console.error(`${failed} mismatch(es)`);
  process.exit(1);
}
console.log("All worked example numbers match.");
