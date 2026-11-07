// Scores the recorded eval runs offline (no key): re-checks every reply's TEE signature and its binding to the
// loan, checks the reply rule (allowed keys only), then computes detection metrics two ways (owner decision 7 Nov):
//   raw:      what the model returned
//   grounded: a duplicate_document code counts only if duplicate_evidence_line points at a document line that
//             contains "CERTIFIED COPY" or "re-issued" (tee/eval/ground.mjs); eval level only, never on chain
// Writes metrics.json next to each set's results.json.      npm run eval
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { eip191Recover, readVerdict } from "../underwrite.mjs";
import { replyProblem, replyObject, REPLY_KEYS } from "../reply.mjs";
import { groundVerdict } from "./ground.mjs";

const root = new URL("../../", import.meta.url);
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const pct = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : null);

function metricsOf(rows, key) {
  const pos = rows.filter((r) => r.expect === "flag");
  const neg = rows.filter((r) => r.expect === "pass");
  const tp = pos.filter((r) => r[key].verdict === "flag").length;
  const fp = neg.filter((r) => r[key].verdict === "flag").length;
  const fn = pos.length - tp;
  const tn = neg.length - fp;
  const categories = {};
  for (const r of rows) {
    const c = (categories[r.category] ||= { cases: 0, flagged: 0, passed: 0, expected_code: 0 });
    c.cases++;
    if (r[key].verdict === "flag") c.flagged++;
    if (r[key].verdict === "pass") c.passed++;
    if (r.expect_code && r[key].anomalies.includes(r.expect_code)) c.expected_code++;
  }
  return {
    confusion: { tp, fn, fp, tn },
    precision_flag_pct: pct(tp / (tp + fp)),
    recall_flag_pct: pct(tp / (tp + fn)),
    false_positive_rate_pct: pct(fp / (fp + tn)),
    categories,
    false_positives: neg.filter((r) => r[key].verdict === "flag").map((r) => ({ id: r.id, codes: r[key].anomalies })),
    misses: pos.filter((r) => r[key].verdict !== "flag").map((r) => ({ id: r.id, category: r.category, variant: r.variant })),
  };
}

let failed = false;
// npm run eval                  scores the current runs of the main and hold-out sets and writes metrics.json
// npm run eval -- 2026-11-06    replays the kept 6 Nov run of the main set (old prompt) and prints its numbers only
const archived = process.argv[2];
const runs = archived ? [[`main, run of ${archived}`, "tee/eval", `results-${archived}.json`]] : [["main", "tee/eval", "results.json"], ["holdout", "tee/eval/holdout", "results.json"]];
for (const [set, dir, file] of runs) {
  if (!existsSync(new URL(`${dir}/${file}`, root))) {
    console.log(`${set}: no recorded run yet (${dir}/results.json); run it with npm run eval:run -- ${set}`);
    continue;
  }
  const run = JSON.parse(readFileSync(new URL(`${dir}/${file}`, root), "utf8"));
  const { cases } = JSON.parse(readFileSync(new URL(`${dir}/cases.json`, root), "utf8"));
  const docOf = Object.fromEntries(cases.map((c) => [c.id, readFileSync(new URL(c.file, root), "utf8")]));
  const attested = run.attestation.signers.map((s) => s.signing_address.toLowerCase());
  let bad = 0;
  const rows = run.results.map((r) => {
    if (!r.onchain) return { ...r, signed: false, problem: "no reply", raw: { verdict: "error", anomalies: [] }, grounded: { verdict: "error", anomalies: [] } };
    const o = r.onchain;
    const signer = eip191Recover(`${o.model_id}:${o.request_sha256}:${sha(o.response_body)}`, o.signature);
    const v = readVerdict(Buffer.from(o.response_body, "utf8"));
    const signed = attested.includes(signer) && v.loan_hash === o.loan_hash;
    if (!signed) bad++;
    const g = groundVerdict(v, docOf[r.id]);
    const parsed = replyObject(o.response_body);
    const extra = parsed && parsed.reply && typeof parsed.reply === "object" ? Object.keys(parsed.reply).filter((k) => !REPLY_KEYS.includes(k)) : [];
    return { ...r, signed, problem: replyProblem(o.response_body), extra, raw: { verdict: v.verdict, anomalies: v.anomalies }, grounded: g, evidence_line: v.duplicate_evidence_line };
  });
  const raw = metricsOf(rows, "raw");
  const grounded = metricsOf(rows, "grounded");
  const metrics = {
    set,
    model: run.model,
    run_at: run.run_at,
    cases: rows.length,
    signatures_verified: rows.length - bad,
    reply_rule: { clean: rows.filter((r) => !r.problem).length, broken: rows.filter((r) => r.problem).map((r) => ({ id: r.id, problem: r.problem })) },
    duplicate_codes_dropped_by_grounding: rows.filter((r) => r.grounded.dropped).map((r) => ({ id: r.id, category: r.category, evidence_line: r.evidence_line })),
    raw,
    grounded,
  };
  if (!archived) writeFileSync(new URL(`${dir}/metrics.json`, root), JSON.stringify(metrics, null, 2) + "\n");
  const leaky = rows.filter((r) => r.extra.length);
  console.log(`${set}: ${rows.length} cases, ${rows.length - bad} signatures verified against the attested TEE key, ${metrics.reply_rule.clean} replies within the reply rule`);
  console.log(`  replies echoing extra fields: ${leaky.length} of ${rows.length} (${leaky.reduce((n, r) => n + r.extra.length, 0)} field values${leaky.length ? ": " + [...new Set(leaky.flatMap((r) => r.extra))].join(", ") : ""})`);
  // An archived run predates duplicate_evidence_line, so grounding has nothing to check there: raw only.
  for (const [k, m] of archived ? [["raw", raw]] : [["raw", raw], ["grounded", grounded]]) {
    console.log(`  ${k.padEnd(8)} precision ${m.precision_flag_pct}%, recall ${m.recall_flag_pct}%, false positive rate ${m.false_positive_rate_pct}% (tp ${m.confusion.tp}, fn ${m.confusion.fn}, fp ${m.confusion.fp}, tn ${m.confusion.tn})`);
  }
  if (bad !== 0 || raw.confusion.tp + raw.confusion.fn === 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
