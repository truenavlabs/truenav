// RT3-04: a verified loan's reported_value above EAD must not buy coverage points, Policy NAV or a better band (JS engine).
// From the rt3b prototype. The Rust engine (outlayer/engine-v3/src/nav.rs) still sums marks uncapped, see NAV_SPEC.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../src/score.mjs";
import { fund, loan, unverified, model, NOW, STORE } from "./holes.scenarios.mjs";
const opts = { now: NOW, certStore: STORE };
const mk = (rv, headline = 2000000) => fund("M", "mgr-m", [loan("V", rv === null ? {} : { reported_value: rv }), unverified("U")], headline);
const honest = E.scoreFund(model, mk(null), opts);

test("honest baseline: coverage 20, raw 40, red", () => {
  assert.equal(honest.pillars.coverage, 20);
  assert.equal(honest.score, 40);
  assert.equal(honest.band, "red");
});
for (const rv of [9000000, 1e9]) {
  test(`reported_value ${rv} on the verified loan does not raise coverage or score`, () => {
    const r = E.scoreFund(model, mk(rv), opts);
    assert.ok(r.pillars.coverage <= honest.pillars.coverage, `coverage ${r.pillars.coverage} > ${honest.pillars.coverage}`);
    assert.ok(r.score <= honest.score, `score ${r.score} (${r.band}) > ${honest.score}`);
  });
}
test("a verified mark at or below EAD is unchanged (reported_value 900000)", () => {
  const r = E.scoreFund(model, mk(900000), opts);
  assert.equal(r.policyNav, 900000);
});
test("R10 shell size: an inflated mark does not lift Policy NAV above EAD", () => {
  const r = E.scoreFund(model, mk(9000000), opts);
  assert.ok(r.policyNav <= 1000000, `policyNav ${r.policyNav}`);
});
