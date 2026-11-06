// Tests for the fix block on top of cb688fc. One test per bullet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreFund, scorePortfolio, STATUS_RANK } from "../src/score.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
const model = { pd: fixtures.pd, lgd: fixtures.lgd };
const NOW = fixtures.valuation_time;
const NOW_MS = Date.parse(NOW);
const STORE = fixtures.cert_store;
const ago = (h) => new Date(NOW_MS - h * 3600 * 1000).toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const harbor = () => clone(fixtures.funds.find((f) => f.fund_id === "harbor-credit-fund"));
const meridian = () => clone(fixtures.funds.find((f) => f.fund_id === "meridian-yield-fund"));
const score = (f, opts = {}) => scoreFund(model, f, { now: NOW, certStore: STORE, ...opts });
const portfolio = (funds, opts = {}) => scorePortfolio(model, funds, { now: NOW, certStore: STORE, ...opts });
const close = (actual, expected, eps = 0.005) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const signed = (f, signer) => {
  f.certificate.signer = signer;
  delete f.certificate.manager_id;
  return f;
};
const loan = (id, over = {}) => ({
  id, asset: "real_estate", principal: 1000000, accrued: 0, repaid: 0, bucket: "current",
  nft: true, nft_id: `nft-${id}`, anomaly: false, servicer_asof: ago(12), ...over,
});
const unverified = (id, over = {}) => loan(id, { nft: false, nft_id: undefined, ...over });
function fund(id, signer, loans, headline, over = {}) {
  return {
    fund_id: id, name: id, headline_nav: headline, cash: 0, liabilities: 0, nav_report_date: ago(12),
    certificate: { signed_at: ago(12), data_asof: ago(12), signer, history: [{ fund_id: id, signed_at: ago(24 * 8) }] },
    policy_markdown: {}, blocked_attempts: [], loans, ...over,
  };
}
const staleHarbor = () => {
  const h = harbor();
  for (const l of h.loans) l.servicer_asof = ago(24 * 60);
  return h;
};

// Fix 1: unknown exposure must not escape the 50% test.
for (const repaid of [null, NaN, "0"]) {
  test(`fix 1: unverified 5M line marked 0 with repaid ${String(repaid)} is counted, fund disclaimed`, () => {
    const f = fund("f1", "mgr-f1", [loan("V", { principal: 4000000 }), unverified("U", { principal: 5000000, reported_value: 0, repaid })], 4000000);
    const r = score(f);
    assert.equal(r.status, "disclaimed");
    assert.ok(r.unverified.shareRaw > 0.5);
  });
}

test("fix 1: unverified line with string principal is unknown exposure, fund disclaimed", () => {
  const f = fund("f1b", "mgr-f1", [loan("V", { principal: 4000000 }), unverified("U", { principal: "5000000", reported_value: 0 })], 4000000);
  const r = score(f);
  assert.equal(r.status, "disclaimed");
  assert.ok(r.statusReasons.includes("unverified line with unknown exposure"));
});

test("fix 1: Harbor plus a 20M unverified loan marked 0 with repaid null is disclaimed", () => {
  const h = harbor();
  h.loans.push(unverified("H-X", { principal: 20000000, reported_value: 0, repaid: null, servicer_asof: h.loans[0].servicer_asof }));
  assert.equal(score(h).status, "disclaimed");
});

// Fix 2: shell size from the verifier record only.
const fundQ = (principal = 800000, headline = 1500000, snapshot) =>
  fund("Q", "mgr-q", [loan("Q-1", { principal })], headline, {
    blocked_attempts: [{ action_id: "aQ", age_days: 0, ...(snapshot ? { snapshot } : {}) }],
  });

test("fix 2: Q with no snapshot is a shell: Harbor 84 yellow (raw 84.17)", () => {
  const [h] = portfolio([signed(harbor(), "mgr-q"), fundQ()]);
  assert.equal(h.score, 84);
  assert.equal(h.band, "yellow");
  close(h.raw, 84.17);
});

test("fix 2: a forged payload snapshot is ignored: Harbor 84 yellow", () => {
  const snap = { attempting_status: "scored", attempting_policy_nav: 9e9, attempting_open_loans: 5 };
  const [h] = portfolio([signed(harbor(), "mgr-q"), fundQ(800000, 1500000, snap)]);
  assert.equal(h.score, 84);
});

test("fix 2: Q grown to 2.8M is judged on the verifier record at the attempt: Harbor 84 yellow", () => {
  const attemptLog = { Q: { aQ: { attempting_status: "scored", attempting_policy_nav: 800000, largest_policy_nav: 9500000, attempting_open_loans: 1 } } };
  const [h, q] = portfolio([signed(harbor(), "mgr-q"), fundQ(2800000, 2800000)], { attemptLog });
  assert.equal(h.score, 84);
  assert.equal(q.penaltyDetail.ownAttemptsManagerWide[0].sizeSource, "verifier record");
});

test("fix 2: known residual: Q grown to 950k with no record escapes: Harbor 99 green", () => {
  const [h] = portfolio([signed(harbor(), "mgr-q"), fundQ(950000, 1500000)]);
  assert.equal(h.score, 99);
  assert.equal(h.band, "green");
});

// Fix 3: invalid_fund_fields is a shell status, rank 0.
const fundD = (over = {}) => fund("D", "mgr-d", [loan("D-1")], 2500000, { blocked_attempts: [{ action_id: "aD", age_days: 0 }], ...over });

test("fix 3: disclaimed D attempts: Harbor 84 yellow", () => {
  const [h, d] = portfolio([signed(harbor(), "mgr-d"), fundD()]);
  assert.equal(d.status, "disclaimed");
  assert.equal(h.score, 84);
});

test("fix 3: D with liabilities -1 is invalid_fund_fields and still a shell: Harbor 84 yellow", () => {
  const [h, d] = portfolio([signed(harbor(), "mgr-d"), fundD({ liabilities: -1 })]);
  assert.equal(d.status, "invalid_fund_fields");
  assert.equal(h.score, 84);
});

test("fix 3: D with cash 'x' is invalid_fund_fields and still a shell: Harbor 84 yellow", () => {
  const [h, d] = portfolio([signed(harbor(), "mgr-d"), fundD({ cash: "x" })]);
  assert.equal(d.status, "invalid_fund_fields");
  assert.equal(h.score, 84);
});

test("fix 3: stale Harbor with cash 'x' is invalid_fund_fields with statusRank 0", () => {
  const h = staleHarbor();
  h.cash = "x";
  const r = score(h);
  assert.equal(r.status, "invalid_fund_fields");
  assert.equal(r.statusRank, 0);
  assert.equal(STATUS_RANK.invalid_fund_fields, 0);
});

// Fix 4: a fund with no certificate can still be a shell.
const fundU = () => {
  const u = fund("U", "unused", [loan("U-1", { principal: 700000 })], 1500000, { blocked_attempts: [{ action_id: "aU", age_days: 0 }] });
  delete u.certificate;
  return u;
};

test("fix 4: uncertified U is tied to its manager by the attempt log: Harbor 84 yellow", () => {
  const [h, u] = portfolio([signed(harbor(), "mgr-u"), fundU()], { attemptLog: { U: { aU: { manager_id: "mgr-u" } } } });
  assert.equal(u.managerId, "mgr-u");
  assert.equal(h.score, 84);
});

test("fix 4: uncertified U with no log is flagged and cannot be tied: Harbor 99 green", () => {
  const [h, u] = portfolio([signed(harbor(), "mgr-u"), fundU()]);
  assert.equal(h.score, 99);
  assert.equal(h.band, "green");
  assert.ok(u.flags.includes("attempts not attributable to a manager"));
});

// Fix 5: floor bind only on scored funds with a penalty.
test("fix 5: an empty no-data fund does not floor-bind: Harbor 99 green beside Meridian", () => {
  const E = { fund_id: "E", headline_nav: 0, loans: [], certificate: { signer: "mgr-e", signed_at: ago(12) } };
  const [h, , e] = portfolio([signed(harbor(), "mgr-e"), signed(meridian(), "mgr-e"), E]);
  assert.equal(e.floorBind, false);
  assert.equal(h.score, 99);
  assert.equal(h.band, "green");
});

test("fix 5: a scored fund with six fresh attempts and stale data floor-binds: raw -10, penalty 90", () => {
  const B = fund("B6", "mgr-e", [loan("B6-1", { servicer_asof: ago(500) })], 1000000, {
    nav_report_date: ago(500),
    blocked_attempts: [0, 1, 2, 3, 4, 5].map((k) => ({ action_id: `b6-${k}`, age_days: 0 })),
  });
  Object.assign(B.certificate, { signed_at: ago(500), data_asof: ago(500) });
  const r = score(B);
  assert.equal(r.status, "scored");
  close(r.raw, -10, 1e-9);
  close(r.pillars.penalty, 90, 1e-9);
  assert.equal(r.floorBind, true);
  assert.equal(r.score, 0);
});

// Fix 6: negative cash counts as a liability.
test("fix 6: Meridian with cash -400,000 and headline 3,335,000: 43 red, LIH 3,735,000, flag", () => {
  const m = meridian();
  Object.assign(m, { cash: -400000, headline_nav: 3335000 });
  const r = score(m);
  assert.equal(r.score, 43);
  assert.equal(r.band, "red");
  close(r.raw, 42.84);
  assert.equal(r.lih, 3735000);
  assert.ok(r.flags.includes("negative cash treated as liability"));
});

test("fix 6: same with cash attested and a fresh cash_asof: 43 red", () => {
  const m = meridian();
  Object.assign(m, { cash: -400000, headline_nav: 3335000, cash_attested: true, cash_asof: ago(12) });
  const r = score(m);
  assert.equal(r.score, 43);
  close(r.raw, 42.84);
});

test("fix 6: Harbor beside the negative-cash Meridian under one signer: 99 green (raw 99.17)", () => {
  const m = signed(meridian(), "mgr-cash");
  Object.assign(m, { cash: -400000, headline_nav: 3335000 });
  const [h] = portfolio([signed(harbor(), "mgr-cash"), m]);
  assert.equal(h.score, 99);
  assert.equal(h.band, "green");
  close(h.raw, 99.17);
});

// Fix 7: previously_certified needs the verifier store; stale certified data fails.
test("fix 7: stale Harbor with empty history and no store fails verification", () => {
  const h = staleHarbor();
  h.certificate.history = [];
  const r = scoreFund(model, h, { now: NOW });
  assert.equal(r.status, "verification_failed");
  assert.ok(r.flags.includes("no cert store: previously_certified not verifiable"));
});

test("fix 7: stale Harbor with fund_id renamed and the store under the old id fails verification", () => {
  const h = staleHarbor();
  h.fund_id = "harbor-renamed";
  h.certificate.history = [];
  assert.equal(score(h).status, "verification_failed");
});

test("fix 7: stale Harbor with a backdated signed_at and empty history fails verification", () => {
  const h = staleHarbor();
  h.certificate.signed_at = "2000-01-01";
  h.certificate.history = [];
  assert.equal(score(h).status, "verification_failed");
});

test("fix 7: fresh Harbor, backdated signed_at, empty history, headline removed: store keeps it certified, fails", () => {
  const h = harbor();
  h.certificate.signed_at = "2000-01-01";
  h.certificate.history = [];
  delete h.headline_nav;
  const r = score(h);
  assert.equal(r.previouslyCertified, true);
  assert.equal(r.status, "verification_failed");
});

test("fix 7: never certified fund with a certificate over 40-day-old data fails verification (R14 change)", () => {
  const f = fund("N", "mgr-n", [loan("N-1", { principal: 3000000, servicer_asof: ago(24 * 40) })], 3000000, { nav_report_date: ago(24 * 40) });
  f.certificate.history = [];
  const r = score(f, { certStore: {} });
  assert.equal(r.previouslyCertified, false);
  assert.equal(r.status, "verification_failed");
});

test("fix 7: Harbor with data 20 days old and empty history stays 80 yellow", () => {
  const h = harbor();
  const t = ago(24 * 20);
  for (const l of h.loans) l.servicer_asof = t;
  Object.assign(h, { nav_report_date: t });
  Object.assign(h.certificate, { data_asof: t, signed_at: t, history: [] });
  const r = scoreFund(model, h, { now: NOW });
  assert.equal(r.status, "scored");
  assert.equal(r.score, 80);
  assert.equal(r.band, "yellow");
});

test("fix 7: no certificate, no store, stale data stays not_rated", () => {
  const h = staleHarbor();
  delete h.certificate;
  assert.equal(scoreFund(model, h, { now: NOW }).status, "not_rated");
});

// Low items.
test("low: a shared action_id is counted once across the manager: C1 100 green, penalty 0, warning", () => {
  const A1 = fund("A1", "mgr-z", [loan("A1-1", { principal: 5000000 })], 5000000, { blocked_attempts: [{ action_id: "same", age_days: 5 }] });
  const B1 = fund("B1", "mgr-z", [loan("B1-1", { principal: 5000000 })], 5000000, { blocked_attempts: [{ action_id: "same", age_days: 5 }] });
  const C1 = fund("C1", "mgr-z", [loan("C1-1", { principal: 5000000 })], 5000000);
  const [, , c] = portfolio([A1, B1, C1]);
  assert.equal(c.score, 100);
  assert.equal(c.band, "green");
  assert.equal(c.pillars.penalty, 0);
  assert.equal(c.managerWarning, true);
});

test("low: a missing as-of gives dataAgeHours null and fails verification", () => {
  const h = harbor();
  delete h.nav_report_date;
  const r = score(h);
  assert.equal(r.dataAgeHours, null);
  assert.equal(r.status, "verification_failed");
});

test("unchanged: with a cert store Harbor 99 green, Meridian 43 red, Meridian without its attempt 57 red", () => {
  const h = score(harbor());
  assert.equal(h.score, 99);
  close(h.raw, 99.17);
  const m = score(meridian());
  assert.equal(m.score, 43);
  close(m.raw, 42.84);
  const m0 = meridian();
  m0.blocked_attempts = [];
  const r0 = score(m0);
  assert.equal(r0.score, 57);
  close(r0.raw, 57.17);
  for (const r of [h, m, r0]) assert.ok(!r.flags.includes("no cert store: previously_certified not verifiable"));
});
