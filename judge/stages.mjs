// The ten replay stages. Each wraps scripts and tests that already exist in this repo; the only new checks are the
// S7 dashboard data file, the S9 offline fingerprint slice and the S4 agent probe. A stage returns
// { status, evidence, label?, skips?, pins?, ephemeral? }. Anything missing, any non-zero exit, a missing or skipped
// required test, or a number that differs from the README is a fail. Nothing here is ever a silent skip.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, parseTap, sha256hex } from "./lib.mjs";

// The numbers the README states. A stage fails when the replay gives anything else.
export const EXPECTED = Object.freeze({ harbor_raw: 99.17, meridian_raw: 42.84, harbor_score: 99, meridian_score: 43 });

const readJson = (ctx, f) => JSON.parse(readFileSync(join(ctx.root, f), "utf8"));
const need = (ctx, files) => files.filter((f) => !existsSync(join(ctx.root, f))).map((f) => `missing ${f}`);
// Last meaningful output line, without TAP summary lines or timings, so a failing run's evidence is stable too.
const tail = (ctx, r) => ctx.clean((`${r.stderr}\n${r.stdout}`.trim().split("\n").filter((l) => l.trim() && !/^\s*(#|ok |not ok |1\.\.|duration_ms)/.test(l)).slice(-1)[0] || "").replace(/\(?\d+(\.\d+)?\s?m?s\)?/g, "").trim());
function exitProblem(ctx, what, r) {
  if (r.spawnError) return `${what}: could not start (${ctx.clean(r.spawnError)})`;
  if (r.timedOut) return `${what}: timed out`;
  if (r.code !== 0) return `${what}: exit ${r.code ?? r.signal}${tail(ctx, r) ? `, last line: ${tail(ctx, r)}` : ""}`;
  return null;
}
const done = (problems, evidence, extra = {}) => ({ status: problems.length ? "fail" : "pass", evidence: problems.length ? problems.join("; ") : evidence, ...extra });

// Runs node:test files with the TAP reporter. Every required test must be present, ok, and not skipped.
async function nodeTests(ctx, files, required, { pattern, timeoutMs } = {}) {
  const missing = need(ctx, files);
  if (missing.length) return { problems: missing, skips: [], line: "" };
  const args = ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files];
  const r = await ctx.node(args, timeoutMs);
  const { tests, counts } = parseTap(r.stdout);
  const problems = [];
  const bad = exitProblem(ctx, files.join(" "), r);
  if (bad) problems.push(bad);
  if (counts.fail !== 0 || counts.cancelled !== 0) problems.push(`${counts.fail ?? "?"} failed, ${counts.cancelled ?? "?"} cancelled`);
  for (const t of tests.filter((x) => !x.ok)) problems.push(`not ok: ${t.name}`);
  for (const name of required) {
    const t = tests.find((x) => x.name === name);
    if (!t) problems.push(`required test missing: ${name}`);
    else if (t.directive) problems.push(`required test ${t.directive.toLowerCase()}ped, not verified: ${name}`);
  }
  const skips = tests.filter((t) => t.directive === "SKIP").map((t) => ({ test: t.name, reason: ctx.clean(t.reason) }));
  return { problems, skips, line: `${counts.pass ?? 0} of ${counts.tests ?? 0} tests ok, ${counts.skipped ?? 0} skipped` };
}

export const STAGES = [
  {
    id: "S1", name: "fixtures",
    claim: "Recorded verdicts are at least 10 days from expiry and match the published attestation report.",
    async run(ctx) {
      const files = ["tee/fixtures/verdicts.json", "tee/fixtures/verdicts-sandbox.json", "tee/fixtures/verdicts-unit.json", "contract/tests/fixtures/tee-verdicts.json", "tee/fixtures/attestation-report.json.b64"];
      const problems = need(ctx, files);
      if (problems.length) return done(problems);
      const r = await ctx.node(["certify/check-fixtures.mjs"]);
      const bad = exitProblem(ctx, "npm run check:fixtures", r);
      if (bad) problems.push(bad);
      const sets = [...r.stdout.matchAll(/^(PASS|FAIL) (\S+\.json): ([\d.]+|no expiry) days left/gm)];
      const passing = sets.filter((m) => m[1] === "PASS").length;
      if (sets.length !== 4 || passing !== 4) problems.push(`${passing} of ${sets.length} verdict sets at least 10 days from expiry (need 4 of 4)`);
      if (!/^PASS published attestation report is the one tee\/fixtures\/verdicts\.json was signed under$/m.test(r.stdout)) problems.push("published attestation report sha256 does not match tee/fixtures/verdicts.json");
      const days = sets.map((m) => Number(m[3])).filter(Number.isFinite);
      return done(problems, "4 of 4 verdict sets at least 10 days from expiry; published attestation report sha256 matches tee/fixtures/verdicts.json", { ephemeral: { fixture_days_left_min: days.length ? Math.min(...days) : null } });
    },
  },
  {
    id: "S2", name: "tamper",
    claim: "The TEE flags an altered amount, a hidden prompt injection and a reused document, and passes 16 of 16 honest documents. Every reply signature is checked.",
    async run(ctx) {
      const problems = need(ctx, ["tee/fixtures/verdicts.json", "tee/loans.json", "spec/nav/fixtures.json"]);
      if (problems.length) return done(problems);
      const r = await ctx.node(["tee/demo.mjs"]);
      const bad = exitProblem(ctx, "npm run demo", r);
      if (bad) problems.push(bad);
      const flags = (id) => (new RegExp(`^signed by TEE\\s+${id}\\s+expected \\S+\\s+->\\s+flag (.*)$`, "m").exec(r.stdout)?.[1] || "").split(", ");
      if (!flags("T1-altered-amount").includes("amount_mismatch")) problems.push("T1 not flagged amount_mismatch by a TEE-signed reply");
      if (!flags("T2-hidden-injection").includes("injection_attempt")) problems.push("T2 not flagged injection_attempt by a TEE-signed reply");
      if (!flags("T3-duplicate-as-new").includes("duplicate_document")) problems.push("T3 not flagged duplicate_document by a TEE-signed reply");
      if (/BAD SIGNATURE/.test(r.stdout)) problems.push("a reply signature does not recover to the attested TEE signer");
      if (!/^honest documents: 16 of 16 pass, every signature checked$/m.test(r.stdout)) problems.push("honest documents are not 16 of 16 pass");
      if (!/^Harbor with every document passing:\s+99\.17 green$/m.test(r.stdout)) problems.push("Harbor is not 99.17 green with every document passing");
      if (!/^Harbor after the TEE flags H-RE-01 \(T1\): 51\.59 red\b/m.test(r.stdout)) problems.push("Harbor is not 51.59 red after the T1 flag");
      return done(problems, "T1 amount_mismatch, T2 injection_attempt, T3 duplicate_document; honest 16 of 16, every signature checked; Harbor 99.17 green then 51.59 red");
    },
  },
  {
    id: "S3", name: "engine",
    claim: "Score engine: Harbor 99.17 green (public 99), Meridian 42.84 red (public 43); every worked-example field matches. TEE eval: 126 signed replies, 0 extra fields, 100% precision and recall on this synthetic set.",
    async run(ctx) {
      const problems = need(ctx, ["spec/nav/fixtures.json", "tee/eval/results.json", "tee/eval/holdout/results.json", "tee/eval/REPORT.md"]);
      if (problems.length) return done(problems);
      const nav = await ctx.node(["spec/nav/check.mjs"]);
      const bad = exitProblem(ctx, "node spec/nav/check.mjs", nav);
      if (bad) problems.push(bad);
      const block = (name) => nav.stdout.split(/^(?=\S)/m).find((b) => b.startsWith(`${name}\n`)) || "";
      const fund = (name) => {
        const b = block(name);
        const raw = Number(/ raw ([\d.]+)$/m.exec(b)?.[1]);
        const score = Number(/^\s+ok\s+score: expected (\d+), got \1$/m.exec(b)?.[1]);
        const band = /^\s+ok\s+band: expected (\w+), got \1$/m.exec(b)?.[1] || null;
        return { raw: Number.isFinite(raw) ? raw : null, score: Number.isFinite(score) ? score : null, band };
      };
      const h = fund("Harbor Credit Fund"), m = fund("Meridian Yield Fund");
      if (h.raw !== EXPECTED.harbor_raw || h.score !== EXPECTED.harbor_score || h.band !== "green") problems.push(`Harbor is ${h.raw} ${h.band} (public ${h.score}), README says 99.17 green (public 99)`);
      if (m.raw !== EXPECTED.meridian_raw || m.score !== EXPECTED.meridian_score || m.band !== "red") problems.push(`Meridian is ${m.raw} ${m.band} (public ${m.score}), README says 42.84 red (public 43)`);
      if (/^\s+FAIL /m.test(nav.stdout) || !/^All worked example numbers match\.$/m.test(nav.stdout)) problems.push("a worked-example field does not match");
      const ev = await ctx.node(["tee/eval/score.mjs"]);
      const bad2 = exitProblem(ctx, "npm run eval", ev);
      if (bad2) problems.push(bad2);
      for (const [set, n] of [["main", 86], ["holdout", 40]]) {
        if (!new RegExp(`^${set}: ${n} cases, ${n} signatures verified against the attested TEE key, ${n} replies within the reply rule$`, "m").test(ev.stdout)) problems.push(`eval ${set}: not ${n} of ${n} signatures verified within the reply rule`);
        if (!new RegExp(`^${set}: [\\s\\S]*?replies echoing extra fields: 0 of ${n} `, "m").test(ev.stdout)) problems.push(`eval ${set}: replies echo extra fields`);
      }
      if ((ev.stdout.match(/precision 100%, recall 100%,/g) || []).length !== 4) problems.push("eval precision or recall is not 100% on every set");
      const report = readFileSync(join(ctx.root, "tee/eval/REPORT.md"), "utf8");
      const limits = /^## Limits of this eval\s*\n\s*\n(.+?\.)\s/m.exec(report)?.[1] || null;
      if (!limits) problems.push("tee/eval/REPORT.md has no limits paragraph");
      return done(problems, `Harbor 99.17 green (public 99), Meridian 42.84 red (public 43), every worked-example field matches; eval 86+40 signatures verified, 0 extra fields, 100% precision and recall on this set (limits in tee/eval/REPORT.md)`, {
        notes: [`limit (tee/eval/REPORT.md): ${limits}`],
        pins: { harbor_raw: h.raw, meridian_raw: m.raw, harbor_score: h.score, meridian_score: m.score },
        data: { harbor: { ...h }, meridian: { ...m } },
      });
    },
  },
  {
    id: "S4", name: "v3 pin",
    claim: "The agent accepts only the engine hash pinned in receipts/v3-build.json. Any other engine is declined engine_hash.",
    async run(ctx) {
      const problems = need(ctx, ["receipts/v3-build.json", "schema/vectors/engine-v3-derived.json"]);
      if (problems.length) return done(problems, "", { pins: { engine_sha256: null } });
      let pin = null;
      try { pin = readJson(ctx, "receipts/v3-build.json")?.engine?.sha256 ?? null; } catch (e) { problems.push(`receipts/v3-build.json is not JSON (${ctx.clean(e.message)})`); }
      if (!/^[0-9a-f]{64}$/.test(pin || "")) problems.push("receipts/v3-build.json has no 64 hex engine.sha256");
      const r = await ctx.node(["judge/probes/pin-probe.mjs"]);
      const bad = exitProblem(ctx, "agent pin probe", r);
      let probe = null;
      try { probe = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { problems.push(bad || "agent pin probe printed no result"); }
      if (probe) {
        if (canonical(probe.pins) !== canonical([pin])) problems.push(`agent allowlist is ${probe.pins.length} engine(s), not exactly receipts/v3-build.json engine.sha256`);
        if (probe.other.reason !== "engine_hash" || probe.other.bought !== 0) problems.push(`another engine was ${probe.other.reason} and bought ${probe.other.bought}`);
        if (probe.committed.reason === "engine_hash") problems.push(`the committed v3 vector engine is not pinned: declined engine_hash, agent bought ${probe.committed.bought} (buys nothing)`);
        else if (probe.committed.bought !== 1) problems.push(`the pinned engine bought ${probe.committed.bought}, expected 1`);
      }
      const pinTest = await nodeTests(ctx, ["agent/test/engine-pin.test.mjs"], [
        "RT2-03 the allowlist is exactly the v3-build.json engine pin, and the test vector carries it",
        "RT2-03 a v3 receipt from a non-pinned engine is declined engine_hash, not treated like the pinned one",
        "RT2-03 fail closed: an empty allowlist pins nothing",
        "RT2-03 the agent buys nothing for a non-pinned engine, and still buys for the pinned one",
      ]);
      const privTest = await nodeTests(ctx, ["receipts/tests/receipt-v3-interface.test.mjs"], ["private report pins reproduce 9917 and 4284 while public scores are 99 and 43"], { pattern: "private report pins" });
      problems.push(...pinTest.problems, ...privTest.problems);
      return done(problems, `allowlist is exactly receipts/v3-build.json engine.sha256 ${pin}; another engine is declined engine_hash and bought 0, the pinned one bought 1 (fake chain); engine-pin tests ${pinTest.line}; private pins 9917 / 4284 hold, public 99 / 43`, {
        pins: { engine_sha256: /^[0-9a-f]{64}$/.test(pin || "") ? pin : null }, skips: [...pinTest.skips, ...privTest.skips], data: { engine_sha256: pin },
      });
    },
  },
  {
    id: "S5", name: "failed head",
    claim: "On a failed head, /report returns 409 run_failed, the entitlement is not used, and the agent buys nothing.",
    label: "local API on a fake chain with a disposable random test key, not an operator key",
    async run(ctx) {
      const t = await nodeTests(ctx, ["agent/test/failed-head.test.mjs", "api/test/failed-head.test.mjs"], [
        "fix13 a valid failed head is declined as run_failed and runAgent(execute) buys nothing",
        "fix13 a failed head for another token is receipt_token_mismatch and nothing is bought",
        "fix13 /report on a failed head is 409 run_failed and does not redeem a valid entitlement",
        "fix14 F3 an invalid failed head is 502 on /score and /report, never 409 run_failed, and never redeems",
      ]);
      return done(t.problems, `DEMO-CREDIT failed head: /score and /report 409 {error: "run_failed"}, entitlement not redeemed; runAgent(execute) bought false, spent 0; ${t.line}`, { skips: t.skips });
    },
  },
  {
    id: "S6", name: "paid report",
    claim: "/report without an entitlement returns 402; a one-use entitlement works once.",
    label: "local API on a fake chain",
    async run(ctx) {
      const t = await nodeTests(ctx, ["api/test/api.test.mjs"], [
        "GET /score is free and reads only the receipt contract",
        "GET /report without an entitlement is 402 with exactly what to buy",
        "a report entitlement is spent once and returns the stored public receipt",
        "an entitlement for another token or kind, an expired one or a bad id is refused without spending",
        "a purchase never changes the score response",
      ]);
      return done(t.problems, `/score free and unchanged after a purchase; a one-use entitlement returns 200 and the stored public receipt, a second use is refused; no entitlement is 402; ${t.line}`, { skips: t.skips });
    },
  },
  {
    id: "S7", name: "dashboard data",
    claim: "Dashboard data: Harbor 99 green, Meridian 43 red, DEMO-CREDIT run_failed.",
    label: "data only, no UI; the dashboard UI is not in this commit",
    async run(ctx) {
      const deps = ["S3", "S4", "S5", "S6"].filter((id) => ctx.results.get(id)?.status !== "pass");
      if (deps.length) return done([`needs ${deps.join(", ")} to pass first`]);
      const s3 = ctx.results.get("S3").data;
      const dash = {
        schema: "truenav-judge-dashboard/v1",
        label: "data only, no UI",
        commit: ctx.commit,
        funds: [
          { fund: "Harbor Credit Fund", raw: s3.harbor.raw, score: s3.harbor.score, band: s3.harbor.band, source: "S3 spec/nav/check.mjs" },
          { fund: "Meridian Yield Fund", raw: s3.meridian.raw, score: s3.meridian.score, band: s3.meridian.band, source: "S3 spec/nav/check.mjs" },
        ],
        tokens: [{ token: "DEMO-CREDIT", head: "failed", api: { score: 409, report: 409, error: "run_failed" }, agent: { bought: false, spent_yocto: "0" }, source: "S5 failed-head tests" }],
        paid_report: { score_free: true, missing_entitlement: 402, entitlement_uses: 1, source: "S6 api tests" },
        engine_sha256: ctx.results.get("S4").data.engine_sha256,
      };
      const body = JSON.stringify(dash, null, 2) + "\n";
      mkdirSync(ctx.outDir, { recursive: true });
      writeFileSync(join(ctx.outDir, "judge-dashboard.json"), body);
      return done([], `wrote out/judge-dashboard.json (sha256 ${sha256hex(body)}): Harbor ${s3.harbor.score} ${s3.harbor.band}, Meridian ${s3.meridian.score} ${s3.meridian.band}, DEMO-CREDIT run_failed`);
    },
  },
  {
    id: "S8", name: "mirror",
    claim: "The Base mirror contract accepts only the MPC signer and a rising sequence per token (local EVM, not deployed).",
    label: "local replay on ganache (chain 84532), not deployed",
    async run(ctx) {
      const t = await nodeTests(ctx, ["mirror/test/mirror.test.mjs", "mirror/test/scripts.test.mjs"], [
        "Solidity compiles and a local EVM checks only-MPC, increasing per-token seq, events and raw broadcast",
        "every committed Rust cross-check vector is independently re-encoded by viem",
        "event parser requires exactly one typed mirror event and validates every signed field",
      ], { timeoutMs: 120_000 });
      return done(t.problems, `Solidity compiles; local EVM enforces only-MPC and increasing per-token seq; every committed cross-check vector re-encodes; ${t.line}`, { skips: t.skips });
    },
  },
  {
    id: "S9", name: "attest, local subset",
    claim: "Every loan fingerprint in tee/loans.json is the recorded OutLayer fingerprint, and the attestation report is the published one (offline part only).",
    label: "offline slice; the OutLayer, RPC and Intel collateral checks are npm run verify:fingerprints and verify:attestation, run live in CI",
    async run(ctx) {
      const problems = need(ctx, ["tee/fixtures/fingerprints.json", "tee/loans.json", "tee/fixtures/verdicts.json", "tee/fixtures/attestation-report.json.b64"]);
      if (problems.length) return done(problems);
      const fp = readJson(ctx, "tee/fixtures/fingerprints.json");
      const { loans } = readJson(ctx, "tee/loans.json");
      const records = Array.isArray(fp.records) ? fp.records : [];
      if (!records.length) problems.push("tee/fixtures/fingerprints.json has no records");
      if (!/^[0-9a-f]{64}$/.test(fp.wasm_sha256 || "")) problems.push("tee/fixtures/fingerprints.json has no 64 hex wasm_sha256");
      for (const r of records) if (!/^[0-9a-f]{64}$/.test(r.loan_hash || "")) problems.push(`fingerprint record ${r.document_id} has no 64 hex loan_hash`);
      // the same lookup verify-fingerprints.mjs does after its network checks
      const byDoc = new Map(records.map((r) => [`${r.asset_type}|${r.document_id}`, r.loan_hash]));
      const mismatched = (Array.isArray(loans) ? loans : []).filter((l) => byDoc.get(`${l.asset_type}|${l.document_id}`) !== l.loan_hash);
      if (!Array.isArray(loans) || !loans.length) problems.push("tee/loans.json has no loans");
      if (mismatched.length) problems.push(`tee/loans.json loan_hash differs from the recorded fingerprint for ${mismatched.map((l) => l.loan_id).join(", ")}`);
      const live = readJson(ctx, "tee/fixtures/verdicts.json");
      const raw = Buffer.from(readFileSync(join(ctx.root, "tee/fixtures/attestation-report.json.b64"), "utf8").replace(/\s+/g, ""), "base64");
      if (sha256hex(raw) !== live?.attestation?.report_sha256) problems.push("attestation report sha256 differs from tee/fixtures/verdicts.json");
      return done(problems, `${loans.length} of ${loans.length} tee/loans.json hashes match tee/fixtures/fingerprints.json (${records.length} records, wasm ${fp.wasm_sha256}); attestation report sha256 matches; no RPC, OutLayer or Intel collateral used`);
    },
  },
  {
    id: "S10", name: "stamp",
    claim: "A wasm swapped after stamping is detected as stale.",
    label: "fake wasm in a temp tree, nothing built; this does not show that a real target/ wasm is fresh",
    async run(ctx) {
      const t = await nodeTests(ctx, ["receipts/tests/wasm-stamp-integrity.test.mjs"], [
        "RT2-04 a wasm swapped after stamping reads stale, and CI throws instead of using it",
        "RT2-04 an older one-line stamp, an empty stamp and a source-only stamp all read stale",
        "fail closed: no stamp under CI throws for CI=1, true, false and 0",
        "fail closed: a missing wasm cannot be stamped and a default build is refused in the sandbox path",
      ]);
      return done(t.problems, `a wasm swapped after stamping reads stale and CI throws; one-line, empty and source-only stamps read stale; ${t.line}`, { skips: t.skips });
    },
  },
];
