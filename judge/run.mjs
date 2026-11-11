// TrueNav judge. One offline command that replays the README claims and prints PASS or FAIL per claim.
//
//   npm run judge -- --replay                 S1 to S10, offline: no keys, funds, Docker, Rust, Python or network
//   npm run judge -- --replay --with-tests    the same, then the full npm test
//
// Writes out/judge-replay.json (schema judge/summary.schema.json). Exit 0 only if every stage passed, 1 on any
// failure, 2 on a usage error. Live testnet reads are not part of this command; CI runs them as separate steps.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STAGES, EXPECTED } from "./stages.mjs";
import { canonical, parseAnyReport, runStep, sha256hex, validate } from "./lib.mjs";

const ROOT = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const GUARD = fileURLToPath(new URL("./no-network.mjs", import.meta.url));
const SCHEMA_ID = "truenav-judge-summary/v1";
const IDS = STAGES.map((s) => s.id);

const USAGE = `usage: npm run judge -- --replay [--with-tests]

  --replay       replay every README claim offline (S1 to S10): no keys, funds, Docker, Rust, Python or network
  --with-tests   after the replay, run the full npm test (about 2 minutes; Rust 1.99.0 and TRUENAV_PYTHON with
                 jsonschema are needed for zero skips, and skips are reported as not verified)
  --only S1,S4   run only these stages (for tests; the summary is marked partial and ok stays false)
  --out FILE     summary path inside the repo (default out/judge-replay.json)

Live testnet reads (chain:read, verify:attestation, verify:fingerprints, check:chain-replies) are not part of the
judge; they run as separate CI steps and read the earlier tnlab-718ca9 instance.`;

function usage(msg) {
  if (msg) console.error(`judge: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { replay: false, withTests: false, only: null, out: "out/judge-replay.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--replay") o.replay = true;
    else if (a === "--with-tests") o.withTests = true;
    else if (a === "--live") usage("--live is not built: live reads run in CI only (decided 11 Nov), as separate steps after the replay");
    else if (a === "--only") {
      const v = argv[++i];
      if (!v) usage("--only needs a list such as S1,S4");
      const ids = v.split(",").map((s) => s.trim().toUpperCase());
      const unknown = ids.filter((id) => !IDS.includes(id));
      if (unknown.length || !ids.length) usage(`unknown stage ${unknown.join(", ")}`);
      o.only = new Set(ids);
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v || isAbsolute(v) || relative(ROOT, resolve(ROOT, v)).startsWith("..")) usage("--out must be a relative path inside the repo");
      o.out = v;
    } else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else usage(`unknown argument ${a}`);
  }
  if (!o.replay) usage(o.withTests ? "--with-tests needs --replay" : "pass --replay");
  return o;
}

function headCommit() {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf8" });
  if (top.status !== 0) return null;
  try { if (realpathSync(top.stdout.trim()) !== ROOT) return null; } catch { return null; }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
}

const opts = parseArgs(process.argv.slice(2));
const t0 = Date.now();
const commit = headCommit();
const netDir = mkdtempSync(join(tmpdir(), "truenav-judge-net-"));
const netLog = join(netDir, "refused.log");
writeFileSync(netLog, "");
const TMP = realpathSync(tmpdir());
const clean = (s) => String(s).split(ROOT).join(".").split(TMP).join("<tmp>").replace(/\s+/g, " ").slice(0, 400);

// Children get a fixed minimal environment, so no key, RPC URL or account in the caller's shell can reach a stage,
// and every Node process loads the network guard.
const childEnv = {
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || TMP,
  TMPDIR: TMP,
  LANG: "C.UTF-8",
  NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}`,
  TRUENAV_JUDGE_NET_LOG: netLog,
};
const refusedSoFar = () => readFileSync(netLog, "utf8").split("\n").filter(Boolean);

const outDir = join(ROOT, "out");
const results = new Map();
const ctx = {
  root: ROOT, commit, results, outDir, clean,
  node: (args, timeoutMs) => runStep(process.execPath, args, { cwd: ROOT, env: childEnv, timeoutMs }),
};

const short = commit ? commit.slice(0, 7) : "no git commit";
console.log(`truenav judge --replay${opts.withTests ? " --with-tests" : ""} on ${short}: offline, no keys, funds, Docker, Rust, Python or network${opts.only ? ` (partial: ${[...opts.only].join(", ")})` : ""}`);

const stages = [];
const durations = {};
const skips = [];
let pins = { harbor_raw: null, meridian_raw: null, harbor_score: null, meridian_score: null, engine_sha256: null };
let fixtureDaysMin = null;

async function runStage(def) {
  const before = refusedSoFar().length;
  const s0 = process.hrtime.bigint();
  let r;
  try {
    r = await def.run(ctx);
  } catch (e) {
    r = { status: "fail", evidence: `uncaught: ${clean(e && e.message ? e.message : e)}` };
  }
  durations[def.id] = Math.round(Number(process.hrtime.bigint() - s0) / 1e6);
  const refused = refusedSoFar().slice(before);
  if (refused.length) r = { ...r, status: "fail", evidence: `network refused in replay (${[...new Set(refused)].join(", ")}); ${r.evidence}` };
  if (!["pass", "fail"].includes(r.status)) r = { ...r, status: "fail", evidence: `stage returned ${r.status}` };
  const stage = { id: def.id, name: def.name, status: r.status, claim: def.claim, evidence: clean(r.evidence ?? ""), label: def.label ?? null };
  results.set(def.id, { ...stage, data: r.data });
  stages.push(stage);
  for (const s of r.skips || []) skips.push({ stage: def.id, test: s.test, reason: s.reason, status: "skipped_not_verified" });
  if (r.pins) pins = { ...pins, ...r.pins };
  if (r.ephemeral?.fixture_days_left_min !== undefined) fixtureDaysMin = r.ephemeral.fixture_days_left_min;
  console.log(`${r.status === "pass" ? "PASS" : "FAIL"} ${def.id} ${def.name} (README: "${def.claim}")`);
  console.log(`     ${stage.evidence}${stage.label ? ` [${stage.label}]` : ""}  ${(durations[def.id] / 1000).toFixed(2)} s`);
  if (r.status === "pass") for (const n of r.notes || []) console.log(`     ${clean(n)}`);
}

for (const def of STAGES) {
  if (opts.only && !opts.only.has(def.id)) {
    stages.push({ id: def.id, name: def.name, status: "not_run", claim: def.claim, evidence: "not selected by --only", label: def.label ?? null });
    continue;
  }
  await runStage(def);
}

if (opts.withTests) {
  await runStage({
    id: "TESTS", name: "npm test", claim: "npm test passes (README step after the judge).",
    label: "skipped checks are listed in skips and are not verified",
    async run() {
      // npm test needs the caller's Rust and TRUENAV_PYTHON for zero skips; keys, RPC URLs and accounts still stay out.
      const env = { ...childEnv };
      for (const k of ["TRUENAV_PYTHON", "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN"]) if (process.env[k]) env[k] = process.env[k];
      const npm = process.env.npm_execpath && existsSync(process.env.npm_execpath) ? [process.execPath, [process.env.npm_execpath, "test"]] : ["npm", ["test"]];
      const r = await runStep(npm[0], npm[1], { cwd: ROOT, env, timeoutMs: 600_000 });
      const { counts, skipped } = parseAnyReport(r.stdout);
      const problems = [];
      if (r.spawnError) problems.push(`npm test could not start (${clean(r.spawnError)})`);
      else if (r.timedOut) problems.push("npm test timed out after 600 s");
      else if (r.code !== 0) problems.push(`npm test exit ${r.code ?? r.signal}`);
      if (counts.fail) problems.push(`${counts.fail} failed`);
      if (counts.skipped && skipped.length !== counts.skipped) problems.push(`${counts.skipped} skipped but only ${skipped.length} named`);
      const line = `npm test: ${counts.pass ?? "?"} passed, ${counts.skipped ?? "?"} skipped (not verified), ${counts.fail ?? "?"} failed, then spec/nav/check.mjs`;
      return { status: problems.length ? "fail" : "pass", evidence: problems.length ? `${problems.join("; ")}; ${line}` : line, skips: skipped.map((s) => ({ test: clean(s.test), reason: clean(s.reason) })) };
    },
  });
}

const selectedOk = stages.filter((s) => s.status !== "not_run").every((s) => s.status === "pass");
const partial = !!opts.only;
const hashed = {
  schema: SCHEMA_ID, commit, mode: "replay", with_tests: opts.withTests, partial,
  ok: !partial && selectedOk && stages.every((s) => s.status === "pass"),
  stages, pins, skips,
  expected: { ...EXPECTED },
  offline: { guard: "judge/no-network.mjs", refused: [...new Set(refusedSoFar())] },
};
const summary = {
  ...hashed,
  ephemeral: { generated_at: new Date().toISOString(), fixture_days_left_min: fixtureDaysMin, wall_ms: Date.now() - t0, durations_ms: durations, node: process.version },
  evidence_hash: sha256hex(canonical(hashed)),
};
rmSync(netDir, { recursive: true, force: true });

const schema = JSON.parse(readFileSync(new URL("./summary.schema.json", import.meta.url), "utf8"));
const problems = validate(schema, summary);
const outPath = resolve(ROOT, opts.out);
mkdirSync(resolve(outPath, ".."), { recursive: true });
if (problems.length) {
  console.log(`FAIL summary does not match judge/summary.schema.json: ${clean(problems.slice(0, 3).join("; "))}`);
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
const ran = stages.filter((s) => s.status !== "not_run");
const passed = ran.filter((s) => s.status === "pass").length;
for (const s of skips) console.log(`SKIP ${s.stage} ${s.test}: not verified${s.reason ? ` (${s.reason})` : ""}`);
console.log(`judge: ${passed} of ${ran.length} stages PASS${partial ? " (partial run, ok false)" : ""}, ${skips.length} skipped not verified, ok ${summary.ok}, evidence_hash ${summary.evidence_hash}`);
console.log(`judge: wrote ${relative(ROOT, outPath)}, wall ${(summary.ephemeral.wall_ms / 1000).toFixed(1)} s`);
process.exit(selectedOk && ran.length > 0 ? 0 : 1);
