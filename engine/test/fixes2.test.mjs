// Tests for the fix block on top of 84de15b (owner decisions of 5 Nov 2026 20:10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreFund, scorePortfolio } from "../src/score.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
const model = { pd: fixtures.pd, lgd: fixtures.lgd };
const NOW = fixtures.valuation_time;
const NOW_MS = Date.parse(NOW);
const STORE = fixtures.cert_store;
const ago = (h) => new Date(NOW_MS - h * 3600 * 1000).toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const harbor = () => clone(fixtures.funds.find((f) => f.fund_id === "harbor-credit-fund"));
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
function fund(id, signer, loans, headline, over = {}) {
  return {
    fund_id: id, name: id, headline_nav: headline, cash: 0, liabilities: 0, nav_report_date: ago(12),
    certificate: { signed_at: ago(12), data_asof: ago(12), signer, history: [{ fund_id: id, signed_at: ago(24 * 8) }] },
    policy_markdown: {}, blocked_attempts: [], loans, ...over,
  };
}
const D = () => fund("D", "mgr-d", [loan("D-1")], 2500000, { blocked_attempts: [{ action_id: "x", age_days: 5 }] });
const HX = () => {
  const h = signed(harbor(), "mgr-d");
  h.blocked_attempts = [{ action_id: "x", age_days: 3000 }];
  return h;
};
const byId = (rs, id) => rs.find((r) => r.fundId === id);

// Fix 1: one action_id listed by several funds.
for (const order of ["HX first", "D first"]) {
  test(`fix 1: Harbor listing D's attempt cannot launder it (${order}): 85.80, 86 yellow, flagged`, () => {
    const funds = order === "HX first" ? [HX(), D()] : [D(), HX()];
    const rs = portfolio(funds);
    const h = byId(rs, "harbor-credit-fund");
    close(h.raw, 85.8);
    close(h.pillars.penalty, 13.36);
    assert.equal(h.score, 86);
    assert.equal(h.band, "yellow");
    assert.ok(h.flags.includes("action_id listed by several funds"));
    assert.ok(byId(rs, "D").flags.includes("action_id listed by several funds"));
    assert.equal(h.managerWarning, true);
  });

  test(`fix 1: a non-listing Harbor beside listers F and D (${order}): Harbor 85.80 shell reason, F 86.64 flagged`, () => {
    const F = fund("Fbig", "mgr-d", [loan("F-1", { principal: 5000000 })], 5000000, { blocked_attempts: [{ action_id: "x", age_days: 3000 }] });
    const funds = order === "HX first" ? [signed(harbor(), "mgr-d"), F, D()] : [signed(harbor(), "mgr-d"), D(), F];
    const rs = portfolio(funds);
    const h = byId(rs, "harbor-credit-fund");
    const f = byId(rs, "Fbig");
    close(h.raw, 85.8);
    assert.ok(h.penaltyDetail.managerWideReasons.includes("shell: disclaimed"));
    close(f.raw, 86.64);
    assert.ok(f.flags.includes("action_id listed by several funds"));
  });

  test(`fix 1: a non-shell D2 is judged on its own verifier record when Harbor lists x (${order})`, () => {
    const D2 = () => fund("D", "mgr-d", [loan("D-1", { principal: 2000000 })], 2000000, { blocked_attempts: [{ action_id: "x", age_days: 5 }] });
    const [plain] = portfolio([signed(harbor(), "mgr-d"), D2()]);
    close(plain.raw, 99.17);
    const attemptLog = { D: { x: { attempting_status: "disclaimed", manager_id: "mgr-d" } } };
    const funds = order === "HX first" ? [HX(), D2()] : [D2(), HX()];
    const h = byId(portfolio(funds, { attemptLog }), "harbor-credit-fund");
    close(h.raw, 85.8);
    const own = h.penaltyDetail.ownAttemptsManagerWide.find((a) => a.action_id === "x");
    assert.equal(own.managerWide, true);
  });
}

// Fix 2: no certificate, records naming several managers.
for (const keyOrder of ["u1 first", "u2 first"]) {
  test(`fix 2: U records name two managers (${keyOrder}): each attempt goes to its own manager`, () => {
    const U = fund("U", "unused", [loan("U-1")], 1000000, { blocked_attempts: [{ action_id: "u1", age_days: 5 }, { action_id: "u2", age_days: 10 }] });
    delete U.certificate;
    const r1 = { attempting_status: "not_rated", manager_id: "mgr-b" };
    const r2 = { attempting_status: "not_rated", manager_id: "mgr-a" };
    const attemptLog = { U: keyOrder === "u1 first" ? { u1: r1, u2: r2 } : { u2: r2, u1: r1 } };
    const rs = portfolio([signed(harbor(), "mgr-a"), U], { attemptLog });
    const h = byId(rs, "harbor-credit-fund");
    const u = byId(rs, "U");
    close(h.raw, 87.26);
    assert.equal(h.score, 87);
    assert.equal(h.band, "yellow");
    assert.deepEqual(h.penaltyDetail.siblingAttempts.map((a) => a.action_id), ["u2"]);
    assert.ok(u.flags.includes("conflicting manager_id in attempt log"));
    assert.equal(u.managerId, null);
    assert.deepEqual(u.managerIds, ["mgr-a", "mgr-b"]);
  });
}

test("fix 2: with several named managers, an attempt whose record lacks manager_id is not attributable", () => {
  const U = fund("U", "unused", [loan("U-1")], 1000000, { blocked_attempts: [{ action_id: "u1", age_days: 5 }, { action_id: "u2", age_days: 10 }, { action_id: "u3", age_days: 1 }] });
  delete U.certificate;
  const attemptLog = { U: { u1: { manager_id: "mgr-b" }, u2: { manager_id: "mgr-a" }, u3: { attempting_status: "not_rated" } } };
  const [h, u] = portfolio([signed(harbor(), "mgr-a"), U], { attemptLog });
  assert.ok(u.flags.includes("attempts not attributable to a manager"));
  assert.deepEqual(h.penaltyDetail.siblingAttempts.map((a) => a.action_id), ["u2"]);
});

// Fix 3: real cert store check.
for (const bad of [true, "x", [], 5, { "harbor-credit-fund": null }, { "harbor-credit-fund": "s" }]) {
  test(`fix 3: cert store ${JSON.stringify(bad)} is ignored and flagged; payload history still applies`, () => {
    const r = score(harbor(), { certStore: bad });
    assert.ok(r.flags.includes("no cert store: previously_certified not verifiable"));
    close(r.raw, 99.17);
  });
}
for (const [name, good] of [["{}", {}], ["the fixture store", STORE]]) {
  test(`fix 3: cert store ${name} is valid: no flag`, () => {
    assert.ok(!score(harbor(), { certStore: good }).flags.includes("no cert store: previously_certified not verifiable"));
  });
}

// Fix 4: invented liability or overdraft explains away a headline below book (TRUST_MODEL.md).
test("fix 4: Harbor at 8,500,000 is 65.25 yellow; cash -1,000,000 or liabilities 1,000,000 both give 99.17 green", () => {
  const low = harbor();
  low.headline_nav = 8500000;
  const r = score(low);
  close(r.raw, 65.25);
  assert.equal(r.band, "yellow");
  assert.ok(r.flags.includes("headline below book"));

  const od = harbor();
  Object.assign(od, { headline_nav: 8500000, cash: -1000000 });
  const ro = score(od);
  close(ro.raw, 99.17);
  assert.equal(ro.band, "green");
  assert.ok(ro.flags.includes("negative cash treated as liability"));
  assert.ok(!ro.flags.includes("headline below book"));

  const li = harbor();
  Object.assign(li, { headline_nav: 8500000, liabilities: 1000000 });
  const rl = score(li);
  close(rl.raw, 99.17);
  assert.equal(rl.band, "green");
});
