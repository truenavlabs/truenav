// Repro tests for the fix block on db8139f: holes 1 to 12, I1 and I2. One test per hole.
// Scenarios live in holes.scenarios.mjs so the same code can print a before/after table on an older engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../src/score.mjs";
import { scenarios } from "./holes.scenarios.mjs";

const run = (name) => scenarios[name](E);

test("hole 1: an nft_id verified in two funds counts as verified in neither, both orders, both flagged", () => {
  for (const pair of run("1 nft_id verified in two funds")) {
    for (const r of pair) {
      assert.equal(r.verified, 0);
      assert.equal(r.share, 1);
      assert.equal(r.status, "disclaimed");
      assert.equal(r.flag, true);
    }
  }
});

test("hole 2: a verified loan over-marked above its EAD cannot dilute the 50% test", () => {
  const r = run("2 over-marked verified loan in the 50% test");
  assert.equal(r.honest.status, "disclaimed");
  assert.equal(r.mark40M.status, "disclaimed");
  assert.equal(r.mark40M.share, 0.6);
  assert.equal(r.mark20M_h3_9M.status, "disclaimed");
  assert.equal(r.mark1B.status, "disclaimed");
});

test("hole 3: bucket names on Object.prototype never throw; Harbor still 99.17", () => {
  const r = run("3 bucket names on Object.prototype");
  for (const [bucket, v] of Object.entries(r)) {
    assert.equal(v.threw, undefined, bucket);
    assert.equal(v.harborRaw, 99.17, bucket);
    assert.equal(v.badReason, "invalid bucket", bucket);
    assert.deepEqual(v.noDpdReasons, ["invalid bucket"], bucket);
  }
});

test("hole 4: equal-age attempts rank by age then action_id; one escalation step each; order does not matter", () => {
  const r = run("4 equal-age attempts");
  assert.deepEqual(r["60,60"], r["90,60"]);
  assert.deepEqual(r["60,60"], r["60,60 reversed"]);
  assert.equal(r["60,60"].sibling.raw, 96.25);
  assert.equal(r["60,60"].sibling.penalty, 3.75);
  assert.deepEqual(r["60,60"].managerWide, ["a2"]);
  assert.deepEqual(r["0,0"].managerWide, ["a2"]);
  assert.deepEqual(r["0,0"], r["0,0 reversed"]);
  assert.equal(r["0,0"].sibling.raw, 85);
});

test("hole 5 (documented limit, TRUST_MODEL): renaming fund_id escapes previously_certified and shell attribution", () => {
  const r = run("5 payload-chosen fund_id (documented limit)");
  assert.deepEqual(r.noHeadline_asH, { status: "verification_failed", rank: 0, color: "red" });
  assert.deepEqual(r.noHeadline_renamed, { status: "not_rated", rank: null, color: "grey" });
  assert.equal(r.shell_asQ.raw, 96.25);
  assert.deepEqual(r.shell_asQ.reasons, ["shell: empty"]);
  assert.equal(r.shell_renamed.raw, 100);
  assert.equal(r.shell_renamed.band, "green");
});

test("hole 6 (replaced by 6b, owner 6 Nov): an expired claimed cash attestation is unattested, freshness unchanged, fund stays scored", () => {
  const r = run("6 expired but claimed cash attestation");
  assert.equal(r.claimed.status, "scored");
  assert.equal(r.claimed.freshness, 20);
  assert.equal(r.claimed.sibling.raw, 100);
  assert.equal(r.claimed.sibling.band, "green");
});

test("hole 7: exactly 50% is scored, including float noise and a cent-exact fund", () => {
  const r = run("7 float error at exactly 50%");
  assert.equal(r.g4.status, "scored");
  assert.equal(r.g4.raw, 40);
  assert.equal(r.centExact.status, "scored");
});

test("hole 8: a retry inside one fund keeps the youngest age, both list orders", () => {
  const r = run("8 retry age inside one fund");
  for (const k of ["60,0", "0,60"]) {
    assert.equal(r[k].effectiveAge, 0, k);
    assert.equal(r[k].sibling.raw, 85, k);
    assert.equal(r[k].sibling.band, "yellow", k);
    assert.equal(r[k].sibling.capped, true, k);
  }
});

test("hole 9: a payload manager_id that matches the attempt log is not a spoof; a mismatch still is", () => {
  const r = run("9 false manager_id spoof on no-cert funds");
  assert.deepEqual(r.matching, { spoof: false, flag: false, managerId: "M" });
  assert.equal(r.mismatch.spoof, true);
  assert.equal(r.mismatch.flag, true);
});

test("hole 10: a missing repaid does not hide the loan from concentration", () => {
  const r = run("10 missing repaid hides concentration");
  assert.deepEqual(r.missingRepaid, r.complete);
  assert.deepEqual(r.missingRepaid.breaches, [true, true]);
});

test("hole 11: a generated id never merges with a supplied id in concentration", () => {
  const r = run("11 generated id collides with supplied id");
  assert.equal(r.largest, 0.1);
  assert.equal(r.topFive, 0.5);
  assert.deepEqual(r.breaches, [false, false]);
});

test("hole 12: overflowing amounts are invalid_fund_fields, never scored NaN; the sibling sees the shell", () => {
  const r = run("12 overflow at principal 1e155");
  assert.equal(r.A.status, "invalid_fund_fields");
  assert.equal(r.A.floorBind, false);
  assert.equal(r.B.raw, 85);
  assert.equal(r.B.band, "yellow");
  assert.equal(r.B.managerWide, true);
});

test("I1: every listing fund warns when the shared attempt is within 90 days; scores unchanged", () => {
  const r = run("I1 warning on every listing fund");
  for (const k of ["HF", "FH"]) {
    assert.equal(r[k].harborWarn, true, k);
    assert.equal(r[k].fbigWarn, true, k);
    assert.equal(r[k].harborRaw, 85.8, k);
    assert.equal(r[k].fbigRaw, 86.64, k);
  }
});

test("I2: siblingAttempts.from is one fund_id and listedBy names every listing fund", () => {
  const r = run("I2 siblingAttempts.from is one fund_id");
  assert.equal(typeof r.from, "string");
  assert.ok(!r.from.includes(","));
  assert.equal(r.from, "D");
  assert.deepEqual(r.listedBy, ["Fbig", "D"]);
});

test("demo pins hold: Harbor 99.17 green, Meridian 42.84 red, 57.17 without its attempt", () => {
  const fx = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
  const opts = { now: fx.valuation_time, certStore: fx.cert_store };
  const m = { pd: fx.pd, lgd: fx.lgd };
  const [h, me] = E.scorePortfolio(m, fx.funds, opts);
  assert.equal(Math.round(h.raw * 100) / 100, 99.17);
  assert.equal(h.band, "green");
  assert.equal(Math.round(me.raw * 100) / 100, 42.84);
  assert.equal(me.band, "red");
  const noAttempt = { ...fx.funds[1], blocked_attempts: [] };
  assert.equal(Math.round(E.scoreFund(m, noAttempt, opts).raw * 100) / 100, 57.17);
});
