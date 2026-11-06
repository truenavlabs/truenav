// Scores the recorded eval run offline (no key): re-checks every reply's TEE signature and its binding to the
// loan, then computes detection metrics. Writes tee/eval/metrics.json.   npm run eval
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { eip191Recover, readVerdict } from "../underwrite.mjs";

const root = new URL("../../", import.meta.url);
const run = JSON.parse(readFileSync(new URL("tee/eval/results.json", root), "utf8"));
const attested = run.attestation.signers.map((s) => s.signing_address.toLowerCase());
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

let bad = 0;
const rows = run.results.map((r) => {
  if (!r.onchain) return { ...r, signed: false, predicted: "error" };
  const o = r.onchain;
  const signer = eip191Recover(`${o.model_id}:${o.request_sha256}:${sha(o.response_body)}`, o.signature);
  const v = readVerdict(Buffer.from(o.response_body, "utf8"));
  const signed = attested.includes(signer) && v.loan_hash === o.loan_hash;
  if (!signed) bad++;
  return { ...r, signed, predicted: v.verdict, codes: v.anomalies };
});

const pos = rows.filter((r) => r.expect === "flag");
const neg = rows.filter((r) => r.expect === "pass");
const tp = pos.filter((r) => r.predicted === "flag").length;
const fn = pos.length - tp;
const fp = neg.filter((r) => r.predicted === "flag").length;
const tn = neg.length - fp;
const pct = (x) => Math.round(x * 1000) / 10;
const categories = {};
for (const r of rows) {
  const c = (categories[r.category] ||= { cases: 0, flagged: 0, expected_code: 0, passed: 0 });
  c.cases++;
  if (r.predicted === "flag") c.flagged++;
  if (r.predicted === "pass") c.passed++;
  if (r.expect_code && (r.codes || []).includes(r.expect_code)) c.expected_code++;
}
const variants = {};
for (const r of rows.filter((x) => x.variant)) {
  const k = `${r.category}: ${r.variant}`;
  const v = (variants[k] ||= { cases: 0, flagged: 0 });
  v.cases++;
  if (r.predicted === "flag") v.flagged++;
}
const metrics = {
  model: run.model,
  run_at: run.run_at,
  cases: rows.length,
  signatures_verified: rows.length - bad,
  confusion: { tp, fn, fp, tn },
  precision_flag_pct: pct(tp / (tp + fp)),
  recall_flag_pct: pct(tp / (tp + fn)),
  false_positive_rate_pct: pct(fp / (fp + tn)),
  categories,
  variants,
  false_positives: neg.filter((r) => r.predicted === "flag").map((r) => ({ id: r.id, codes: r.codes })),
  misses: pos.filter((r) => r.predicted !== "flag").map((r) => ({ id: r.id, category: r.category, variant: r.variant })),
};
writeFileSync(new URL("tee/eval/metrics.json", root), JSON.stringify(metrics, null, 2) + "\n");
console.log(`${rows.length} cases, ${rows.length - bad} signatures verified against the attested TEE key`);
console.log(`flag precision ${metrics.precision_flag_pct}%, recall ${metrics.recall_flag_pct}%, false positive rate ${metrics.false_positive_rate_pct}% (tp ${tp}, fn ${fn}, fp ${fp}, tn ${tn})`);
for (const [k, c] of Object.entries(categories)) console.log(`  ${k.padEnd(17)} ${c.cases} cases: ${c.flagged} flagged, ${c.passed} passed${c.expected_code ? `, expected code ${c.expected_code}` : ""}`);
process.exitCode = bad === 0 && tp + fn > 0 ? 0 : 1;
