// cashflow-v2.0.0 score (frozen regression): the demo funds land red with stated reasons, honest funds land green, and every cap
// threshold and the freshness windows behave as spec/v2/SPEC.md sections 5.6 and 6 say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { score as scoreAny, sourceFreshnessBps, isFresh, rhu, CAPS } from "./score.mjs";

// Frozen regression: these cases and expectations are cashflow-v2.0.0 and are scored as v2.0.0 (no collection
// rule). cashflow-v2.1.0 is tested in cashflow/test/collection.test.mjs.
const score = (m) => scoreAny(m, "cashflow-v2.0.0");

const { cases } = JSON.parse(readFileSync(new URL("./fixtures/score-cases.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));

for (const c of cases) {
  test(`fixture ${c.id}: score ${c.expect.score} ${c.expect.band}, caps [${c.expect.caps.join(", ")}]`, () => {
    const r = score(c.metrics);
    assert.equal(r.uncapped_score, c.expect.uncapped_score);
    assert.equal(r.score, c.expect.score);
    assert.equal(r.band, c.expect.band);
    assert.deepEqual(r.caps.map((x) => x.code), c.expect.caps);
    for (const cap of r.caps) assert.equal(cap.reason, CAPS[cap.code]);
  });
}

test("both demo funds are red with a stated reason, both honest funds are green", () => {
  for (const id of ["demo-credit-fund", "demo-rental-token"]) {
    const r = score(byId[id].metrics);
    assert.equal(r.band, "red");
    assert.ok(r.caps.length > 0 && r.caps.every((x) => x.reason.startsWith("red because")));
  }
  assert.ok(score(byId["demo-rental-token"].metrics).caps.some((x) => x.reason === "red because payouts exceed net cash from rent"));
  for (const id of ["honest-credit-fund", "honest-rental-token"]) assert.equal(score(byId[id].metrics).band, "green");
});

const base = () => structuredClone(byId["honest-credit-fund"].metrics);
const rentalBase = () => structuredClone(byId["honest-rental-token"].metrics);
const codes = (m) => score(m).caps.map((x) => x.code);

test("yield gap cap starts at exactly 300 bps", () => {
  const m = base();
  m.yield_gap_bps = 299;
  assert.ok(!codes(m).includes("yield_gap"));
  m.yield_gap_bps = 300;
  assert.ok(codes(m).includes("yield_gap"));
});

test("rental coverage cap below 1.00 only; payout part is 25 x clamp((coverage - 0.80) / 0.20)", () => {
  const m = rentalBase();
  m.rental_coverage_bps = 10000;
  assert.ok(!codes(m).includes("payout_exceeds_net_cash"));
  assert.equal(score(m).parts_x100.gap, 2500);
  m.rental_coverage_bps = 9999;
  assert.ok(codes(m).includes("payout_exceeds_net_cash"));
  for (const [cov, part] of [[7000, 0], [8000, 0], [8500, 625], [9000, 1250], [12000, 2500]]) {
    m.rental_coverage_bps = cov;
    assert.equal(score(m).parts_x100.gap, part, `coverage ${cov}`);
  }
});

test("claimed-not-settled cap only above 2% of claimed cash", () => {
  const m = base();
  m.exceptions.claimed_not_settled_cents = 2000000; // exactly 2% of 1,000,000.00
  assert.ok(!codes(m).includes("claimed_not_settled"));
  m.exceptions.claimed_not_settled_cents = 2000001;
  assert.ok(codes(m).includes("claimed_not_settled"));
});

test("any sponsor-funded distribution caps the score", () => {
  const m = base();
  m.exceptions.distribution_funded_by_sponsor = 1;
  assert.deepEqual(codes(m), ["distribution_funded_by_sponsor"]);
  assert.equal(score(m).score, 59);
});

test("a tier-3 source counts as fresh only inside its full-freshness window: else self-reported only", () => {
  const m = base();
  m.sources[0].age_hours = 24;
  assert.ok(!codes(m).includes("self_reported_only"));
  for (const h of [25, 96, 167, 168]) {
    m.sources[0].age_hours = h;
    assert.ok(codes(m).includes("self_reported_only"), `bank feed ${h} h old must not lift the cap`);
  }
  const monthlyBank = base();
  monthlyBank.sources[0] = { ...monthlyBank.sources[0], cadence: "monthly", age_hours: 35 * 24 };
  assert.ok(!codes(monthlyBank).includes("self_reported_only"));
  monthlyBank.sources[0].age_hours = 35 * 24 + 1;
  assert.ok(codes(monthlyBank).includes("self_reported_only"));
});

test("cash match is clamped at 10,000 bps", () => {
  const m = base();
  m.cash_match_bps = 12000;
  assert.equal(score(m).parts_x100.cash_match, 4000);
});

test("freshness is measured from the source as-of with a window per cadence; monthly exports do not drop to 0", () => {
  assert.equal(sourceFreshnessBps({ cadence: "daily", age_hours: 24 }), 10000);
  assert.equal(sourceFreshnessBps({ cadence: "daily", age_hours: 96 }), 5000);
  assert.equal(sourceFreshnessBps({ cadence: "daily", age_hours: 168 }), 0);
  assert.equal(sourceFreshnessBps({ cadence: "monthly", age_hours: 30 * 24 }), 10000);
  assert.equal(sourceFreshnessBps({ cadence: "monthly", age_hours: 50 * 24 }), 5000);
  assert.equal(sourceFreshnessBps({ cadence: "monthly", age_hours: 65 * 24 }), 0);
  assert.equal(sourceFreshnessBps({ cadence: "monthly", age_hours: 10, carried_forward: true }), 0);
  assert.deepEqual([isFresh({ cadence: "daily", age_hours: 24 }), isFresh({ cadence: "daily", age_hours: 25 }), isFresh({ cadence: "monthly", age_hours: 840 }), isFresh({ cadence: "monthly", age_hours: 841 }), isFresh({ cadence: "daily", age_hours: 1, carried_forward: true })], [true, false, true, false, false]);
});

test("round half up on integers", () => {
  assert.deepEqual([rhu(5, 2), rhu(4, 2), rhu(7, 3), rhu(8, 3), rhu(0, 9)], [3, 2, 2, 3, 0]);
  assert.throws(() => rhu(1.5, 2));
  assert.throws(() => rhu(-1, 2));
});
