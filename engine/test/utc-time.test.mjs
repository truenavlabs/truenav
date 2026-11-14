// DIFF-03/04: the JS engine must read timestamps exactly as engine/v3-core/src/wire.rs timestamp() does:
// only YYYY-MM-DDTHH:MM:SSZ, a real Gregorian date, UTC. Everything else is "unknown" (age Infinity), never a guess,
// and the result must not depend on the process time zone.
// Expected values: engine/test/vectors/utc-timestamp.json, produced by running the Rust timestamp() on every input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const { cases } = JSON.parse(readFileSync(`${here}vectors/utc-timestamp.json`, "utf8"));
const NOW = Date.parse("2026-11-14T00:00:00Z");
const HOUR = 3600 * 1000;

/** Run `body` (ES module source, prints one JSON line) in a child process with the given TZ. */
function inTz(tz, body) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", body], { cwd: root, encoding: "utf8", env: { ...process.env, TZ: tz } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

const AGE_BODY = `
import { ageHours } from "./engine/src/score.mjs";
import { readFileSync } from "node:fs";
const { cases } = JSON.parse(readFileSync("./engine/test/vectors/utc-timestamp.json", "utf8"));
const now = ${NOW};
console.log(JSON.stringify(cases.map((c) => { const a = ageHours(c.input, now); return Number.isFinite(a) ? a : "Infinity"; })));
`;

const expectedAge = (c) => (c.rust_ms === null ? "Infinity" : Math.max(0, (NOW - c.rust_ms) / HOUR));

test("vectors file has valid and invalid cases for every class the brief names", () => {
  const has = (re) => cases.some((c) => re.test(c.input));
  assert.ok(cases.length > 400);
  assert.ok(cases.some((c) => c.rust_ms !== null) && cases.some((c) => c.rust_ms === null));
  for (const re of [/^2026-11-14T00:00:00Z$/, /\+07:00$/, /^2026-11-13T00:00Z$/, /^2026-11-13$/, /^2024-02-29T/, /^2026-02-29T/, /T24:00:00Z$/, /Nov 13 2026/, /\.000Z$/]) assert.ok(has(re), String(re));
});

for (const tz of ["UTC", "Asia/Bangkok", "America/Los_Angeles"]) {
  test(`ageHours matches the Rust timestamp() on every vector under TZ=${tz}`, () => {
    const got = inTz(tz, AGE_BODY);
    assert.equal(got.length, cases.length);
    const bad = [];
    cases.forEach((c, i) => { if (got[i] !== expectedAge(c)) bad.push(`${JSON.stringify(c.input)}: got ${got[i]}, want ${expectedAge(c)}`); });
    assert.deepEqual(bad.slice(0, 12), [], `${bad.length} of ${cases.length} differ`);
  });
}

test("the same inputs give identical ages under TZ=UTC and TZ=Asia/Bangkok", () => {
  assert.deepEqual(inTz("UTC", AGE_BODY), inTz("Asia/Bangkok", AGE_BODY));
});

test("the example from the audit: 'Nov 13 2026' is unknown, not 31 hours, under UTC+7", () => {
  const got = inTz("Asia/Bangkok", `
    import { ageHours } from "./engine/src/score.mjs";
    console.log(JSON.stringify(String(ageHours("Nov 13 2026", ${NOW}))));`);
  assert.equal(got, "Infinity");
});

test("parseUtcMs is exported and equals the Rust milliseconds, or NaN where Rust errs", async () => {
  const { parseUtcMs } = await import("../src/score.mjs");
  assert.equal(typeof parseUtcMs, "function");
  for (const c of cases) {
    const v = parseUtcMs(c.input);
    if (c.rust_ms === null) assert.ok(Number.isNaN(v), `${JSON.stringify(c.input)} -> ${v}`);
    else assert.equal(v, c.rust_ms, JSON.stringify(c.input));
  }
  for (const x of [undefined, null, 0, 1794614400000, {}, [], true]) assert.ok(Number.isNaN(parseUtcMs(x)), String(x));
});

test("cash_asof goes through the same parser: an offset, a missing seconds field or fractions do not attest cash", async () => {
  const { scoreFund } = await import("../src/score.mjs");
  const { model, fund, loan, STORE } = await import("./holes.scenarios.mjs");
  const now = "2026-11-14T00:00:00Z";
  const status = (asof) => {
    const iso = (h) => new Date(NOW - h * HOUR).toISOString().slice(0, 19) + "Z";
    const f = fund("C", "mgr-c", [loan("C-1", { servicer_asof: iso(12) })], 1100000, { cash: 100000, cash_attested: true, cash_asof: asof, nav_report_date: iso(12), certificate: { signed_at: iso(12), data_asof: iso(12), signer: "mgr-c", history: [{ fund_id: "C", signed_at: iso(24 * 8) }] } });
    return scoreFund(model, f, { now, certStore: STORE }).cash.attestationStatus;
  };
  assert.equal(status("2026-11-13T12:00:00Z"), "valid");
  for (const bad of ["2026-11-13T12:00:00+00:00", "2026-11-13T19:00:00+07:00", "2026-11-13T12:00Z", "2026-11-13T12:00:00.000Z", "2026-11-13"]) assert.equal(status(bad), "invalid", bad);
});

test("a score from a payload with a non-strict as-of is the same in every time zone", () => {
  const body = `
    import { scoreFund } from "./engine/src/score.mjs";
    import { model, fund, loan, STORE } from "./engine/test/holes.scenarios.mjs";
    const iso = (h) => new Date(${NOW} - h * 3600000).toISOString().slice(0, 19) + "Z";
    const f = fund("C", "mgr-c", [loan("C-1", { servicer_asof: "Nov 13 2026" })], 1000000, { nav_report_date: iso(12), certificate: { signed_at: iso(12), data_asof: iso(12), signer: "mgr-c", history: [{ fund_id: "C", signed_at: iso(24 * 8) }] } });
    const r = scoreFund(model, f, { now: "2026-11-14T00:00:00Z", certStore: STORE });
    console.log(JSON.stringify({ raw: r.raw, score: r.score, band: r.band, status: r.status, fresh: r.pillars.freshness, dataAgeHours: r.dataAgeHours ?? null }));`;
  assert.deepEqual(inTz("UTC", body), inTz("Asia/Bangkok", body));
});
