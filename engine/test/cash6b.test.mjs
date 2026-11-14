// 6b (decided by owner 6 Nov 2026): only a valid ISO date within 168 h (and at most 10 minutes in the future)
// attests cash. Expired, malformed, missing, future and never-claimed are all unattested cash, each with its own
// flag, so none of them beats telling the truth. An expired claimed attestation also sets freshness to 0
// (NAV_SPEC R8, 6 Nov 13:32; codex differential audit D2, 14 Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../src/score.mjs";
import { fund, loan, model, NOW, STORE, ago } from "./holes.scenarios.mjs";

const opts = { now: NOW, certStore: STORE };
const NOW_MS = Date.parse(NOW);
const r2 = (x) => Math.round(x * 100) / 100;
const mk = (over) => fund("C", "mgr-c", [loan("C-1")], 1100000, { cash: 100000, ...over });
const run = (over) => E.scoreFund(model, mk(over), opts);
const at = (ms) => new Date(NOW_MS + ms).toISOString().replace(/\.\d{3}Z$/, "Z");

test("valid attestation within 168 h attests cash: 100 green", () => {
  const r = run({ cash_attested: true, cash_asof: ago(12) });
  assert.equal(r.cash.attestationStatus, "valid");
  assert.equal(r2(r.raw), 100);
});

const unattested = {
  malformed: [{ cash_attested: true, cash_asof: "invalid_string" }, "attestation date invalid"],
  "malformed but Date.parse-able": [{ cash_attested: true, cash_asof: "Nov 9 2026" }, "attestation date invalid"],
  missing: [{ cash_attested: true }, "attestation date invalid"],
  "future past the 10-minute skew": [{ cash_attested: true, cash_asof: at(11 * 60000) }, "attestation date in the future"],
  "never claimed": [{ cash_attested: false }, null],
};

for (const [name, [over, flag]] of Object.entries(unattested)) {
  test(`${name}: unattested cash, no freshness penalty, same score as never claiming (87.86)`, () => {
    const r = run(over);
    assert.equal(r.cash.attested, false);
    assert.equal(r.pillars.freshness, 20);
    assert.equal(r2(r.raw), 87.86);
    if (flag) assert.ok(r.flags.includes(flag), r.flags.join("; "));
  });
}

test("expired: unattested cash and freshness 0 (R8): 67.86 yellow, below never claiming", () => {
  const r = run({ cash_attested: true, cash_asof: ago(200) });
  assert.equal(r.cash.attested, false);
  assert.equal(r.cash.attestationStatus, "expired");
  assert.equal(r.pillars.freshness, 0);
  assert.equal(r2(r.raw), 67.86);
  assert.equal(r.band, "yellow");
  assert.ok(r.flags.includes("cash attestation expired"), r.flags.join("; "));
});

test("future within the 10-minute skew still counts as valid", () => {
  const r = run({ cash_attested: true, cash_asof: at(9 * 60000) });
  assert.equal(r.cash.attestationStatus, "valid");
  assert.equal(r2(r.raw), 100);
});

test("pins unchanged: Harbor 99.17 green, Meridian 42.84 red", () => {
  const fx = JSON.parse(readFileSync(new URL("../../spec/nav/fixtures.json", import.meta.url), "utf8"));
  const rs = E.scorePortfolio({ pd: fx.pd, lgd: fx.lgd }, fx.funds, { now: fx.valuation_time, certStore: fx.cert_store });
  const by = (id) => rs.find((r) => r.fundId === id);
  assert.equal(r2(by("harbor-credit-fund").raw), 99.17);
  assert.equal(by("harbor-credit-fund").band, "green");
  assert.equal(r2(by("meridian-yield-fund").raw), 42.84);
  assert.equal(by("meridian-yield-fund").band, "red");
});
