// Runs an eval set through the TEE underwriter once each (no retries: the eval measures the first answer) and
// saves every signed reply. Needs a NEAR AI Cloud key. Score offline with: npm run eval
//
//   node tee/eval/run.mjs [main|holdout|live-injection] [--estimate]
//     main           = tee/eval (86 docs)                -> tee/eval/results.json
//     holdout        = tee/eval/holdout (40 docs, frozen) -> tee/eval/holdout/results.json
//     live-injection = tee/eval/live-injection (22 docs) -> tee/eval/live-injection/results.json
//   Each set writes only its own results.json, so a live-injection run never touches the committed main or hold-out
//   results.
//   --estimate   prints the token and cost estimate for the set and exits: no attestation, no model call, no network.
//
// Spend stop: before a run the estimate (prompt tokens from the request sizes plus the full max_tokens output for every
// case) must be at most TRUENAV_EVAL_MAX_USD (default 0.50). During the run the cost from each reply's usage is added
// up, and the run stops before the next case once it passes that cap; the results file says so.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildRequest, bindingFor, VERDICT_TTL_MS } from "../underwrite.mjs";

const root = new URL("../../", import.meta.url);
export const SETS = { main: "tee/eval", holdout: "tee/eval/holdout", "live-injection": "tee/eval/live-injection" };
export const resultsPath = (set) => `${SETS[set]}/results.json`;
// NEAR AI Cloud list price for Qwen/Qwen3-VL-30B-A3B-Instruct (the default MODEL in tee/attest.mjs), USD per 1M tokens,
// read from near.ai/pricing on 13 Nov 2026. Re-check it before a paid run if the model or the price list changed.
export const PRICE_USD_PER_M = { input: 0.15, output: 0.55 };
// Prompt tokens per character, from the recorded main and hold-out runs: 3.41 to 3.65 ASCII characters per reported
// prompt token (chat template included). 3.4 keeps the estimate at or slightly above the real count. Every non-ASCII
// code point (Thai, Chinese, Cyrillic, zero-width) is counted as one whole token, which overestimates those lines.
export const ASCII_CHARS_PER_TOKEN = 3.4;
export const DEFAULT_MAX_USD = 0.5;

export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) ch.codePointAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + other;
}

export const usd = ({ prompt_tokens = 0, completion_tokens = 0 }) => (prompt_tokens * PRICE_USD_PER_M.input + completion_tokens * PRICE_USD_PER_M.output) / 1e6;

/** Estimate one run of a set from the exact request bytes each case would send. No network. */
export function estimateSet(set, { binding = bindingFor("eval.truenav-eval.testnet", 1893456000000), base = root } = {}) {
  if (!SETS[set]) throw new Error(`set must be one of ${Object.keys(SETS).join(", ")}`);
  const { cases } = JSON.parse(readFileSync(new URL(`${SETS[set]}/cases.json`, base), "utf8"));
  const rows = cases.map((c) => {
    const loan = { loan_id: c.id, fund_id: "eval", loan_hash: c.loan_hash, asset_type: c.asset_type, document_id: c.document_id, principal: c.principal, tampered: null };
    const body = JSON.parse(buildRequest(loan, readFileSync(new URL(c.file, base), "utf8"), binding).toString("utf8"));
    const prompt_tokens = estimateTokens(body.messages.map((m) => m.content).join("\n"));
    return { id: c.id, prompt_tokens, max_output_tokens: body.max_tokens, request_bytes: Buffer.byteLength(JSON.stringify(body)) };
  });
  const prompt = rows.reduce((n, r) => n + r.prompt_tokens, 0);
  const outMax = rows.reduce((n, r) => n + r.max_output_tokens, 0);
  const outTypical = rows.length * 160; // recorded replies use 152 to 164 completion tokens
  return {
    set,
    cases: rows.length,
    rows,
    prompt_tokens: prompt,
    max_output_tokens: outMax,
    usd_max: usd({ prompt_tokens: prompt, completion_tokens: outMax }),
    usd_typical: usd({ prompt_tokens: prompt, completion_tokens: outTypical }),
  };
}

export function parseArgs(argv) {
  const pos = argv.filter((a) => !a.startsWith("--"));
  const bad = argv.find((a) => a.startsWith("--") && a !== "--estimate");
  if (bad) throw new Error(`unknown option ${bad}`);
  const set = pos[0] || "main";
  if (!SETS[set] || pos.length > 1) throw new Error(`set must be one of ${Object.keys(SETS).join(", ")}`);
  return { set, estimate: argv.includes("--estimate") };
}

export const maxUsdFrom = (env = process.env) => {
  const v = env.TRUENAV_EVAL_MAX_USD === undefined ? DEFAULT_MAX_USD : Number(env.TRUENAV_EVAL_MAX_USD);
  if (!Number.isFinite(v) || v <= 0) throw new Error("TRUENAV_EVAL_MAX_USD must be a positive number of US dollars");
  return v;
};

const fmt = (x) => `$${x.toFixed(4)}`;
export function printEstimate(e, maxUsd) {
  console.log(`${e.set}: ${e.cases} cases, about ${e.prompt_tokens} prompt tokens, at most ${e.max_output_tokens} output tokens (max_tokens ${e.rows[0]?.max_output_tokens} each)`);
  console.log(`  estimate ${fmt(e.usd_typical)} typical (160 output tokens a case, as recorded), ${fmt(e.usd_max)} at most; spend stop ${fmt(maxUsd)}`);
  console.log(`  price ${PRICE_USD_PER_M.input} / ${PRICE_USD_PER_M.output} USD per 1M input / output tokens (list price read 13 Nov 2026); writes ${resultsPath(e.set)}`);
}

async function main(argv) {
  const { set, estimate } = parseArgs(argv);
  const maxUsd = maxUsdFrom();
  const est = estimateSet(set);
  printEstimate(est, maxUsd);
  if (estimate) return;
  if (est.usd_max > maxUsd) throw new Error(`estimate ${fmt(est.usd_max)} is above the spend stop ${fmt(maxUsd)}; raise TRUENAV_EVAL_MAX_USD only with the owner's yes`);
  const { attest } = await import("../attest.mjs");
  const { underwrite } = await import("../underwrite.mjs");
  const { replyProblem } = await import("../reply.mjs");
  const dir = SETS[set];
  const { cases } = JSON.parse(readFileSync(new URL(`${dir}/cases.json`, root), "utf8"));
  const att = await attest();
  if (!att.pass) throw new Error("attestation failed");
  const binding = bindingFor("eval.truenav-eval.testnet", Date.now() + VERDICT_TTL_MS); // eval only, never submitted
  const results = [];
  let spent = 0;
  let stopped = null;
  for (const c of cases) {
    if (spent > maxUsd) {
      stopped = `spend stop: ${fmt(spent)} used, cap ${fmt(maxUsd)}; ${cases.length - results.length} cases not run`;
      break;
    }
    const loan = { loan_id: c.id, fund_id: "eval", loan_hash: c.loan_hash, asset_type: c.asset_type, document_id: c.document_id, principal: c.principal, tampered: null };
    let r;
    try {
      r = await underwrite(loan, readFileSync(new URL(c.file, root), "utf8"), att.signers, binding);
    } catch (e) {
      r = { error: String(e.message || e).slice(0, 200) };
    }
    let usage = null;
    try {
      usage = r.onchain ? JSON.parse(r.onchain.response_body).usage || null : null;
    } catch { /* no usage: counted as the estimate below */ }
    spent += usage ? usd(usage) : usd({ prompt_tokens: est.rows.find((x) => x.id === c.id).prompt_tokens, completion_tokens: est.rows[0].max_output_tokens });
    results.push({ id: c.id, category: c.category, variant: c.variant || null, expect: c.expect, expect_code: c.expect_code, verdict: r.verdict || null, checks: r.checks || null, onchain: r.onchain || null, error: r.error || null });
    const problem = r.onchain ? replyProblem(r.onchain.response_body) : null;
    process.stdout.write(`${c.id} ${c.category.padEnd(16)} ${r.verdict ? r.verdict.verdict + " " + r.verdict.anomalies.join(",") + (r.verdict.duplicate_evidence_line !== null ? ` line=${r.verdict.duplicate_evidence_line}` : "") : "ERROR " + r.error}${problem ? `  REPLY RULE: ${problem}` : ""}\n`);
  }
  if (stopped) console.log(stopped);
  writeFileSync(new URL(resultsPath(set), root), JSON.stringify({ note: "First-answer TEE verdicts; each reply signed by the attested model TEE.", set, model: att.model, run_at: new Date().toISOString(), attestation: { nonce: att.nonce, checked_at: att.checked_at, signers: att.signers }, binding, spend_usd: Math.round(spent * 1e6) / 1e6, stopped, results }, null, 2) + "\n");
  console.log(`wrote ${resultsPath(set)} (spend about ${fmt(spent)} from the replies' usage)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 2;
  });
}
