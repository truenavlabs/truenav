// The one data file for the TEE status of the current registry: tee/status.json.
//   tee: "pending"  no verdict set is bound to the registry (today)
//   tee: "live"     a verdict set bound to the registry is recorded in verdicts_file with its published attestation
//                   report in report_file, and TrueNav has submitted it on chain
// Flip it by editing that file, then run `npm run tee:status -- --write` to regenerate docs/TEE_STATUS.md. `npm test`
// fails if the doc is stale, if a live status points at a file that does not validate (tee/verdicts-file.mjs) or at
// a report whose sha256 differs from the one recorded in the verdicts, and if the root README or TRUST_MODEL.md still
// says TEE is pending while the status is live. This script reads files only: it never touches the network, a key or
// the chain, so it cannot prove the verdicts are on chain; the commands in the doc do that.
//
//   node tee/status.mjs             print the problems and the status line (exit 1 on a problem)
//   node tee/status.mjs --write     rewrite docs/TEE_STATUS.md
//   node tee/status.mjs --check     exit 1 if docs/TEE_STATUS.md differs from what the status file renders
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateVerdictsFile } from "./verdicts-file.mjs";

const ROOT = new URL("../", import.meta.url);
export const STATUS_FILE = "tee/status.json";
export const DOC_FILE = "docs/TEE_STATUS.md";
/** Sentences that must not stay in the hand-written docs once the status is live. */
export const PENDING_PHRASES = ["TEE verdicts pending", "TEE verdicts for this contract are pending", "TEE pending", "TEE verdicts are pending"];
export const DOCS_TO_CHECK = ["README.md", "TRUST_MODEL.md", "ARCHITECTURE.md"];
const ACCOUNT = /^[a-z0-9._-]+\.(testnet|near)$/;
const MIN_DAYS = 10;

export function readStatus(root = ROOT) {
  return JSON.parse(readFileSync(new URL(STATUS_FILE, root), "utf8"));
}

/** { problems, verdicts } : verdicts is the validated file summary when the status is live. */
export function checkStatus(status, { root = ROOT, nowMs = Date.now() } = {}) {
  const problems = [];
  const bad = (m) => problems.push(m);
  const keys = Object.keys(status);
  for (const k of keys) if (!["registry", "tee", "verdicts_file", "report_file", "earlier_instance"].includes(k)) bad(`unknown key ${k}`);
  if (!ACCOUNT.test(status.registry ?? "")) bad("registry must be a testnet or mainnet account id");
  if (!ACCOUNT.test(status.earlier_instance ?? "")) bad("earlier_instance must be an account id");
  if (status.tee !== "pending" && status.tee !== "live") {
    bad('tee must be "pending" or "live"');
    return { problems, verdicts: null };
  }
  if (status.tee === "pending") {
    if (status.verdicts_file !== null || status.report_file !== null) bad("a pending status must have verdicts_file and report_file null (set tee to live when the set is on chain)");
    return { problems, verdicts: null };
  }
  let verdicts = null;
  for (const k of ["verdicts_file", "report_file"]) {
    if (typeof status[k] !== "string" || !status[k] || status[k].startsWith("/") || status[k].includes("..")) bad(`${k} must be a path inside the repository`);
    else if (!existsSync(new URL(status[k], root))) bad(`${k} ${status[k]} does not exist`);
  }
  if (problems.length) return { problems, verdicts };
  if (status.verdicts_file === "tee/fixtures/verdicts.json") bad("verdicts_file must not be the earlier instance's set tee/fixtures/verdicts.json");
  const file = JSON.parse(readFileSync(new URL(status.verdicts_file, root), "utf8"));
  const v = validateVerdictsFile(file, { contract: status.registry, nowMs, minDays: MIN_DAYS });
  for (const p of v.problems) bad(`${status.verdicts_file}: ${p}`);
  const reportSha = createHash("sha256").update(Buffer.from(readFileSync(new URL(status.report_file, root), "utf8").replace(/\s+/g, ""), "base64")).digest("hex");
  if (file.attestation && reportSha !== file.attestation.report_sha256) bad(`${status.report_file} has sha256 ${reportSha}, but ${status.verdicts_file} records ${file.attestation.report_sha256}`);
  if (status.report_file === "tee/fixtures/attestation-report.json.b64") bad("report_file must not be the earlier instance's report");
  verdicts = { ...v, model: file.model, signed_at_ms: file.signed_at_ms, pass: file.results.filter((r) => r.verdict?.verdict === "pass").length, flag: file.results.filter((r) => r.verdict?.verdict === "flag").length };
  return { problems, verdicts };
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The markdown of docs/TEE_STATUS.md for a status (verdicts: the summary from checkStatus when live). */
export function renderStatusDoc(status, verdicts) {
  const head = [
    "# TEE status",
    "",
    `Generated from \`${STATUS_FILE}\` by \`npm run tee:status -- --write\`. Do not edit by hand: \`npm test\` fails if this file differs from what the status file renders.`,
    "",
    `Registry: \`${status.registry}\``,
    `TEE status: **${status.tee}**`,
    "",
  ];
  if (status.tee === "pending") {
    return [
      ...head,
      `No TEE verdict set is recorded for \`${status.registry}\`: no TEE signer is registered on it and it holds no \`submit_verdict\` calls. \`npm run chain:read\` shows its loans as pending.`,
      "",
      `The recorded TEE verdicts, the published attestation report and the \`submit_verdict\` history belong to the earlier instance \`${status.earlier_instance}\` (\`tee/fixtures/verdicts.json\`). The live attestation, fingerprint and chain-reply checks read that instance.`,
      "",
      "To move to live: record a verdict set bound to this registry, validate it (`node tee/verdicts-file.mjs <file> --contract <registry>`), submit it on chain, then set `tee` to `live` and fill `verdicts_file` and `report_file` in `tee/status.json`.",
      "",
    ].join("\n");
  }
  return [
    ...head,
    `A verdict set bound to \`${status.registry}\` is recorded in \`${status.verdicts_file}\`: model \`${verdicts.model}\`, TEE signer \`${verdicts.signer}\`, ${verdicts.records} records (${verdicts.pass} pass, ${verdicts.flag} flag), signed ${day(verdicts.signed_at_ms)}, expires ${day(verdicts.expires_at_ms)}. The published attestation report is \`${status.report_file}\`.`,
    "",
    "This status records that TrueNav submitted the set on chain. The files cannot show that, so check it against the chain:",
    "",
    "```bash",
    `TRUENAV_CONTRACT=${status.registry} npm run chain:read             # loans no longer pending`,
    `TRUENAV_CONTRACT=${status.registry} npm run check:chain-replies    # every submit_verdict reply within the allowed keys`,
    "npm run verify:attestation                                          # the signer is the attested model key",
    `TRUENAV_CONTRACT=${status.registry} npm run tee:chain-check        # every verdict in the file is on chain, signer and expiry match`,
    "```",
    "",
    `A TEE proves which code ran, not that the model's judgment is right. Limits: \`tee/eval/REPORT.md\`. The earlier instance \`${status.earlier_instance}\` keeps its own recorded set.`,
    "",
  ].join("\n");
}

/** Hand-written docs that still call TEE pending (only a problem when the status is live). */
export function stalePendingClaims(root = ROOT) {
  const hits = [];
  for (const f of DOCS_TO_CHECK) {
    if (!existsSync(new URL(f, root))) continue;
    readFileSync(new URL(f, root), "utf8").split("\n").forEach((line, i) => {
      for (const p of PENDING_PHRASES) if (line.includes(p)) hits.push({ file: f, line: i + 1, phrase: p });
    });
  }
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const status = readStatus();
  const { problems, verdicts } = checkStatus(status);
  const doc = problems.length ? null : renderStatusDoc(status, verdicts);
  if (status.tee === "live") for (const h of stalePendingClaims()) problems.push(`${h.file}:${h.line} still says "${h.phrase}"`);
  if (doc && args.includes("--write")) {
    writeFileSync(new URL(DOC_FILE, ROOT), doc);
    console.log(`wrote ${DOC_FILE}`);
  } else if (doc && args.includes("--check")) {
    const have = existsSync(new URL(DOC_FILE, ROOT)) ? readFileSync(new URL(DOC_FILE, ROOT), "utf8") : "";
    if (have !== doc) problems.push(`${DOC_FILE} is stale: run npm run tee:status -- --write`);
  }
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(`${problems.length ? "FAIL" : "PASS"} TEE status of ${status.registry}: ${status.tee}`);
  process.exit(problems.length ? 1 : 0);
}
