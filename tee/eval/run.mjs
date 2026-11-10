// Runs an eval set through the TEE underwriter once each (no retries: the eval measures the first answer) and
// saves every signed reply. Needs a NEAR AI Cloud key. Score offline with: npm run eval
//
//   node tee/eval/run.mjs [main|holdout]      main = tee/eval (86 docs), holdout = tee/eval/holdout (40 docs, frozen)
import { readFileSync, writeFileSync } from "node:fs";
import { attest } from "../attest.mjs";
import { underwrite, bindingFor, VERDICT_TTL_MS } from "../underwrite.mjs";
import { replyProblem } from "../reply.mjs";

const root = new URL("../../", import.meta.url);
const set = process.argv[2] || "main";
const dir = { main: "tee/eval", holdout: "tee/eval/holdout" }[set];
if (!dir) throw new Error("set must be main or holdout");
const { cases } = JSON.parse(readFileSync(new URL(`${dir}/cases.json`, root), "utf8"));
const att = await attest();
if (!att.pass) throw new Error("attestation failed");
const binding = bindingFor("eval.truenav-eval.testnet", Date.now() + VERDICT_TTL_MS); // eval only, never submitted
const results = [];
for (const c of cases) {
  const loan = { loan_id: c.id, fund_id: "eval", loan_hash: c.loan_hash, asset_type: c.asset_type, document_id: c.document_id, principal: c.principal, tampered: null };
  let r;
  try {
    r = await underwrite(loan, readFileSync(new URL(c.file, root), "utf8"), att.signers, binding);
  } catch (e) {
    r = { error: String(e.message || e).slice(0, 200) };
  }
  results.push({ id: c.id, category: c.category, variant: c.variant || null, expect: c.expect, expect_code: c.expect_code, verdict: r.verdict || null, checks: r.checks || null, onchain: r.onchain || null, error: r.error || null });
  const problem = r.onchain ? replyProblem(r.onchain.response_body) : null;
  process.stdout.write(`${c.id} ${c.category.padEnd(16)} ${r.verdict ? r.verdict.verdict + " " + r.verdict.anomalies.join(",") + (r.verdict.duplicate_evidence_line !== null ? ` line=${r.verdict.duplicate_evidence_line}` : "") : "ERROR " + r.error}${problem ? `  REPLY RULE: ${problem}` : ""}\n`);
}
writeFileSync(new URL(`${dir}/results.json`, root), JSON.stringify({ note: "First-answer TEE verdicts; each reply signed by the attested model TEE.", set, model: att.model, run_at: new Date().toISOString(), attestation: { nonce: att.nonce, checked_at: att.checked_at, signers: att.signers }, binding, results }, null, 2) + "\n");
console.log(`wrote ${dir}/results.json`);
