// 6a (decided by owner 6 Nov 2026): with chain data, a loan counts as verified only for the fund whose on-chain
// pledge holds it; a rival listing the same loan hurts only the rival. Without chain data the old rule is the
// fallback (an nft_id verified in two funds counts in neither) and funds are flagged "ownership not checkable".
// C2: a TEE verdict counts only if stored at or after the current pledge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../src/score.mjs";

const fx = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
const demo = JSON.parse(readFileSync(new URL("../../tee/loans.json", import.meta.url), "utf8")).loans.filter((l) => !l.tampered);
const NOW_MS = Date.parse(fx.valuation_time);
const DAY = 86400000;
const r2 = (x) => Math.round(x * 100) / 100;
const model = { pd: fx.pd, lgd: fx.lgd };

function funds() {
  const fs = JSON.parse(JSON.stringify(fx.funds));
  for (const f of fs) for (const l of f.loans) {
    const m = demo.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
    if (m) l.loan_hash = m.loan_hash;
  }
  return fs;
}
const chain = () => Object.fromEntries(demo.map((l) => [l.loan_hash, { fund_id: l.fund_id, pledged_at_ms: NOW_MS - 30 * DAY, latest: { verdict: "pass", anomalies: [], at_ms: NOW_MS - 29 * DAY } }]));
const run = (fs, teeStore) => E.scorePortfolio(model, fs, { now: fx.valuation_time, certStore: fx.cert_store, ...(teeStore ? { teeStore } : {}) });
const by = (rs, id) => rs.find((r) => r.fundId === id);

/** The copycat: a rival fund with a large real book lists Harbor's H-RE-01 (same nft_id, same loan_hash) as a 1-unit loan. */
function withCopycat() {
  const fs = funds();
  const h = fs[0].loans.find((l) => l.id === "H-RE-01");
  const rival = JSON.parse(JSON.stringify(fs[0]));
  rival.fund_id = "rival-fund";
  rival.certificate = { ...rival.certificate, manager_id: "manager-rival", signer: undefined };
  rival.loans = [{ ...h, id: "R-1", principal: 1, accrued: 0, repaid: 0 }, ...fs[0].loans.filter((l) => l.id !== "H-RE-01").map((l, k) => ({ ...l, id: `R-big-${k}`, nft_id: `nft-rival-${k}`, loan_hash: undefined }))];
  return [...fs, rival];
}

test("pins with full chain data: Harbor 99.17 green, Meridian 42.84 red", () => {
  const rs = run(funds(), chain());
  assert.equal(r2(by(rs, "harbor-credit-fund").raw), 99.17);
  assert.equal(by(rs, "harbor-credit-fund").band, "green");
  assert.equal(r2(by(rs, "meridian-yield-fund").raw), 42.84);
  assert.equal(by(rs, "meridian-yield-fund").band, "red");
});

test("with chain data, a rival listing Harbor's loan hurts only the rival", () => {
  const rs = run(withCopycat(), chain());
  const h = by(rs, "harbor-credit-fund");
  assert.equal(r2(h.raw), 99.17);
  assert.equal(h.band, "green");
  const rival = by(rs, "rival-fund");
  assert.ok(rival.unverified.reasons.some((x) => x.id === "R-1" && x.reason === "pledged by another fund"), JSON.stringify(rival.unverified.reasons));
});

test("the same fixture: offline gives the fallback result, chain data gives the owner rule", () => {
  const off = by(run(withCopycat(), null), "harbor-credit-fund");
  assert.ok(off.raw < 99.17, `offline Harbor ${off.raw}`);
  assert.ok(off.flags.includes("nft_id listed by several funds"));
  assert.ok(off.flags.includes("ownership not checkable (no chain data)"));
  const on = by(run(withCopycat(), chain()), "harbor-credit-fund");
  assert.equal(r2(on.raw), 99.17);
  assert.ok(!on.flags.includes("ownership not checkable (no chain data)"));
});

test("with chain data, an unpledged loan is marked not pledged on chain", () => {
  const st = chain();
  delete st[demo.find((l) => l.loan_id === "M-IN-02").loan_hash];
  const m = by(run(funds(), st), "meridian-yield-fund");
  assert.ok(m.unverified.reasons.some((x) => x.id === "M-IN-02" && x.reason === "not pledged on chain"));
});

test("C2: a verdict stored before the current pledge does not count", () => {
  const st = chain();
  const k = demo.find((l) => l.loan_id === "H-RE-01").loan_hash;
  st[k] = { ...st[k], latest: { verdict: "flag", anomalies: ["amount_mismatch"], at_ms: st[k].pledged_at_ms - 1 } };
  const h = by(run(funds(), st), "harbor-credit-fund");
  assert.equal(h.tee.flag, 0, "the pre-pledge flag is ignored");
  assert.equal(h.tee.overdue, 1); // pledged 30 days ago with no verdict since: overdue under R25
  assert.ok(h.unverified.reasons.some((x) => x.id === "H-RE-01" && x.reason === "TEE check overdue"));
  // A verdict at or after the pledge counts.
  st[k] = { ...st[k], latest: { verdict: "pass", anomalies: [], at_ms: st[k].pledged_at_ms } };
  assert.equal(r2(by(run(funds(), st), "harbor-credit-fund").raw), 99.17);
});
