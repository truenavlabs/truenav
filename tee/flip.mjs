// One command to move tee/status.json from pending to live, once the 368aa2 verdict set and its attestation report are
// in the repository. Read and write local files only: no network, no key, no chain call, no NEAR AI Cloud.
//
//   npm run tee:flip                     dry run: validate the files, show the status it would write, list every doc line
//                                        that must be edited by hand; writes nothing
//   npm run tee:flip -- --write          write tee/status.json (live) and regenerate docs/TEE_STATUS.md
//   options: --verdicts <path>  (default tee/fixtures/verdicts-368aa2.json)
//            --report <path>    (default tee/fixtures/attestation-report-368aa2.json.b64)
//
// After --write, `npm run tee:status` and `npm test` fail until the hand-written docs stop saying TEE is pending.
// This script prints those lines; it never edits README.md, TRUST_MODEL.md or ARCHITECTURE.md.
// It cannot prove the verdicts are on chain: run `npm run tee:chain-check` for that.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkStatus, readStatus, renderStatusDoc, STATUS_FILE, DOC_FILE, DOCS_TO_CHECK, PENDING_PHRASES } from "./status.mjs";

const ROOT = new URL("../", import.meta.url);
export const DEFAULT_VERDICTS = "tee/fixtures/verdicts-368aa2.json";
export const DEFAULT_REPORT = "tee/fixtures/attestation-report-368aa2.json.b64";
/** Other places that talk about the TEE state; checked by hand when the status goes live. */
export const EXTRA_FILES = ["certify/check-chain-replies.mjs"];
const LOOSE = /(TEE|verdict)[^\n]*(pending|not run|not yet)|(pending|not run|not yet)[^\n]*(TEE|verdict)/i;

/** The status object a flip would write. Keeps registry and earlier_instance from the current file. */
export function liveStatus(current, { verdicts = DEFAULT_VERDICTS, report = DEFAULT_REPORT } = {}) {
  return { registry: current.registry, tee: "live", verdicts_file: verdicts, report_file: report, earlier_instance: current.earlier_instance };
}

/** Every line in the hand-written docs that must change: exact phrase hits (these fail npm test), then looser candidates. */
export function linesToEdit(root = ROOT) {
  const exact = [];
  const loose = [];
  for (const f of [...DOCS_TO_CHECK, ...EXTRA_FILES]) {
    if (!existsSync(new URL(f, root))) continue;
    readFileSync(new URL(f, root), "utf8").split("\n").forEach((text, i) => {
      const line = i + 1;
      const phrase = PENDING_PHRASES.find((p) => text.includes(p));
      if (phrase && DOCS_TO_CHECK.includes(f)) exact.push({ file: f, line, phrase, text });
      else if (LOOSE.test(text)) loose.push({ file: f, line, text });
    });
  }
  return { exact, loose };
}

/** Validate the two files for the current status registry. Returns { problems, status, summary }. */
export function planFlip({ root = ROOT, nowMs = Date.now(), verdicts = DEFAULT_VERDICTS, report = DEFAULT_REPORT } = {}) {
  const current = readStatus(root);
  const problems = [];
  if (current.tee === "live") problems.push(`${STATUS_FILE} is already live`);
  for (const [name, p] of [["verdicts", verdicts], ["report", report]]) if (!existsSync(new URL(p, root))) problems.push(`${name} file ${p} does not exist: put it in the branch first`);
  const status = liveStatus(current, { verdicts, report });
  if (problems.length) return { problems, status, summary: null, current };
  // the same checks npm test runs on a live status: structure, binding, signatures, reply rule, 10 days left, report sha256
  const checked = checkStatus(status, { root, nowMs });
  return { problems: checked.problems, status, summary: checked.verdicts, current };
}

/** Write the live status and regenerate the status doc under `root`. */
export function writeFlip(plan, root = ROOT) {
  writeFileSync(new URL(STATUS_FILE, root), `${JSON.stringify(plan.status, null, 2)}\n`);
  writeFileSync(new URL(DOC_FILE, root), renderStatusDoc(plan.status, plan.summary));
}

const clip = (s, n = 150) => (s.length > n ? `${s.trim().slice(0, n)}...` : s.trim());

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const write = args.includes("--write");
  const unknown = args.filter((a, i) => a.startsWith("--") && !["--write", "--verdicts", "--report"].includes(a) && !["--verdicts", "--report"].includes(args[i - 1]));
  if (unknown.length) { console.error(`unknown argument ${unknown[0]}`); process.exit(2); }
  const plan = planFlip({ verdicts: opt("--verdicts", DEFAULT_VERDICTS), report: opt("--report", DEFAULT_REPORT) });
  for (const p of plan.problems) console.log(`FAIL ${p}`);
  if (plan.problems.length) { console.log("FAIL not flipped: fix the problems above"); process.exit(1); }
  const v = plan.summary;
  console.log(`PASS ${plan.status.verdicts_file}: ${v.records} records (${v.pass} pass, ${v.flag} flag), signer ${v.signer}, model ${v.model}`);
  console.log(`PASS ${plan.status.report_file} matches the report sha256 recorded in the verdicts`);
  console.log(`status to write in ${STATUS_FILE}:\n${JSON.stringify(plan.status, null, 2)}`);
  const { exact, loose } = linesToEdit();
  console.log(`\nLines to edit by hand after the flip (${exact.length} fail npm test and tee:status until they change):`);
  for (const h of exact) console.log(`  MUST  ${h.file}:${h.line}  has "${h.phrase}"  | ${clip(h.text)}`);
  for (const h of loose) console.log(`  CHECK ${h.file}:${h.line}  | ${clip(h.text)}`);
  if (!write) { console.log("\ndry run: nothing written. To flip: npm run tee:flip -- --write"); process.exit(0); }
  writeFlip(plan);
  console.log(`\nwrote ${STATUS_FILE} (live) and ${DOC_FILE}`);
  console.log("next: edit the MUST lines above, then npm run tee:status, npm test, and (after the chain step) npm run tee:chain-check");
}
