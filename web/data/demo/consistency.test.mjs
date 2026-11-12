import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scorePortfolio } from "../../../engine/src/score.mjs";
import { buildDemo } from "./generate.mjs";
import { anchorsMatch, dpdInBucket, OUT_OF_SYNC_COPY } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const committed = JSON.parse(readFileSync(join(here, "funds.demo.json"), "utf8"));
const built = buildDemo();

const byId = (data, id) => data.funds.find((f) => f.fund_id === id);
const harbor = byId(built, "harbor-credit-fund");
const meridian = byId(built, "meridian-yield-fund");
const openLoans = (fund) => fund.loans.filter((l) => l.data_room.engine.open);
const loan = (fund, id) => fund.loans.find((l) => l.data_room.loan_id === id);

test("committed funds.demo.json matches a fresh deterministic build", () => {
  assert.deepEqual(committed, built);
});

test("Harbor has 11 open loans, carrying value $9,950,000 and TrueVal $9,665,110", () => {
  assert.equal(harbor.anchors.open_loans, 11);
  assert.equal(openLoans(harbor).length, 11);
  assert.equal(harbor.anchors.carrying_value_cents, "995000000");
  assert.equal(harbor.anchors.certificate.true_val_cents, "966511000");
  assert.equal(harbor.anchors.certificate.score, 99);
  assert.equal(harbor.anchors.certificate.raw_x100, 9917);
  assert.equal(harbor.anchors.certificate.true_range_cents, "34555424");
  assert.equal(harbor.anchors.certificate.headline_cents, "950000000");
  assert.equal(loan(harbor, "H-IN-04").data_room.engine.open, false);
});

test("Meridian excludes M-IN-03 and TrueVal is $3,092,970 from 4 loans", () => {
  const excluded = loan(meridian, "M-IN-03");
  assert.equal(excluded.data_room.engine.verified, false);
  assert.equal(excluded.data_room.engine.reason, "anomaly flag");
  assert.equal(excluded.data_room.recorded.servicer_anomaly_flag, true);
  assert.equal(excluded.verdict, "pass");
  assert.equal(excluded.data_room.checks.line, "documents: pass (enclave). servicer data: anomaly, excluded from TrueVal.");
  const verified = meridian.loans.filter((l) => l.data_room.engine.verified);
  assert.equal(verified.length, 4);
  assert.equal(verified.some((l) => l.data_room.loan_id === "M-IN-03"), false);
  assert.equal(meridian.anchors.certificate.true_val_cents, "309297000");
  assert.equal(meridian.anchors.certificate.true_range_cents, "36143458");
  assert.equal(meridian.anchors.certificate.policy_nav_cents, "343500000");
  assert.equal(meridian.anchors.certificate.headline_cents, "373500000");
  assert.equal(meridian.anchors.certificate.score, 43);
  assert.equal(meridian.anchors.certificate.raw_x100, 4284);
  assert.equal(meridian.anchors.carrying_value_cents, "390000000");
});

test("verified economics match scorePortfolio within 1 cent", () => {
  const fx = JSON.parse(readFileSync(join(root, "spec/nav/fixtures.json"), "utf8"));
  const loans = JSON.parse(readFileSync(join(root, "tee/loans.json"), "utf8")).loans.filter((l) => !l.tampered);
  const funds = JSON.parse(JSON.stringify(fx.funds));
  const teeStore = {};
  for (const f of funds) {
    for (const l of f.loans) {
      const m = loans.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
      if (!m) continue;
      l.loan_hash = m.loan_hash;
      teeStore[m.loan_hash] = { fund_id: f.fund_id, pledged_at_ms: 1, latest: { verdict: "pass", anomalies: [], at_ms: 2 } };
    }
  }
  const scored = scorePortfolio({ pd: fx.pd, lgd: fx.lgd }, funds, { now: fx.valuation_time, certStore: fx.cert_store, teeStore });
  for (const fund of built.funds) {
    const r = scored.find((x) => x.fundId === fund.fund_id);
    const verified = fund.loans.filter((l) => l.data_room.engine.verified);
    const parts = verified.reduce((s, l) => s + Number(l.data_room.engine.true_val_part_cents), 0);
    const marks = verified.reduce((s, l) => s + Number(l.data_room.engine.mark_cents), 0);
    assert.ok(Math.abs(parts - Number(fund.anchors.certificate.true_val_cents)) <= 1);
    assert.ok(Math.abs(marks - Number(fund.anchors.certificate.policy_nav_cents)) <= 1);
    assert.equal(Number(fund.anchors.certificate.true_val_cents), Math.round(r.trueVal * 100));
    assert.equal(Number(fund.anchors.certificate.true_range_cents), Math.round(r.trueRange * 100));
    assert.equal(fund.anchors.certificate.headline_cents, String(Math.round(r.headline * 100)));
  }
});

test("every live tee loan joins and the asset type matches the token list", () => {
  const loans = JSON.parse(readFileSync(join(root, "tee/loans.json"), "utf8")).loans.filter((l) => !l.tampered);
  assert.equal(loans.length, 16);
  for (const row of loans) {
    const fund = byId(built, row.fund_id);
    const hit = fund.loans.find((l) => l.loan_hash === row.loan_hash);
    assert.ok(hit, row.loan_id);
    assert.equal(hit.asset_type, row.asset_type);
    assert.equal(hit.data_room.loan_id, row.loan_id);
    assert.equal(hit.asset_type, row.asset_type === "invoices" ? "invoices" : "real_estate");
  }
  assert.equal(harbor.anchors.loan_hashes.length, 11);
  assert.equal(meridian.anchors.loan_hashes.length, 5);
});

test("invented fields are tagged demo and stay inside the stated bounds", () => {
  for (const fund of built.funds) {
    for (const l of fund.loans) {
      assert.equal(l.data_room.tag, "demo");
      assert.equal(l.data_room.demo.tag, "demo");
      assert.equal(l.data_room.recorded.tag, "recorded");
      assert.equal(l.data_room.engine.tag, "computed");
      const bucket = l.data_room.recorded.bucket;
      const ltv = l.data_room.demo.ltv_bps;
      if (l.asset_type === "real_estate") {
        assert.equal(l.data_room.recorded.coupon_bps, 600);
        assert.match(l.data_room.recorded.lien, /first mortgage/);
        if (bucket === "current" || bucket === "dpd_1_30") assert.ok(ltv >= 5000 && ltv <= 7500, l.data_room.loan_id);
        if (bucket === "dpd_over_90") assert.ok(ltv >= 8000 && ltv <= 11000, l.data_room.loan_id);
        assert.equal(l.data_room.demo.geography.country, "US");
      } else {
        assert.equal(l.data_room.recorded.coupon_bps, null);
        assert.equal(ltv, null);
        const advance = l.data_room.demo.advance_rate_bps;
        if (l.data_room.engine.open) assert.ok(advance >= 8000 && advance <= 9000);
        const discount = l.data_room.demo.discount_bps;
        if (l.data_room.engine.open) assert.ok(discount >= 300 && discount <= 600);
      }
      const dscr = l.data_room.demo.dscr;
      if (bucket === "current") assert.ok(dscr >= 1.1 && dscr <= 1.6);
      else if (l.data_room.engine.open) assert.ok(dscr < 1);
      assert.equal(dpdInBucket(bucket, l.data_room.recorded.dpd), true, l.data_room.loan_id);
    }
  }
});

test("document ids and document text are not stored", () => {
  const raw = JSON.stringify(built);
  assert.equal(raw.includes("document_id"), false);
  assert.equal(raw.includes("TITLE-DEMO"), false);
  assert.equal(raw.includes("INV-DEMO"), false);
  assert.equal(raw.includes("DEMO, NOT A REAL DOCUMENT"), false);
});

test("coupon schedule reconciles to fixture accrued within the stated tolerance", () => {
  for (const fund of built.funds) {
    for (const row of fund.accrued_reconciliation.loans) {
      const l = loan(fund, row.loan_id);
      if (l.asset_type === "real_estate" && l.data_room.recorded.bucket === "current") {
        const principal = Number(l.data_room.recorded.principal_cents) / 100;
        const coupon = principal * 0.06 / 12;
        const accrued = Number(row.fixture_accrued_cents) / 100;
        assert.ok(Math.abs(accrued - coupon) <= 50, row.loan_id);
        assert.equal(row.residual_cents, "0");
      }
    }
  }
  assert.equal(loan(harbor, "H-RE-05") && harbor.accrued_reconciliation.loans.find((r) => r.loan_id === "H-RE-05").residual_cents, "505000");
  assert.equal(harbor.accrued_reconciliation.loans.find((r) => r.loan_id === "H-RE-08").residual_cents, "24000");
  assert.equal(meridian.accrued_reconciliation.loans.find((r) => r.loan_id === "M-RE-02").residual_cents, "44000");
});

test("the four cash-flow funds are tagged demo, not on chain", () => {
  const ids = built.demo_funds.map((f) => f.fund_id).sort();
  assert.deepEqual(ids, ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"]);
  const expect = {
    "DEMO-CREDIT": [58, "red", "Ashgrove Private Credit Fund"],
    "DEMO-RENTAL": [58, "red", "Larkspur Residences"],
    "HONEST-CREDIT": [100, "green", "Kestrel Lending Fund"],
    "HONEST-RENTAL": [100, "green", "Linden Court"],
  };
  for (const f of built.demo_funds) {
    assert.equal(f.tag, "demo, not on chain");
    assert.equal(f.on_chain, false);
    assert.equal(f.method, "cashflow-v2.1.0");
    assert.equal(f.score, expect[f.fund_id][0]);
    assert.equal(f.band, expect[f.fund_id][1]);
    assert.equal(f.name, expect[f.fund_id][2]);
    assert.ok(f.roster.length >= 20);
  }
});

test("runtime guard hides the data room when anchors disagree", () => {
  const ok = anchorsMatch(meridian.anchors, {
    score: 43,
    true_val_cents: "309297000",
    headline_cents: "373500000",
    policy_nav_cents: "343500000",
    loan_hashes: meridian.anchors.loan_hashes,
  });
  assert.equal(ok.ok, true);
  const bad = anchorsMatch(meridian.anchors, {
    score: 43,
    true_val_cents: "1",
    headline_cents: "373500000",
    policy_nav_cents: "343500000",
    loan_hashes: meridian.anchors.loan_hashes,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, OUT_OF_SYNC_COPY);
});

test("demo file does not use em dashes or en dashes", () => {
  const raw = readFileSync(join(here, "funds.demo.json"), "utf8") + readFileSync(join(here, "generate.mjs"), "utf8");
  assert.equal(raw.includes("\u2014"), false);
  assert.equal(raw.includes("\u2013"), false);
});
