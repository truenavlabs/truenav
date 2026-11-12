// Reads the output of `npm test` (node --test, TAP-style summary) on stdin or from a file and checks the README
// "Try it" step 3 rule: exit 0 with 0 failures. It prints the counts and does not require an exact pass count,
// because the skipped tests depend on whether Python jsonschema and Rust 1.99.0 are on PATH.
//   node judge/ci-test-counts.mjs <file>        exits 1 if the summary is missing, tests is 0, or fail is not 0
// If GITHUB_STEP_SUMMARY is set, the counts are appended to it as a small table.
import { readFileSync, appendFileSync } from "node:fs";

const KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

/** Parse "# tests 417" (no terminal) or "ℹ tests 417" (terminal) lines. The last value of each key wins. */
export function parseCounts(text) {
  const counts = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    if (m) counts[m[1]] = Number(m[2]);
  }
  return counts;
}

/** Returns { ok, problems, counts }. */
export function checkCounts(text) {
  const counts = parseCounts(text);
  const problems = [];
  for (const k of ["tests", "pass", "fail"]) if (!(k in counts)) problems.push(`no "${k}" line in the npm test output`);
  if (counts.tests === 0) problems.push("0 tests ran");
  if (counts.fail > 0) problems.push(`${counts.fail} failing`);
  if (counts.cancelled > 0) problems.push(`${counts.cancelled} cancelled`);
  if (counts.tests !== undefined && counts.pass !== undefined && counts.fail !== undefined) {
    const accounted = counts.pass + counts.fail + (counts.cancelled || 0) + (counts.skipped || 0) + (counts.todo || 0);
    if (accounted !== counts.tests) problems.push(`pass + fail + cancelled + skipped + todo is ${accounted}, not tests ${counts.tests}`);
  }
  return { ok: problems.length === 0, problems, counts };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node judge/ci-test-counts.mjs <npm-test-output-file>"); process.exit(2); }
  const { ok, problems, counts } = checkCounts(readFileSync(file, "utf8"));
  const line = KEYS.filter((k) => k in counts).map((k) => `${k} ${counts[k]}`).join(", ");
  console.log(`npm test counts: ${line || "none found"}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### npm test, fresh checkout\n\n| ${KEYS.join(" | ")} |\n| ${KEYS.map(() => "---").join(" | ")} |\n| ${KEYS.map((k) => counts[k] ?? "n/a").join(" | ")} |\n\n${ok ? "0 failures." : "FAILED: " + problems.join("; ")}\n`);
  }
  if (!ok) { for (const p of problems) console.error(`FAIL ${p}`); process.exit(1); }
  console.log("PASS 0 failures");
}
