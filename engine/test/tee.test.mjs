// TEE underwriter verdicts in the score (owner decisions 6 Nov 2026): the latest stored verdict counts;
// a flag makes the loan unverified ("TEE flag: <codes>"); no verdict is pending for 7 days after the on-chain
// pledge time, then unverified ("TEE check overdue"); no store at all leaves the score unchanged and flags
// "TEE verdicts not checked".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../src/score.mjs";
import { harbor, model, NOW, STORE } from "./holes.scenarios.mjs";

const loans = JSON.parse(readFileSync(new URL("../../tee/loans.json", import.meta.url), "utf8")).loans.filter((l) => !l.tampered);
const NOW_MS = Date.parse(NOW);
const DAY = 86400000;
const r2 = (x) => Math.round(x * 100) / 100;
const fx = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));

/** Fixture funds with each pledged loan's loan_hash from tee/loans.json. */
function funds() {
  const fs = JSON.parse(JSON.stringify(fx.funds));
  for (const f of fs) for (const l of f.loans) {
    const m = loans.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
    if (m) l.loan_hash = m.loan_hash;
  }
  return fs;
}
const allPass = (pledgedAgoDays = 30) =>
  Object.fromEntries(loans.map((l) => [l.loan_hash, { fund_id: l.fund_id, pledged_at_ms: NOW_MS - pledgedAgoDays * DAY, latest: { verdict: "pass", anomalies: [], at_ms: NOW_MS - DAY } }]));
const run = (teeStore, fs = funds()) => E.scorePortfolio(model, fs, { now: NOW, certStore: STORE, ...(teeStore !== undefined ? { teeStore } : {}) });
const by = (rs, id) => rs.find((r) => r.fundId === id);

test("all demo loans pass: pins unchanged (Harbor 99.17 green, Meridian 42.84 red)", () => {
  const rs = run(allPass());
  assert.equal(r2(by(rs, "harbor-credit-fund").raw), 99.17);
  assert.equal(by(rs, "harbor-credit-fund").band, "green");
  assert.equal(r2(by(rs, "meridian-yield-fund").raw), 42.84);
  assert.equal(by(rs, "harbor-credit-fund").tee.pass, 11);
  assert.ok(!by(rs, "harbor-credit-fund").flags.includes("TEE verdicts not checked"));
});

test("no TEE store: score unchanged, flagged as not checked", () => {
  const rs = run(undefined);
  assert.equal(r2(by(rs, "harbor-credit-fund").raw), 99.17);
  assert.ok(by(rs, "harbor-credit-fund").flags.includes("TEE verdicts not checked"));
  assert.equal(by(rs, "harbor-credit-fund").tee.checked, false);
});

test("a TEE flag makes the loan unverified and the score drops", () => {
  const store = allPass();
  const h1 = loans.find((l) => l.loan_id === "H-RE-01").loan_hash;
  store[h1] = { ...store[h1], latest: { verdict: "flag", anomalies: ["amount_mismatch"], at_ms: NOW_MS } };
  const h = by(run(store), "harbor-credit-fund");
  assert.ok(h.raw < 99.17, `raw ${h.raw}`);
  assert.equal(h.tee.flag, 1);
  assert.ok(h.unverified.reasons.some((x) => x.id === "H-RE-01" && x.reason === "TEE flag: amount_mismatch"));
});

test("latest verdict counts: a pass after a flag restores the loan", () => {
  const store = allPass(); // latest is what the chain returns as get_latest_verdict
  assert.equal(r2(by(run(store), "harbor-credit-fund").raw), 99.17);
});

test("no verdict within 7 days of pledging is pending and changes nothing", () => {
  const store = allPass();
  const h2 = loans.find((l) => l.loan_id === "H-RE-02").loan_hash;
  store[h2] = { pledged_at_ms: NOW_MS - 6 * DAY, latest: null };
  const h = by(run(store), "harbor-credit-fund");
  assert.equal(r2(h.raw), 99.17);
  assert.equal(h.tee.pending, 1);
});

test("no verdict after 7 days is overdue and unverified", () => {
  const store = allPass();
  const h2 = loans.find((l) => l.loan_id === "H-RE-02").loan_hash;
  store[h2] = { pledged_at_ms: NOW_MS - 8 * DAY, latest: null };
  const h = by(run(store), "harbor-credit-fund");
  assert.ok(h.raw < 99.17);
  assert.equal(h.tee.overdue, 1);
  assert.ok(h.unverified.reasons.some((x) => x.id === "H-RE-02" && x.reason === "TEE check overdue"));
});

test("with chain data, a claimed loan with no chain entry is not pledged on chain and unverified (6a over R25 detail, owner 6 Nov)", () => {
  const store = allPass();
  const h3 = loans.find((l) => l.loan_id === "H-RE-03").loan_hash;
  delete store[h3];
  const h = by(run(store), "harbor-credit-fund");
  assert.ok(h.raw < 99.17);
  assert.ok(h.unverified.reasons.some((x) => x.id === "H-RE-03" && x.reason === "not pledged on chain"));
});

test("malformed TEE store is ignored like no store", () => {
  for (const bad of [[], "x", 5, { a: 1 }]) {
    const h = by(run(bad), "harbor-credit-fund");
    assert.equal(r2(h.raw), 99.17);
    assert.ok(h.flags.includes("TEE verdicts not checked"));
  }
});

test("the hostile bucket-style keys cannot reach prototype entries", () => {
  const store = allPass();
  const fs = funds();
  fs[0].loans[0].loan_hash = "__proto__";
  const h = by(run(store, fs), "harbor-credit-fund");
  assert.equal(h.tee.notChecked, 1);
});

// N-02: a verdict past its expiry is not a current pass. The clock is opts.verdictNow (the chain read time).
test("a verdict 1 second past its expiry counts as expired; 1 second before counts as current", () => {
  const READ_MS = NOW_MS + 3 * DAY;
  const withExpiry = (expiresAt) => {
    const s = allPass();
    for (const e of Object.values(s)) e.latest.expires_at_ms = expiresAt;
    return s;
  };
  const at = (store) => E.scorePortfolio(model, funds(), { now: NOW, certStore: STORE, teeStore: store, verdictNow: READ_MS });

  const past = by(at(withExpiry(READ_MS - 1000)), "harbor-credit-fund");
  assert.equal(past.tee.expired, 11);
  assert.equal(past.tee.pass, 0);
  assert.ok(past.unverified.reasons.some((x) => x.reason === "TEE verdict expired"));
  assert.ok(past.raw < 99.17);

  const current = by(at(withExpiry(READ_MS + 1000)), "harbor-credit-fund");
  assert.equal(current.tee.expired, 0);
  assert.equal(current.tee.pass, 11);
  assert.equal(r2(current.raw), 99.17);
  assert.equal(current.band, "green");

  // equal to the clock is still current; a flag past expiry is expired too, not a flag
  assert.equal(by(at(withExpiry(READ_MS)), "harbor-credit-fund").tee.pass, 11);
  const flagged = withExpiry(READ_MS - 1000);
  for (const e of Object.values(flagged)) { e.latest.verdict = "flag"; e.latest.anomalies = ["amount_mismatch"]; }
  const fl = by(at(flagged), "harbor-credit-fund");
  assert.equal(fl.tee.flag, 0); assert.equal(fl.tee.expired, 11);
});

// Boundary, same rule as the contract (expires_at_ms >= now is current) and tee/expiry.mjs.
test("expiry equal to the verdict clock counts as current; clock = expiry + 1 ms counts as expired", () => {
  const READ_MS = NOW_MS + 3 * DAY;
  const at = (expiresAt) => {
    const s = allPass();
    for (const e of Object.values(s)) e.latest.expires_at_ms = expiresAt;
    return by(E.scorePortfolio(model, funds(), { now: NOW, certStore: STORE, teeStore: s, verdictNow: READ_MS }), "harbor-credit-fund");
  };
  const eq = at(READ_MS);
  assert.equal(eq.tee.pass, 11); assert.equal(eq.tee.expired, 0); assert.equal(r2(eq.raw), 99.17);
  const plus1 = at(READ_MS - 1);
  assert.equal(plus1.tee.pass, 0); assert.equal(plus1.tee.expired, 11);
  assert.ok(plus1.unverified.reasons.some((x) => x.reason === "TEE verdict expired"));
});

test("without verdictNow, expiry is judged at the valuation time (fixed replays stay deterministic)", () => {
  const s = allPass();
  for (const e of Object.values(s)) e.latest.expires_at_ms = NOW_MS + 1000;
  assert.equal(by(run(s), "harbor-credit-fund").tee.pass, 11);
  for (const e of Object.values(s)) e.latest.expires_at_ms = NOW_MS - 1000;
  assert.equal(by(run(s), "harbor-credit-fund").tee.expired, 11);
});
