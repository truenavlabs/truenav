import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  scoreFund, scorePortfolio, gapPoints, coveragePoints, freshness, penalty, dedupeAttempts, attemptCost,
  roundHalfUp, bandOf, passesMinScore, LABELS, MODEL_LABELS, DEFAULT_MODEL, THRESHOLDS, STATUS_RANK,
} from "../src/score.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
const model = { pd: fixtures.pd, lgd: fixtures.lgd };
const NOW = fixtures.valuation_time;
const NOW_MS = Date.parse(NOW);
const ago = (h) => new Date(NOW_MS - h * 3600 * 1000).toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const harbor = () => clone(fixtures.funds.find((f) => f.fund_id === "harbor-credit-fund"));
const meridian = () => clone(fixtures.funds.find((f) => f.fund_id === "meridian-yield-fund"));
const score = (f, opts = {}) => scoreFund(model, f, { now: NOW, ...opts });
const close = (actual, expected, eps = 0.005) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

let seq = 0;
function loan(over = {}) {
  const id = over.id ?? `L${++seq}`;
  return {
    id, asset: "real_estate", principal: 1000000, accrued: 0, repaid: 0, bucket: "current",
    nft: true, nft_id: `nft-${id}`, anomaly: false, ...over,
  };
}
function fund(over = {}) {
  const ageH = over.ageH ?? 12;
  const id = over.fund_id ?? `fund-${++seq}`;
  const signer = over.signer ?? "mgr-test.demo";
  const prev = over.prev ?? true;
  const loans = (over.loans ?? []).map((l) => ({ servicer_asof: ago(ageH), ...l }));
  const f = {
    fund_id: id, name: id, cash: 0, cash_attested: false, liabilities: 0, liabilities_attested: false,
    nav_report_date: ago(ageH),
    certificate: { signed_at: ago(ageH), data_asof: ago(ageH), signer, history: prev ? [{ fund_id: id, signed_at: ago(ageH + 24 * 7) }] : [] },
    policy_markdown: {}, blocked_attempts: [], ...over, loans,
  };
  for (const k of ["ageH", "signer", "prev"]) delete f[k];
  return f;
}
function withSigner(f, signer) {
  f.certificate.signer = signer;
  return f;
}
// Scored fund with six fresh attempts: one 1M loan, data 500 h old, raw -10 (fix 5).
function boundFund(signer) {
  return fund({
    fund_id: `bound-${signer}`, signer, ageH: 500, loans: [loan({ id: `B-${signer}` })], headline_nav: 1000000,
    blocked_attempts: [0, 1, 2, 3, 4, 5].map((k) => ({ action_id: `b-${signer}-${k}`, age_days: 0 })),
  });
}
function allNumbers(obj, path = "") {
  const out = [];
  if (typeof obj === "number") out.push([path, obj]);
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) out.push(...allNumbers(v, `${path}.${k}`));
  return out;
}
function assertNoNaN(r) {
  for (const [p, v] of allNumbers(r)) {
    assert.ok(!Number.isNaN(v), `NaN at ${p}`);
    if (!p.endsWith(".shareRaw") && !p.endsWith("dataAgeHours")) assert.ok(Number.isFinite(v), `non-finite at ${p}: ${v}`);
  }
}

// Worked example (spec section 4).
test("worked example: Harbor 99 green, raw 99.17", () => {
  const r = score(harbor());
  assert.equal(r.status, "scored");
  assert.equal(r.score, 99);
  assert.equal(r.band, "green");
  close(r.raw, 99.1667, 0.001);
  close(r.pillars.gap, 40);
  close(r.pillars.coverage, 40);
  close(r.pillars.freshness, 19.17);
  assert.equal(Math.round(r.policyNav), 9500000);
  assert.equal(Math.round(r.trueVal), 9665110);
  assert.equal(Math.round(r.trueRange), 345554);
  assert.equal(Math.round(r.trueRangeLow), 9319556);
  assert.equal(Math.round(r.trueRangeHigh), 10010664);
  assert.equal(r.counts.loans, 12);
  assert.equal(r.counts.open, 11);
});

test("worked example: Meridian 43 red, raw 42.84, over by 280,595", () => {
  const r = score(meridian());
  assert.equal(r.score, 43);
  assert.equal(r.band, "red");
  close(r.raw, 42.84);
  close(r.pillars.gap, 3.71);
  close(r.pillars.coverage, 36.79);
  close(r.pillars.freshness, 16.67);
  close(r.pillars.penalty, 14.32);
  assert.equal(r.headline, 3735000);
  assert.equal(Math.round(r.policyNav), 3435000);
  assert.equal(Math.round(r.trueVal), 3092970);
  assert.equal(Math.round(r.trueRange), 361435);
  assert.equal(Math.round(r.gap.over), 280595);
  assert.equal(r.gap.under, 0);
  assert.equal(r.gap.boundSide, "over");
  close(r.unverified.shareRaw, 0.0803, 0.0001);
});

test("worked example: Meridian without the attempt is 57 red, raw 57.17", () => {
  const f = meridian();
  f.blocked_attempts = [];
  const r = score(f);
  close(r.raw, 57.17);
  assert.equal(r.score, 57);
  assert.equal(r.band, "red");
});

test("worked example: concentration Harbor 18.1% / 69.3%, Meridian 41.0% / 100%, flags only", () => {
  const h = score(harbor());
  close(h.concentration.largestShare, 0.181, 0.0005);
  close(h.concentration.topFiveShare, 0.693, 0.0005);
  assert.equal(h.concentration.largestBreach, true);
  assert.equal(h.concentration.topFiveBreach, true);
  const m = score(meridian());
  close(m.concentration.largestShare, 0.410, 0.0005);
  close(m.concentration.topFiveShare, 1, 1e-9);
  assert.equal(m.concentration.largestBreach, true);
  assert.equal(m.concentration.topFiveBreach, true);
  assert.equal(h.score, 99);
});

test("fixtures expected values all match the engine", () => {
  for (const f of fixtures.funds) {
    const r = score(f);
    const e = f.expected;
    assert.equal(r.headline, e.headline);
    assert.equal(Math.round(r.policyNav), e.policy);
    assert.equal(Math.round(r.trueVal), e.trueVal);
    assert.equal(Math.round(r.trueRange), e.trueRange);
    assert.equal(r.rawDisplay, e.raw);
    assert.equal(r.score, e.score);
    assert.equal(r.band, e.band);
    assert.equal(r.status, e.status);
    for (const l of f.loans) assert.ok(Object.hasOwn(l, "repaid"), `${l.id} carries repaid`);
  }
});

// Bug fixes.
test("B1 unknown asset and unknown bucket: no throw, excluded with reason, off coverage", () => {
  const f = fund({ loans: [loan({ id: "A" }), loan({ id: "E", asset: "equipment" }), loan({ id: "B", bucket: "dpd_200" })], headline_nav: 3000000 });
  const r = score(f);
  assert.deepEqual(r.exclusions.map((e) => [e.id, e.reason]), [["E", "unknown asset"], ["B", "invalid bucket"]]);
  assert.equal(r.counts.verified, 1);
  close(r.coverage, 1 / 3, 1e-9);
});

test("B2 overpaid loan: excluded 'overpaid, check servicing', line 0, raw negative in walk", () => {
  const f = fund({ loans: [loan({ id: "A" }), loan({ id: "O", principal: 100000, accrued: 0, repaid: 150000 })], headline_nav: 1000000 });
  const r = score(f);
  const e = r.exclusions.find((x) => x.id === "O");
  assert.equal(e.reason, "overpaid, check servicing");
  assert.equal(e.value, 0);
  assert.equal(e.raw_value, -50000);
  assert.equal(e.ead_raw, -50000);
  assert.equal(r.listedBook, 1000000);
  assert.equal(r.unverified.loans, 0);
});

test("B3 string principal: excluded 'incomplete data', no concatenation, score not 100", () => {
  const f = harbor();
  f.loans[0].principal = "1791000";
  const r = score(f);
  assert.equal(r.exclusions[0].reason, "incomplete data");
  assert.ok(r.listedBook < 1e7 && Number.isFinite(r.listedBook));
  assert.ok(r.score === null || r.score < 100);
  assertNoNaN(r);
});

test("B4 missing principal and fuzzed bad inputs: never dropped, never NaN, never throws", () => {
  const f = fund({ loans: [loan({ id: "A" }), loan({ id: "M", principal: undefined })], headline_nav: 2000000 });
  const r = score(f);
  assert.equal(r.exclusions.find((x) => x.id === "M").reason, "incomplete data");
  assert.equal(r.counts.loans, 2);
  assertNoNaN(r);
  const bad = [NaN, Infinity, -Infinity, null, "12", {}, [], undefined, true];
  for (const v of bad) {
    for (const k of ["principal", "accrued", "repaid", "reported_value", "dpd", "nft_id"]) {
      assertNoNaN(score(fund({ loans: [loan({ [k]: v }), loan()], headline_nav: 2000000 })));
    }
    for (const k of ["headline_nav", "cash", "liabilities", "cash_asof", "nav_report_date"]) {
      assertNoNaN(score(fund({ loans: [loan()], headline_nav: 1000000, [k]: v })));
    }
  }
  assertNoNaN(score(null));
  assertNoNaN(score({ loans: [null, 7, "x"] }));
});

test("B5 a negative line cannot raise coverage; coverage never above 1", () => {
  const base = fund({ loans: [loan({ id: "A" })], headline_nav: 1000000 });
  const neg = fund({ loans: [loan({ id: "A" }), loan({ id: "N", reported_value: -500000 })], headline_nav: 1000000 });
  const below = fund({ loans: [loan({ id: "A" })], headline_nav: 400000 });
  const rb = score(base);
  const rn = score(neg);
  assert.ok(rn.coverage <= rb.coverage);
  assert.ok(rn.pillars.coverage <= 40);
  assert.ok(score(below).coverage <= 1);
  assert.ok(score(below).pillars.coverage <= 40);
});

test("B6 missing certificate: previously certified -> verification_failed, never certified -> not_rated", () => {
  const prev = fund({ fund_id: "c1", loans: [loan()], headline_nav: 1000000 });
  delete prev.certificate;
  const r1 = score(prev, { certStore: { c1: [{ fund_id: "c1", signed_at: ago(200) }] } });
  assert.equal(r1.status, "verification_failed");
  assert.equal(r1.score, null);
  const fresh = fund({ fund_id: "c2", loans: [loan()], headline_nav: 1000000 });
  delete fresh.certificate;
  const r2 = score(fresh);
  assert.equal(r2.status, "not_rated");
  assert.equal(r2.color, "grey");
});

test("B7 empty fund: headline 0 -> not_rated 'no loans in book', headline > 0 -> disclaimed", () => {
  const r0 = score(fund({ loans: [], headline_nav: 0 }));
  assert.equal(r0.status, "not_rated");
  assert.deepEqual(r0.statusReasons, ["no loans in book"]);
  const r1 = score(fund({ loans: [], headline_nav: 100 }));
  assert.equal(r1.status, "disclaimed");
  assert.equal(r1.score, null);
});

test("B8 no verified loans: gap 0 (not 40), coverage 0, freshness scored", () => {
  const r = score(fund({ loans: [loan({ nft: false, nft_id: undefined }), loan({ anomaly: true })], headline_nav: 2000000 }));
  assert.equal(r.counts.verified, 0);
  assert.equal(r.pillars.gap, 0);
  assert.equal(r.pillars.coverage, 0);
  assert.equal(r.pillars.freshness, 20);
  assert.equal(gapPoints({ lih: 0, policyNav: 0, lo: 0, hi: 0, trueVal: 0, hasVerified: false }).points, 0);
});

// Rules.
test("T1 PD and LGD tables: exact values and labels", () => {
  assert.deepEqual({ ...DEFAULT_MODEL.pd }, { current: 0.02, dpd_1_30: 0.1, dpd_31_60: 0.25, dpd_61_90: 0.45, dpd_over_90: 1.0 });
  assert.deepEqual({ ...DEFAULT_MODEL.lgd }, { real_estate: 0.31, invoices: 0.67 });
  assert.deepEqual(fixtures.pd, { ...DEFAULT_MODEL.pd });
  assert.deepEqual(fixtures.lgd, { ...DEFAULT_MODEL.lgd });
  assert.equal(MODEL_LABELS.pd, "demo, not calibrated");
  assert.equal(MODEL_LABELS.lgd, "inference from a corporate stress table; KBRA methodology does not address CRE CLOs");
  assert.equal(MODEL_LABELS.trueRange, "demo range (independent defaults)");
});

test("T2 TrueVal and TrueRange formula; range edges inclusive", () => {
  // One current invoice of 1,000,000: TrueVal = 1e6 x (1 - 0.02 x 0.67) = 986,600.
  // TrueRange = 1.96 x sqrt(1e12 x 0.4489 x 0.0196) = 1.96 x 93,800 = 183,848.
  const r = score(fund({ loans: [loan({ asset: "invoices" })], headline_nav: 1000000 }));
  close(r.trueVal, 986600, 1e-6);
  close(r.trueRange, 183848, 1e-6);
  assert.deepEqual(gapPoints({ lih: 1100, policyNav: 1100, lo: 900, hi: 1100, trueVal: 1000, hasVerified: true }).points, 40);
  assert.deepEqual(gapPoints({ lih: 900, policyNav: 900, lo: 900, hi: 1100, trueVal: 1000, hasVerified: true }).points, 40);
  assert.ok(gapPoints({ lih: 1100.5, policyNav: 1000, lo: 900, hi: 1100, trueVal: 1000, hasVerified: true }).points < 40);
});

test("T3 weights 40/40/20, bands 85/60 on the rounded score, raw to 1 decimal", () => {
  const r = score(harbor());
  assert.ok(r.pillars.gap <= 40 && r.pillars.coverage <= 40 && r.pillars.freshness <= 20);
  assert.equal(r.rawDisplay, "99.2");
  assert.equal(roundHalfUp(84.5), 85);
  assert.equal(bandOf(roundHalfUp(84.5)), "green");
  assert.equal(roundHalfUp(59.5), 60);
  assert.equal(bandOf(roundHalfUp(59.5)), "yellow");
  assert.equal(bandOf(84), "yellow");
  assert.equal(bandOf(59), "red");
});

test("T4 penalty: 15 halving every 30 days, linear stacking, retries deduped, repeats counted, floor 0", () => {
  close(attemptCost(0), 15, 1e-12);
  close(attemptCost(30), 7.5, 1e-12);
  close(attemptCost(60), 3.75, 1e-12);
  close(penalty([{ action_id: "a", age_days: 0 }, { action_id: "b", age_days: 30 }]), 22.5, 1e-12);
  const d = dedupeAttempts([{ action_id: "a", age_days: 0 }, { action_id: "a", age_days: 0 }]);
  assert.equal(d.attempts.length, 1);
  assert.equal(d.retries, 1);
  close(penalty([{ action_id: "a", age_days: 0 }, { action_id: "a2", age_days: 0 }]), 30, 1e-12);
  // Floor bind only on a scored fund that carries a penalty (fix 5).
  const r = score(boundFund("mgr-t4"));
  assert.equal(r.status, "scored");
  close(r.raw, -10, 1e-9);
  close(r.pillars.penalty, 90, 1e-9);
  assert.equal(r.floorBind, true);
  const disc = score(fund({ loans: [loan({ anomaly: true })], headline_nav: 1000000, ageH: 500, blocked_attempts: [{ action_id: "x", age_days: 0 }] }));
  assert.equal(disc.status, "disclaimed");
  assert.equal(disc.floorBind, false);
});

test("T5 manager-wide on floor bind and on 2+ attempts in 90 days; warning otherwise; size on Policy NAV", () => {
  // Warning only: one attempt by a non-shell sibling.
  const h1 = withSigner(harbor(), "mgr-one");
  const m1 = withSigner(meridian(), "mgr-one");
  const [rh1] = scorePortfolio(model, [h1, m1], { now: NOW });
  assert.equal(rh1.managerWarning, true);
  assert.equal(rh1.penaltyDetail.managerWide, false);
  assert.equal(rh1.score, 99);
  assert.equal(rh1.band, "green");

  // 2+ attempts in 90 days, counted per manager: the second attempt goes manager-wide.
  const m2 = withSigner(meridian(), "mgr-two");
  m2.blocked_attempts = [{ action_id: "a1", age_days: 10 }, { action_id: "a2", age_days: 5 }];
  const [rh2] = scorePortfolio(model, [withSigner(harbor(), "mgr-two"), m2], { now: NOW });
  assert.equal(rh2.penaltyDetail.managerWide, true);
  assert.deepEqual(rh2.penaltyDetail.siblingAttempts.map((a) => a.action_id), ["a2"]);
  close(rh2.pillars.penalty, attemptCost(5), 1e-9);
  assert.ok(rh2.penaltyDetail.managerWideReasons.includes("2+ attempts in 90 days"));

  // Floor bind: a scored manager fund with a penalty and raw <= 0 makes Meridian's single non-shell attempt manager-wide.
  const dead = boundFund("mgr-three");
  const [rh3, , rd] = scorePortfolio(model, [withSigner(harbor(), "mgr-three"), withSigner(meridian(), "mgr-three"), dead], { now: NOW });
  assert.equal(rd.status, "scored");
  assert.equal(rd.floorBind, true);
  const fromMeridian = rh3.penaltyDetail.siblingAttempts.find((a) => a.from === "meridian-yield-fund");
  assert.ok(fromMeridian.reasons.includes("floor bind on a manager fund"));
  assert.ok(!fromMeridian.reasons.includes("2+ attempts in 90 days"));
  close(rh3.pillars.penalty, 90 + attemptCost(2), 1e-9);

  // An empty no-data fund must not floor-bind (fails on the cb688fc engine: Harbor 85).
  const E5 = { fund_id: "E5", headline_nav: 0, loans: [], certificate: { signer: "mgr-five", signed_at: ago(12) } };
  const [rh5, , re5] = scorePortfolio(model, [withSigner(harbor(), "mgr-five"), withSigner(meridian(), "mgr-five"), E5], { now: NOW });
  assert.equal(rh5.score, 99);
  assert.equal(rh5.band, "green");
  assert.equal(rh5.penaltyDetail.managerWide, false);
  assert.equal(re5.floorBind, false);

  // Size is measured on Policy NAV, not headline: a big headline does not stop a small verified fund being a shell.
  const big = fund({ signer: "mgr-four", loans: [loan({ id: "Q" })], headline_nav: 1500000, blocked_attempts: [{ action_id: "q", age_days: 0 }] });
  big.loans[0].principal = 800000;
  const res = scorePortfolio(model, [withSigner(harbor(), "mgr-four"), big], { now: NOW });
  close(res[1].penaltyDetail.ownAttemptsManagerWide[0].policyShareOfLargest, 800000 / 9500000, 1e-9);
  assert.ok(res[0].penaltyDetail.managerWide);
});

test("T6 no green within 30 days of an attempt; same yellow cap on manager-wide siblings", () => {
  const perfect = fund({ loans: [loan()], headline_nav: 1000000, blocked_attempts: [{ action_id: "p", age_days: 0 }] });
  const r = score(perfect);
  assert.equal(r.score, 85);
  assert.equal(r.band, "yellow");
  assert.equal(r.noGreenCapApplied, true);
  const old = score(fund({ loans: [loan()], headline_nav: 1000000, blocked_attempts: [{ action_id: "p", age_days: 31 }] }));
  assert.equal(old.band, "green");
});

test("T7 50% boundary: exactly 50% scored, just above disclaimed; display capped, raw kept", () => {
  const at = score(fund({ loans: [loan({ reported_value: 500 , principal: 500 })], headline_nav: 1000 }));
  assert.equal(at.unverified.shareRaw, 0.5);
  assert.equal(at.status, "scored");
  const above = score(fund({ loans: [loan({ reported_value: 500, principal: 500 })], headline_nav: 1001 }));
  assert.ok(above.unverified.shareRaw > 0.5);
  assert.equal(above.status, "disclaimed");
  const over = score(fund({ loans: [loan({ id: "V", principal: 100 }), loan({ id: "U", principal: 1000, nft: false, nft_id: undefined, reported_value: 0 })], headline_nav: 100 }));
  assert.ok(over.unverified.shareRaw > 1);
  assert.equal(over.unverified.shareDisplay, 1);
});

test("T8 status order and filter: score >= 60 never passes a no-number status", () => {
  assert.ok(STATUS_RANK.verification_failed < STATUS_RANK.disclaimed);
  assert.ok(STATUS_RANK.disclaimed < STATUS_RANK.red && STATUS_RANK.red < STATUS_RANK.yellow && STATUS_RANK.yellow < STATUS_RANK.green);
  const disclaimed = score(fund({ loans: [], headline_nav: 100 }));
  const notRated = score(fund({ loans: [], headline_nav: 0 }));
  const failed = score(fund({ loans: [loan()], headline_nav: 1000000, ageH: 24 * 31 }));
  for (const r of [disclaimed, notRated, failed]) assert.equal(passesMinScore(r, 60), false);
  assert.equal(notRated.statusRank, null);
  assert.equal(passesMinScore(score(harbor()), 60), true);
});

test("T9 freshness from oldest data as-of; stale or headline-less previously certified fund fails", () => {
  const f = harbor();
  f.cash = 100;
  f.cash_attested = true;
  f.cash_asof = ago(100);
  close(score(f).dataAgeHours, 100, 1e-9);
  const stale = fund({ loans: [loan()], headline_nav: 1000000, ageH: 24 * 31 });
  assert.equal(score(stale).status, "verification_failed");
  const noHead = fund({ loans: [loan()] });
  assert.equal(score(noHead).status, "verification_failed");
  assert.equal(freshness(24), 1);
  close(freshness(96), 0.5, 1e-12);
  assert.equal(freshness(168), 0);
});

test("T10 headline below book: flag with amount and percent, no penalty", () => {
  const f = harbor();
  f.headline_nav = 9000000;
  const r = score(f);
  assert.equal(r.residual.kind, "headline below book");
  assert.equal(r.headlineBelowBook.amount, 500000);
  close(r.headlineBelowBook.percent, 500000 / 9500000, 1e-12);
  assert.equal(r.pillars.penalty, 0);
});

test("T11 concentration is a flag only: grouping by obligor changes the share, not the score", () => {
  const a = score(fund({ loans: [loan({ id: "A" }), loan({ id: "B" })], headline_nav: 2000000 }));
  const b = score(fund({ loans: [loan({ id: "A", obligor_id: "o1" }), loan({ id: "B", obligor_id: "o1" })], headline_nav: 2000000 }));
  close(a.concentration.largestShare, 0.5, 1e-12);
  close(b.concentration.largestShare, 1, 1e-12);
  assert.equal(a.score, b.score);
});

test("T12 walk fields present and reasons listed", () => {
  const r = score(meridian());
  for (const k of ["headline", "listedBook", "cash", "liabilities", "lih", "residual", "policyNav", "trueVal", "trueRange",
    "trueRangeLow", "trueRangeHigh", "gap", "exclusions", "exclusionsByReason", "zeroMarkedUnverified", "unverified",
    "concentration", "pillars", "raw", "rawDisplay", "score", "band", "status", "statusRank", "managerWarning",
    "noGreenCapApplied", "penaltyDetail", "managerId", "previouslyCertified", "spoofFlags"]) {
    assert.ok(Object.hasOwn(r, k), `missing ${k}`);
  }
  assert.deepEqual(r.unverified.reasons, [{ id: "M-IN-03", reason: "anomaly flag" }]);
  assert.equal(r.liabilities.label, "liabilities self-reported");
});

test("T13 label constants exported; the retired name for TrueVal is gone from the repo", () => {
  assert.equal(LABELS.trueVal.label, "TrueVal");
  assert.equal(LABELS.trueRange.label, "TrueRange");
  assert.equal(LABELS.score.label, "TrueNav score");
  assert.match(LABELS.trueVal.tooltip, /model estimate, not fair value/);
  const root = new URL("../../", import.meta.url).pathname;
  const needle = ["TrueNav", "NAV"].join(" ");
  const hits = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const name of names) {
      // skip VCS, dependencies, and build trees another test may be compiling into
      if (name === ".git" || name === "node_modules" || name === "target") continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (st.isDirectory()) walk(p);
      else {
        try {
          if (readFileSync(p, "utf8").includes(needle)) hits.push(p);
        } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

test("T14 coverage uses max(LIH, L); LIH subtracts attested cash only", () => {
  assert.deepEqual(coveragePoints(500, 1000, 800), { ratio: 0.5, points: 20 });
  assert.deepEqual(coveragePoints(500, 0, 0), { ratio: 0, points: 0 });
  const att = harbor();
  Object.assign(att, { cash: 1000000, cash_attested: true, cash_asof: ago(12), headline_nav: 10500000 });
  assert.equal(score(att).lih, 9500000);
  const un = harbor();
  Object.assign(un, { cash: 1000000, cash_attested: false, headline_nav: 10500000 });
  assert.equal(score(un).lih, 10500000);
});

test("T15 gap uses max(over, under); walk records both", () => {
  const g = gapPoints({ lih: 1200, policyNav: 700, lo: 900, hi: 1100, trueVal: 1000, hasVerified: true });
  assert.equal(g.over, 100);
  assert.equal(g.under, 200);
  assert.equal(g.beyond, 200);
  assert.equal(g.boundSide, "under");
  assert.equal(g.points, 0);
});

test("T16 missing repaid: incomplete data, still counted in the 50% test at max(mark, principal + accrued)", () => {
  const r = score(fund({ loans: [loan({ id: "A" }), loan({ id: "R", repaid: undefined, principal: 300000, accrued: 5000, reported_value: 100000 })], headline_nav: 1100000 }));
  const e = r.exclusions.find((x) => x.id === "R");
  assert.equal(e.reason, "incomplete data");
  assert.equal(r.unverified.loans, 305000);
});

test("T17 dpd contradicting the bucket: invalid bucket, excluded", () => {
  const r = score(fund({ loans: [loan({ id: "A" }), loan({ id: "D", dpd: 45, bucket: "current" }), loan({ id: "OK", dpd: 0 })], headline_nav: 3000000 }));
  assert.deepEqual(r.exclusions.map((e) => [e.id, e.reason]), [["D", "invalid bucket"]]);
});

// Exploit repros.
test("X1 padding never raises the score: honest 60 yellow, padded 53 red", () => {
  const mk = (headline) => fund({ loans: [loan({ bucket: "dpd_over_90", dpd: 120 })], policy_markdown: { dpd_over_90: 0.5 }, headline_nav: headline });
  const honest = score(mk(500000));
  const padded = score(mk(604000));
  assert.equal(honest.score, 60);
  assert.equal(honest.band, "yellow");
  assert.equal(padded.score, 53);
  close(padded.raw, 53.11);
  assert.equal(padded.residual.kind, "not listed in book");
  assert.equal(padded.residual.amount, 104000);
});

test("X2 cash: attested 99 green; unattested 75 yellow (raw 75.11, unverified 9.52%)", () => {
  const att = harbor();
  Object.assign(att, { cash: 1000000, cash_attested: true, cash_asof: ago(12), headline_nav: 10500000 });
  const ra = score(att);
  assert.equal(ra.score, 99);
  assert.equal(ra.band, "green");
  close(ra.raw, 99.17);
  const un = harbor();
  Object.assign(un, { cash: 1000000, cash_attested: false, headline_nav: 10500000 });
  const ru = score(un);
  assert.equal(ru.score, 75);
  close(ru.raw, 75.11);
  close(ru.pillars.gap, 19.75);
  close(ru.pillars.coverage, 36.19);
  close(ru.unverified.shareRaw, 0.0952, 0.0001);
});

test("X3 leverage: Meridian + 400,000 liabilities, headline 3,335,000 -> LIH 3,735,000 -> 43 red", () => {
  const f = meridian();
  Object.assign(f, { liabilities: 400000, headline_nav: 3335000 });
  const r = score(f);
  assert.equal(r.lih, 3735000);
  assert.equal(r.score, 43);
});

test("X4 understatement: Harbor headline 8,000,000 -> 59 red, under by 1,319,556; 1,000,000 -> 59 red", () => {
  const f = harbor();
  f.headline_nav = 8000000;
  const r = score(f);
  assert.equal(r.score, 59);
  close(r.raw, 59.17);
  assert.equal(Math.round(r.gap.under), 1319556);
  const g = harbor();
  g.headline_nav = 1000000;
  assert.equal(score(g).score, 59);
});

const shell = (signer, principal, headline, attemptAge = 0, id = "shell") => {
  const s = fund({ fund_id: id, signer, loans: [loan({ id: `${id}-1`, principal })], headline_nav: headline, blocked_attempts: [{ action_id: `act-${id}`, age_days: attemptAge }] });
  return s;
};

test("X5 shell attempt goes manager-wide: Harbor 84 yellow, Meridian 28 red, shell disclaimed with penalty 15", () => {
  const S = shell("mgr-one", 700000, 1500000);
  const [h, m, s] = scorePortfolio(model, [withSigner(harbor(), "mgr-one"), withSigner(meridian(), "mgr-one"), S], { now: NOW });
  assert.equal(h.score, 84);
  assert.equal(h.band, "yellow");
  close(h.raw, 84.17);
  assert.equal(m.score, 28);
  close(m.raw, 27.84);
  assert.equal(s.status, "disclaimed");
  close(s.unverified.shareRaw, 0.5333, 0.0001);
  close(s.pillars.penalty, 15, 1e-9);
});

test("X6 pad attempts: Pad Q 8.4% of Harbor on Policy is a shell -> Harbor 84 yellow, Pad Q 26 red; Pad P 5.3% shell", () => {
  const Q = shell("mgr-pad", 800000, 1500000, 0, "padq");
  const [h, q] = scorePortfolio(model, [withSigner(harbor(), "mgr-pad"), Q], { now: NOW });
  assert.equal(q.status, "scored");
  close(q.unverified.shareRaw, 0.4667, 0.0001);
  assert.equal(h.score, 84);
  assert.equal(h.band, "yellow");
  assert.equal(q.score, 26);
  close(q.raw, 26.33);
  close(q.penaltyDetail.ownAttemptsManagerWide[0].policyShareOfLargest, 0.084, 0.0005);
  const P = shell("mgr-pad", 500000, 1200000, 0, "padp");
  const [, p] = scorePortfolio(model, [withSigner(harbor(), "mgr-pad"), P], { now: NOW });
  close(p.penaltyDetail.ownAttemptsManagerWide[0].policyShareOfLargest, 0.053, 0.0005);
  assert.equal(p.penaltyDetail.ownAttemptsManagerWide[0].managerWide, true);
});

test("X7 re-signed stale tape: freshness 0 and verification_failed, never 100 green", () => {
  const f = harbor();
  for (const l of f.loans) l.servicer_asof = ago(24 * 60);
  Object.assign(f.certificate, { signed_at: ago(12), data_asof: ago(12) });
  f.nav_report_date = ago(12);
  const r = score(f);
  assert.equal(r.pillars.freshness, 0);
  assert.equal(r.status, "verification_failed");
  assert.equal(r.score, null);
});

test("X8 zero-marked unverified loan cannot hide: stays disclaimed, share_raw above 100% kept", () => {
  const par = fund({ loans: [loan({ id: "V", principal: 4000000 }), loan({ id: "U", principal: 5000000, nft: false, nft_id: undefined })], headline_nav: 9000000 });
  const rp = score(par);
  assert.equal(rp.status, "disclaimed");
  close(rp.unverified.shareRaw, 5 / 9, 1e-9);
  const zero = fund({ loans: [loan({ id: "V", principal: 4000000 }), loan({ id: "U", principal: 5000000, nft: false, nft_id: undefined, reported_value: 0 })], headline_nav: 4000000 });
  const rz = score(zero);
  assert.equal(rz.status, "disclaimed");
  assert.equal(rz.zeroMarkedUnverified.count, 1);
  close(rz.unverified.shareRaw, 1.25, 1e-9);
  assert.equal(rz.unverified.shareDisplay, 1);
  const m = meridian();
  m.loans.push({ id: "M-Z", asset: "invoices", principal: 5000000, accrued: 0, repaid: 0, bucket: "current", nft: false, anomaly: false, reported_value: 0, servicer_asof: m.loans[0].servicer_asof });
  assert.equal(score(m).status, "disclaimed");
});

test("X9 known edge, documented: 51% disclaimed, raising only the mark to 50% gives 40 red", () => {
  // Jump: moving the fund's own mark from 24.99 to 25.50 moves the unlisted residual from 26.01 to 25.50,
  // which crosses the 50% line from disclaimed to scored. Not tuned; documented in engine/README.md.
  const mk = (mark) => fund({ loans: [loan({ principal: 25.5, reported_value: mark })], headline_nav: 51 });
  const a = score(mk(24.99));
  assert.equal(a.status, "disclaimed");
  const b = score(mk(25.5));
  assert.equal(b.unverified.shareRaw, 0.5);
  assert.equal(b.status, "scored");
  assert.equal(b.score, 40);
  assert.equal(b.band, "red");
  close(b.raw, 40, 1e-9);
});

test("X10 known edge, documented: one loan vs 100 notes of the same EAD, the single loan gets a wider range and a higher score", () => {
  const one = fund({ loans: [loan({ asset: "invoices", bucket: "dpd_1_30", principal: 1000000 })], headline_nav: 1000000 });
  const many = fund({ loans: Array.from({ length: 100 }, (_, i) => loan({ id: `n${i}`, asset: "invoices", bucket: "dpd_1_30", principal: 10000 })), headline_nav: 1000000 });
  const r1 = score(one);
  const r100 = score(many);
  assert.ok(r1.trueRange > r100.trueRange);
  assert.ok(r1.score > r100.score);
});

test("X11 max-of-sides gap: Harbor marked down to 8,800,000 plus unverified 1,260,000 -> 73 yellow, not 92 green", () => {
  const f = harbor();
  f.loans[0].reported_value = 1100000;
  f.loans.push({ id: "H-UV-01", asset: "invoices", principal: 1260000, accrued: 0, repaid: 0, bucket: "current", nft: false, anomaly: false, reported_value: 1260000, servicer_asof: f.loans[0].servicer_asof });
  f.headline_nav = 10060000;
  const r = score(f);
  assert.equal(Math.round(r.policyNav), 8800000);
  assert.equal(r.listedBook, 10060000);
  assert.equal(Math.round(r.gap.over), 49336);
  assert.equal(Math.round(r.gap.under), 519556);
  assert.equal(r.gap.boundSide, "under");
  close(r.pillars.gap, 18.50);
  close(r.pillars.coverage, 34.99);
  close(r.raw, 72.65);
  assert.equal(r.score, 73);
  assert.equal(r.band, "yellow");
});

// Validation gaps.
test("V1 previously_certified spoof: flagged, derived true wins, status verification_failed", () => {
  const f = harbor();
  for (const l of f.loans) l.servicer_asof = ago(24 * 60);
  Object.assign(f.certificate, { signed_at: ago(12), data_asof: ago(12) });
  f.nav_report_date = ago(12);
  f.previously_certified = false;
  const r = score(f);
  assert.equal(r.spoofFlags.previouslyCertified, true);
  assert.ok(r.flags.includes("previously_certified spoof"));
  assert.equal(r.previouslyCertified, true);
  assert.equal(r.status, "verification_failed");
});

test("V2 manager_id spoof: flagged, certificate signer used, Harbor still takes manager-wide penalty", () => {
  const Q = shell("mgr-pad", 800000, 1500000, 0, "padq");
  Q.manager_id = "mgr-somewhere-else";
  const [h, q] = scorePortfolio(model, [withSigner(harbor(), "mgr-pad"), Q], { now: NOW });
  assert.equal(q.spoofFlags.managerId, true);
  assert.equal(q.managerId, "mgr-pad");
  assert.equal(h.penaltyDetail.managerWide, true);
  assert.equal(h.score, 84);
});

test("V3 liabilities invalid -> invalid_fund_fields; 0 unattested scored and labeled self-reported", () => {
  for (const v of [-1000000, NaN]) {
    const f = harbor();
    f.liabilities = v;
    const r = score(f);
    assert.equal(r.status, "invalid_fund_fields");
    assert.deepEqual(r.statusReasons, ["liabilities invalid"]);
    assert.equal(r.score, null);
  }
  const ok = score(harbor());
  assert.equal(ok.status, "scored");
  assert.equal(ok.liabilities.label, "liabilities self-reported");
});

test("V4 (replaced by 6b, owner 6 Nov) cash statement as-of over 168 h: cash unattested for LIH and 50% test, no freshness penalty; 12 h matches X2", () => {
  const f = harbor();
  Object.assign(f, { cash: 1000000, cash_attested: true, cash_asof: ago(200), headline_nav: 10500000 });
  const r = score(f);
  assert.equal(r.cash.attested, false);
  assert.equal(r.cash.attestationRevokedForAge, true);
  assert.equal(r.lih, 10500000);
  close(r.unverified.unattestedCash, 1000000, 1e-9);
  assert.ok(r.pillars.freshness > 0);
  assert.ok(r.flags.includes("cash attestation expired"));
  // 200 h is under the 30-day line, so a previously certified fund stays scored here (see README open question).
  assert.equal(r.status, "scored");
  const g = harbor();
  Object.assign(g, { cash: 1000000, cash_attested: true, cash_asof: ago(12), headline_nav: 10500000 });
  assert.equal(score(g).score, 99);
});

test("V5 fund-level NaN: NaN headline on a certified fund fails verification; bad cash or liabilities invalid", () => {
  const f = harbor();
  f.headline_nav = NaN;
  const r = score(f);
  assert.equal(r.status, "verification_failed");
  assertNoNaN(r);
  const c = harbor();
  c.cash = "1e6";
  assert.equal(score(c).status, "invalid_fund_fields");
  const l = harbor();
  l.liabilities = null;
  assert.equal(score(l).status, "invalid_fund_fields");
  assertNoNaN(score(c));
});

test("V6 zero denominators: coverage 0 and share 0; empty book with unverified value -> +Infinity, disclaimed", () => {
  const r = score(fund({ loans: [loan({ reported_value: 0 })], headline_nav: 0 }));
  assert.ok(r.trueVal > 0);
  assert.equal(r.pillars.coverage, 0);
  assert.equal(r.unverified.shareRaw, 0);
  assert.ok(Number.isFinite(r.score));
  const s = score(fund({ loans: [loan({ repaid: undefined, principal: 1000 })], headline_nav: 0 }));
  assert.equal(s.listedBook, 0);
  assert.equal(s.unverified.shareRaw, Infinity);
  assert.equal(s.unverified.shareDisplay, 1);
  assert.equal(s.status, "disclaimed");
});

test("V7 duplicate NFT: second copy excluded, counted once in NAVs, at max(mark, EAD) in the 50% test", () => {
  const r = score(fund({ loans: [loan({ id: "A", nft_id: "nft-x" }), loan({ id: "B", nft_id: "nft-x" })], headline_nav: 2000000 }));
  assert.deepEqual(r.exclusions.map((e) => [e.id, e.reason]), [["B", "duplicate nft"]]);
  assert.equal(r.policyNav, 1000000);
  close(r.trueVal, 1000000 * (1 - 0.02 * 0.31), 1e-6);
  assert.equal(r.unverified.loans, 1000000);
  const m = score(fund({ loans: [loan({ id: "A", nft_id: undefined })], headline_nav: 1000000 }));
  assert.equal(m.exclusions[0].reason, "incomplete data");
});

test("two rows with the same loan_hash and different nft_ids: second excluded as duplicate loan, counted once in NAV", () => {
  const hash = "0xabc1111111111111111111111111111111111111111111111111111111111111";
  const f = fund({
    fund_id: "fund-loan-dedupe",
    loans: [
      loan({ id: "A", nft_id: "nft-a", loan_hash: hash, principal: 100000, accrued: 0, repaid: 0 }),
      loan({ id: "B", nft_id: "nft-b", loan_hash: hash, principal: 100000, accrued: 0, repaid: 0 }),
    ],
    headline_nav: 200000,
  });
  const teeStore = {
    [hash]: {
      fund_id: "fund-loan-dedupe",
      pledged_at_ms: NOW_MS - 30 * 24 * 3600 * 1000,
      latest: { verdict: "pass", anomalies: [], at_ms: NOW_MS - 29 * 24 * 3600 * 1000 },
    },
  };
  const r = score(f, { teeStore });
  assert.equal(r.exclusions.filter((e) => e.id === "A").length, 0);
  assert.deepEqual(r.exclusions.map((e) => [e.id, e.reason]), [["B", "duplicate loan"]]);
  assert.equal(r.unverified.loans, 100000);
  assert.equal(r.policyNav, 100000);
});

test("V8 future-dated as-of: clamped to age 0, cannot refresh a stale book", () => {
  const f = harbor();
  f.loans[0].servicer_asof = new Date(NOW_MS + 10 * 365 * 24 * 3600 * 1000).toISOString();
  const r = score(f);
  close(r.dataAgeHours, 30, 1e-9);
  close(r.pillars.freshness, score(harbor()).pillars.freshness, 1e-12);
  const g = fund({ loans: [loan({ servicer_asof: new Date(NOW_MS + 1e9).toISOString() }), loan({ servicer_asof: ago(500) })], headline_nav: 2000000 });
  assert.equal(score(g).pillars.freshness, 0);
});

test("thresholds are TrueNav's own policy constants", () => {
  assert.equal(THRESHOLDS.staleDays, 30);
  assert.equal(THRESHOLDS.disclaimShare, 0.5);
  assert.equal(THRESHOLDS.shellShare, 0.1);
});
