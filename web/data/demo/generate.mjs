// Deterministic demo fund detail. Seed is sha256(fund_id) via node:crypto (a Node builtin, not an npm package).
// Money for the two on-chain funds is copied from spec/nav/fixtures.json. Document facts are copied from tee/docs.
// Invented fields sit under data_room.demo and are tagged "demo".
//
//   node web/data/demo/generate.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scorePortfolio } from "../../../engine/src/score.mjs";
import { datasets, RUN_AS_OF, BANK_FETCHED_AT, PERIOD, DAYS_IN_PERIOD } from "../../../cashflow/demo/data.mjs";
import { runFund } from "../../../cashflow/run.mjs";
import { METHOD } from "../../../spec/v2/score.mjs";
import {
  VALUATION_DATE,
  REGISTRY,
  dollarsToCents,
  dpdInBucket,
  bucketForDpd,
  loanEconomics,
  exposuresFromLoans,
} from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

const US_REGIONS = ["Northeast", "Midwest", "South", "West"];
const INVOICE_GEO = [
  { country: "US", region: "Midwest" },
  { country: "US", region: "South" },
  { country: "US", region: "West" },
  { country: "DE", region: "non-US" },
  { country: "SG", region: "non-US" },
  { country: "MX", region: "non-US" },
];
const RE_SECTORS = ["multifamily", "industrial", "office", "mixed use"];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function u32(seed, key) {
  return createHash("sha256").update(`${seed}:${key}`).digest().readUInt32BE(0);
}

function pick(seed, key, list) {
  return list[u32(seed, key) % list.length];
}

function rangeInt(seed, key, lo, hi) {
  return lo + (u32(seed, key) % (hi - lo + 1));
}

function addYears(iso, years) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y + years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarterOf(iso) {
  if (!iso) return "unknown";
  const [y, m] = iso.split("-").map(Number);
  return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
}

function maturityBucket(iso) {
  if (!iso) return "bullet under 1 year";
  const days = (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${VALUATION_DATE}T00:00:00Z`)) / 86400000;
  if (days < 365) return "under 1 year";
  if (days < 365 * 3) return "1 to 3 years";
  if (days < 365 * 7) return "3 to 7 years";
  return "over 7 years";
}

function parseDoc(text) {
  const field = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  const coupon = /Interest:\s+([0-9.]+)%\s+fixed,\s+monthly/.exec(text);
  return {
    borrower: field(/^Borrower:\s+(.+)$/m) || field(/^Buyer \(debtor\):\s+(.+)$/m),
    recorded: field(/^Recorded:\s+(\d{4}-\d{2}-\d{2})$/m),
    issue: field(/^Issue date:\s+(\d{4}-\d{2}-\d{2})$/m),
    due: field(/^Due date:\s+(\d{4}-\d{2}-\d{2})$/m),
    goods: field(/^Goods:\s+(.+)$/m),
    lien: field(/^Lien position:\s+(.+)$/m),
    coupon_bps: coupon ? Math.round(Number(coupon[1]) * 100) : null,
    kind: text.includes("COMMERCIAL INVOICE") ? "commercial invoice" : "recorded mortgage summary",
  };
}

function loadDocs() {
  const dir = join(root, "tee/docs");
  const out = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const id = name.replace(/\.txt$/, "");
    out.set(id, parseDoc(readFileSync(join(dir, name), "utf8")));
  }
  return out;
}

function dpdFor(loan) {
  if (Number.isFinite(loan.dpd)) return loan.dpd;
  if (loan.bucket === "current") return 0;
  if (loan.bucket === "dpd_1_30") return 9;
  if (loan.bucket === "dpd_31_60") return 45;
  if (loan.bucket === "dpd_61_90") return 75;
  if (loan.bucket === "dpd_over_90") return 104;
  return 0;
}

function ltvBounds(bucket) {
  if (bucket === "dpd_over_90") return [8000, 11000];
  if (bucket === "dpd_61_90") return [7000, 9000];
  return [5000, 7500];
}

function monthDue(ym) {
  return `${ym}-01`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Months whose 1st is inside the past-due window ending on the valuation date. */
function missedMonths(dpd) {
  if (dpd <= 0) return [];
  const start = new Date(Date.parse(`${VALUATION_DATE}T00:00:00Z`) - dpd * 86400000).toISOString().slice(0, 10);
  const months = [];
  let ym = start.slice(0, 7);
  const end = VALUATION_DATE.slice(0, 7);
  while (ym <= end) {
    const due = monthDue(ym);
    if (due >= start && due <= VALUATION_DATE) months.push(ym);
    ym = addMonths(ym, 1);
  }
  return months;
}

function buildPayments(loan, doc, dpd, seed) {
  const missed = new Set(missedMonths(dpd));
  if (loan.asset === "real_estate" && doc && doc.recorded) {
    // 600 bps is 6 percent. Monthly interest in cents is principal cents times 0.06 / 12.
    const monthly = Math.round((dollarsToCents(loan.principal) * 600) / 10000 / 12);
    const rows = [];
    let ym = doc.recorded.slice(0, 7);
    const end = VALUATION_DATE.slice(0, 7);
    while (ym <= end) {
      const isMissed = missed.has(ym);
      rows.push({
        due: monthDue(ym),
        amount_cents: String(monthly),
        component: "interest",
        status: isMissed ? "missed" : "received",
        tag: "demo",
      });
      ym = addMonths(ym, 1);
    }
    const maturity = addYears(doc.recorded, 5);
    rows.push({
      due: maturity,
      amount_cents: String(dollarsToCents(loan.principal)),
      component: "principal",
      status: "scheduled",
      tag: "demo",
    });
    return { rows, monthly_interest_cents: monthly, missed: [...missed] };
  }
  if (loan.asset === "invoices") {
    const due = doc && doc.due ? doc.due : null;
    const face = dollarsToCents(loan.principal + loan.accrued);
    const rows = [];
    if (due) {
      rows.push({
        due,
        amount_cents: String(face),
        component: "bullet",
        status: eadDollarsSafe(loan) === 0 ? "received" : "scheduled",
        tag: "demo",
        note: "Bullet on the document due date. Face is principal plus accrued from the fixture.",
      });
    }
    if (loan.bucket !== "current" && eadDollarsSafe(loan) !== 0) {
      rows.push({
        due: VALUATION_DATE,
        amount_cents: String(dollarsToCents(loan.accrued)),
        component: "servicer accrued",
        status: "missed",
        tag: "demo",
        note: "Servicer bucket is delinquent. The shortfall is the fixture accrued amount. The document due date may still be in the future.",
      });
    }
    return { rows, monthly_interest_cents: 0, missed: loan.bucket === "current" ? [] : ["bullet"] };
  }
  return { rows: [], monthly_interest_cents: 0, missed: [] };
}

function eadDollarsSafe(loan) {
  return loan.principal + loan.accrued - loan.repaid;
}

function demoProfile(fundId, name) {
  if (fundId === "meridian-yield-fund") {
    return {
      tag: "demo",
      name,
      legal_form: "closed-end LP (fictional)",
      domicile: "fictional",
      strategy: "senior secured real estate and trade receivables",
      vintage_year: 2025,
      inception_date: "2025-06-01",
      base_currency: "USD",
      target_net_return_bps: 900,
      fees: { management_bps: 150, performance_bps: 1500, hurdle_bps: 700 },
      liquidity: { redemptions: "quarterly", notice_days: 90, lockup_months: 12, gate_bps: 1000 },
      service_providers: {
        administrator: "Demo Fund Admin (fictional)",
        auditor: "Demo Audit LLP (fictional)",
        servicer: "TrueNav Labs (testnet servicer)",
      },
      valuation_policy: "amortized cost with markdowns for delinquency (policy NAV)",
      reporting: "monthly NAV, quarterly LP letter",
    };
  }
  return {
    tag: "demo",
    name,
    legal_form: "closed-end LP (fictional)",
    domicile: "fictional",
    strategy: "first-lien real estate and short-dated receivables",
    vintage_year: 2025,
    inception_date: "2025-03-01",
    base_currency: "USD",
    target_net_return_bps: 800,
    fees: { management_bps: 125, performance_bps: 1000, hurdle_bps: 600 },
    liquidity: { redemptions: "quarterly", notice_days: 60, lockup_months: 12, gate_bps: 1000 },
    service_providers: {
      administrator: "Demo Fund Admin (fictional)",
      auditor: "Demo Audit LLP (fictional)",
      servicer: "TrueNav Labs (testnet servicer)",
    },
    valuation_policy: "amortized cost with markdowns for delinquency (policy NAV)",
    reporting: "monthly NAV, quarterly LP letter",
  };
}

function navHistory(fundId, cert, bookCents) {
  const months = [];
  for (let i = 0; i < 11; i++) months.push(addMonths("2025-12", i));
  const drift = fundId === "meridian-yield-fund";
  const points = months.map((month) => {
    const wobble = ((u32(sha256(fundId), month) % 161) - 80) / 10000;
    let reported = Math.round(bookCents * (1 + wobble));
    if (drift && month >= "2026-07") {
      const step = ["2026-07", "2026-08", "2026-09", "2026-10"].indexOf(month);
      const dest = Number(cert.headline_cents);
      const start = bookCents;
      reported = Math.round(start + ((step + 1) / 5) * (dest - start));
    }
    return {
      month,
      reported_nav_cents: String(reported),
      true_val_cents: null,
      true_range_cents: null,
      demo_true_val_cents: String(Math.round(Number(cert.true_val_cents) * (1 + wobble * 0.25))),
      demo_true_range_cents: cert.true_range_cents,
      tag: "demo",
      series: "demo backfill, not certified",
    };
  });
  points.push({
    month: "2026-11",
    reported_nav_cents: cert.headline_cents,
    policy_nav_cents: cert.policy_nav_cents,
    true_val_cents: cert.true_val_cents,
    true_range_cents: cert.true_range_cents,
    tag: "recorded",
    source: "engine pins checked on chain by certify/testnet.mjs. Confirm with get_latest_certificate before treating this point as live.",
  });
  return points;
}

function position(headline, trueVal, trueRange) {
  const lo = trueVal - trueRange;
  const hi = trueVal + trueRange;
  if (headline > hi) return "above";
  if (headline < lo) return "below";
  return "inside";
}

function stressScenarios(model, fund, base) {
  const clone = () => JSON.parse(JSON.stringify(fund));
  const scoreOne = (f, pd, lgd) => {
    const r = scorePortfolio({ pd, lgd }, [f], { now: "2026-11-10T12:00:00Z", certStore: {}, teeStore: base.teeStore });
    return r[0];
  };
  const pack = (id, label, rule, r) => ({
    id,
    label,
    tag: "computed (demo)",
    rule,
    true_val_cents: String(dollarsToCents(r.trueVal)),
    true_range_cents: String(dollarsToCents(r.trueRange)),
    policy_nav_cents: String(dollarsToCents(r.policyNav)),
    reported_nav_cents: String(dollarsToCents(r.headline)),
    reported_nav_vs_range: position(r.headline, r.trueVal, r.trueRange),
    score_not_on_chain: true,
  });
  const pd2 = Object.fromEntries(Object.entries(model.pd).map(([k, v]) => [k, Math.min(1, v * 2)]));
  const lgd10 = Object.fromEntries(Object.entries(model.lgd).map(([k, v]) => [k, Math.min(1, v + 0.1)]));
  const lgdProperty = { ...model.lgd, real_estate: Math.min(1, model.lgd.real_estate + 0.1) };
  const late = clone();
  for (const l of late.loans) {
    if (l.asset !== "invoices" || l.principal + l.accrued - l.repaid === 0) continue;
    const next = (l.dpd || 0) + 60;
    l.dpd = next;
    l.bucket = bucketForDpd(next);
  }
  const largest = clone();
  let biggest = null;
  for (const l of largest.loans) {
    const ead = l.principal + l.accrued - l.repaid;
    if (ead > 0 && (!biggest || ead > biggest.ead)) biggest = { loan: l, ead };
  }
  if (biggest) {
    biggest.loan.bucket = "dpd_over_90";
    biggest.loan.dpd = 120;
  }
  const baseScore = scoreOne(fund, model.pd, model.lgd);
  return [
    pack("base", "Certified inputs", "Unchanged fixture. Shown so the scenarios have a baseline. This is not a new on-chain score.", baseScore),
    pack("pd_x2", "Default rates double", "Each PD in spec/nav/fixtures.json is doubled and capped at 100%. Demo stress, not a certified score.", scoreOne(clone(), pd2, model.lgd)),
    pack("lgd_plus_10", "Loss given default plus 10 points", "Each LGD is increased by 0.10 and capped at 100%.", scoreOne(clone(), model.pd, lgd10)),
    pack("property_minus_20", "Property values minus 20%", "The certified engine has no LTV input. This demo maps a 20% price drop to a 10 point rise in real estate LGD, capped at 100%.", scoreOne(clone(), model.pd, lgdProperty)),
    pack("invoices_60_late", "Invoices paid 60 days late", "Invoice dpd increases by 60 and the bucket follows engine/src/score.mjs BUCKET_DPD. Real estate loans stay as in the fixture.", scoreOne(late, model.pd, model.lgd)),
    pack("largest_defaults", "Largest obligor defaults", `The open loan with the largest EAD (${biggest ? biggest.loan.id : "none"}) moves to dpd_over_90 (PD 100%).`, scoreOne(largest, model.pd, model.lgd)),
  ];
}

function cashFlowMonthly(loans) {
  const byMonth = new Map();
  for (const loan of loans) {
    const pay = loan.data_room.demo.payments || [];
    for (const p of pay) {
      if (p.component === "principal" && p.status === "scheduled" && p.due > VALUATION_DATE) continue;
      const month = p.due.slice(0, 7);
      if (month > VALUATION_DATE.slice(0, 7)) continue;
      if (!byMonth.has(month)) {
        byMonth.set(month, { month, scheduled_interest_cents: 0, scheduled_principal_cents: 0, received_cents: 0, shortfall_cents: 0, tag: "demo" });
      }
      const row = byMonth.get(month);
      const amount = Number(p.amount_cents);
      if (p.component === "principal") row.scheduled_principal_cents += amount;
      else row.scheduled_interest_cents += amount;
      if (p.status === "received") row.received_cents += amount;
      else if (p.status === "missed" || p.status === "servicer reports delinquent") row.shortfall_cents += amount;
    }
  }
  return {
    tag: "demo",
    rule: "Real estate scheduled interest is principal times 6% / 12, copied from the document coupon. A month inside the servicer dpd window is a shortfall. Invoices are a bullet on the document due date. Current-loan accrued interest is earned and not yet due, so it is not a shortfall.",
    monthly: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({
      ...r,
      scheduled_interest_cents: String(r.scheduled_interest_cents),
      scheduled_principal_cents: String(r.scheduled_principal_cents),
      received_cents: String(r.received_cents),
      shortfall_cents: String(r.shortfall_cents),
    })),
  };
}

function accruedReconciliation(fundLoans, built) {
  const rows = [];
  for (const src of fundLoans) {
    const builtLoan = built.find((l) => l.data_room.loan_id === src.id);
    const monthly = builtLoan.data_room.demo.monthly_interest_cents;
    const missedN = (builtLoan.data_room.demo.missed_months || []).filter((m) => m !== "bullet").length;
    const fixture = dollarsToCents(src.accrued);
    const delinquentRe = src.asset === "real_estate" && src.bucket !== "current";
    const couponShortfall = delinquentRe ? missedN * monthly : 0;
    const modelUnpaid = delinquentRe ? couponShortfall : fixture;
    rows.push({
      loan_id: src.id,
      fixture_accrued_cents: String(fixture),
      model_unpaid_cents: String(modelUnpaid),
      residual_cents: String(fixture - modelUnpaid),
      tag: "computed (demo)",
    });
  }
  return {
    tag: "computed (demo)",
    note: "Current real estate loans: fixture accrued is within $50 of one coupon month (day-count stub). Delinquent real estate: residual is fixture accrued minus missed coupons. H-RE-05 is dpd_1_30 in the fixture while accrued is about two coupons; the bucket wins, and the residual is reported rather than forced to zero.",
    loans: rows,
  };
}

function buildLoan(fund, loan, hashRow, doc, seed, economics) {
  const dpd = dpdFor(loan);
  if (!dpdInBucket(loan.bucket, dpd)) {
    throw new Error(`${loan.id} dpd ${dpd} is outside bucket ${loan.bucket}`);
  }
  const isRe = loan.asset === "real_estate";
  const [ltvLo, ltvHi] = ltvBounds(loan.bucket);
  const ltv = isRe ? rangeInt(seed, `${loan.id}:ltv`, ltvLo, ltvHi) : null;
  const principalCents = dollarsToCents(loan.principal);
  const collateral = ltv ? String(Math.round((principalCents * 10000) / ltv)) : null;
  const advance = loan.asset === "invoices" ? rangeInt(seed, `${loan.id}:advance`, 8000, 9000) : null;
  const discount = loan.asset === "invoices" ? rangeInt(seed, `${loan.id}:discount`, 300, 600) : null;
  const dscr = loan.bucket === "current"
    ? rangeInt(seed, `${loan.id}:dscr`, 110, 160) / 100
    : rangeInt(seed, `${loan.id}:dscr`, 70, 99) / 100;
  const geo = isRe
    ? { country: "US", region: pick(seed, `${loan.id}:region`, US_REGIONS) }
    : pick(seed, `${loan.id}:geo`, INVOICE_GEO);
  const sector = isRe ? pick(seed, `${loan.id}:sector`, RE_SECTORS) : (doc && doc.goods ? doc.goods.split(",")[0].trim() : "receivables");
  const maturity = isRe && doc && doc.recorded ? addYears(doc.recorded, 5) : (doc && doc.due) || null;
  const payments = buildPayments(loan, doc, dpd, seed);
  const closed = economics.open === false;
  const enclave = hashRow ? "pass" : null;
  return {
    loan_hash: hashRow ? hashRow.loan_hash : null,
    asset_type: loan.asset === "invoices" ? "invoices" : loan.asset,
    pledged_at_ms: null,
    verdict: hashRow ? "pass" : null,
    public_tags: {
      loan_hash: hashRow ? "recorded" : "demo",
      asset_type: "recorded",
      pledged_at_ms: "live",
      verdict: hashRow ? "recorded" : "demo",
    },
    public_sources: {
      loan_hash: hashRow ? "tee/loans.json" : "H-IN-04 has no pledge token in tee/loans.json. Fixture note: NFT burned, lock released.",
      asset_type: "spec/nav/fixtures.json and tee/loans.json. Chain metadata uses the same asset_type values (real_estate, invoices).",
      pledged_at_ms: "Not stored. Read nft_token issued_at on the registry.",
      verdict: hashRow ? "tee/fixtures/verdicts-368aa2.json records pass for this loan hash. The chain latest verdict is a live read." : "No recorded verdict. The fixture marks the loan repaid.",
    },
    data_room: {
      tag: "demo",
      loan_id: loan.id,
      recorded: {
        tag: "recorded",
        borrower_alias: doc && doc.borrower ? doc.borrower : `Demo Borrower ${loan.id} (fictional, no tee/docs file)`,
        coupon_bps: doc ? doc.coupon_bps : null,
        lien: doc ? doc.lien : null,
        origination_date: doc ? (doc.recorded || doc.issue) : null,
        document_due_date: doc ? doc.due : null,
        goods: doc ? doc.goods : null,
        document_type: doc ? doc.kind : null,
        principal_cents: String(principalCents),
        accrued_cents: String(dollarsToCents(loan.accrued)),
        repaid_cents: String(dollarsToCents(loan.repaid)),
        bucket: loan.bucket,
        dpd: Number.isFinite(loan.dpd) ? loan.dpd : dpd,
        dpd_source: Number.isFinite(loan.dpd) ? "spec/nav/fixtures.json" : "demo value inside the fixture bucket",
        servicer_anomaly_flag: loan.anomaly === true,
        fixture_note: loan.note || null,
        source: "spec/nav/fixtures.json and tee/docs. Document ids and document text are not copied.",
      },
      demo: {
        tag: "demo",
        seed: `sha256(${fund.fund_id})`,
        geography: geo,
        sector,
        collateral: isRe ? { type: "first mortgage", value_cents: collateral } : { type: "receivable", value_cents: null },
        ltv_bps: ltv,
        dscr,
        advance_rate_bps: advance,
        discount_bps: discount,
        maturity_date: maturity,
        maturity_rule: isRe ? "5 years from the recorded date in tee/docs" : "invoice due date copied from tee/docs",
        vintage_quarter: quarterOf(doc ? (doc.recorded || doc.issue) : null),
        maturity_bucket: maturityBucket(maturity),
        status: closed ? "closed" : loan.bucket === "current" ? "performing" : "delinquent",
        monthly_interest_cents: payments.monthly_interest_cents,
        missed_months: payments.missed,
        payments: payments.rows,
      },
      engine: {
        tag: "computed",
        source: "engine/src/score.mjs formulas on the fixture loan, same PD and LGD tables",
        open: economics.open,
        ead_cents: String(dollarsToCents(economics.ead)),
        pd: economics.pd,
        lgd: economics.lgd,
        mark_cents: String(dollarsToCents(economics.mark)),
        expected_loss_cents: economics.expectedLoss === null ? null : String(dollarsToCents(economics.expectedLoss)),
        true_val_part_cents: String(dollarsToCents(economics.trueValPart)),
        verified: economics.verified,
        reason: economics.reason,
      },
      documents: doc ? [{
        type: doc.kind,
        enclave_verdict: enclave,
        tag: "demo",
        source: "Type copied from tee/docs. Enclave verdict is the recorded pass in tee/fixtures/verdicts-368aa2.json. Document text is not included.",
      }] : [],
      checks: loan.id === "M-IN-03" ? {
        documents: "pass (enclave)",
        servicer_data: "anomaly, excluded from TrueVal",
        line: "documents: pass (enclave). servicer data: anomaly, excluded from TrueVal.",
        citation: "spec/nav/fixtures.json sets anomaly true on M-IN-03 (note: Underwriter flagged a tampered invoice). tee/fixtures/verdicts-368aa2.json records an enclave pass. TrueVal excludes the loan because of the servicer anomaly flag, not because the enclave failed. The blocked double-pledge attempt is a different loan: the H-RE-03 fixture note says Meridian tried to pledge that Harbor property and was blocked.",
      } : null,
    },
  };
}

function certificateFromResult(fund, result) {
  return {
    score: result.score,
    raw_x100: Math.round(result.raw * 100),
    true_val_cents: String(dollarsToCents(result.trueVal)),
    true_range_cents: String(dollarsToCents(result.trueRange)),
    policy_nav_cents: String(dollarsToCents(result.policyNav)),
    headline_cents: String(dollarsToCents(result.headline)),
    blocked_attempts: result.penaltyDetail.attemptsCounted,
    band: result.band,
    status: result.status,
    engine_commit: "d837036",
    engine_commit_source: "Named in certify/testnet-record.test.mjs. The live certificate's engine_commit must be read with get_latest_certificate.",
  };
}

function whyScore(result) {
  const holds = [];
  if (result.noGreenCap) holds.push("A recent blocked pledge attempt keeps the band out of green (engine noGreenCap).");
  if (result.concentration.largestBreach) holds.push("Largest obligor is over 15% of open EAD (engine concentration, flag only, no score impact).");
  if (result.concentration.topFiveBreach) holds.push("Top five obligors are over 50% of open EAD (engine concentration, flag only, no score impact).");
  if (result.gap.boundSide === "over") holds.push("Reported NAV is above TrueRange.");
  if (result.gap.boundSide === "under") holds.push("Reported NAV is below TrueRange.");
  if (result.unverified.ids.length) holds.push(`Unverified loans: ${result.unverified.reasons.map((r) => `${r.id} (${r.reason})`).join(", ")}.`);
  return {
    tag: "computed",
    source: "engine/src/score.mjs scorePortfolio",
    raw: Math.round(result.raw * 100) / 100,
    score: result.score,
    band: result.band,
    pillars: result.pillars,
    concentration: result.concentration,
    holds,
  };
}

export function buildDemo() {
  const fx = JSON.parse(readFileSync(join(root, "spec/nav/fixtures.json"), "utf8"));
  const loanFile = JSON.parse(readFileSync(join(root, "tee/loans.json"), "utf8"));
  const docs = loadDocs();
  const liveLoans = loanFile.loans.filter((l) => !l.tampered);
  const fundsIn = JSON.parse(JSON.stringify(fx.funds));
  const teeStore = {};
  for (const f of fundsIn) {
    for (const l of f.loans) {
      const m = liveLoans.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
      if (!m) continue;
      if (m.asset_type !== l.asset) throw new Error(`${l.id} asset ${l.asset} does not match tee/loans.json ${m.asset_type}`);
      l.loan_hash = m.loan_hash;
      teeStore[m.loan_hash] = { fund_id: f.fund_id, pledged_at_ms: 1, latest: { verdict: "pass", anomalies: [], at_ms: 2 } };
    }
  }
  const scored = scorePortfolio({ pd: fx.pd, lgd: fx.lgd }, fundsIn, {
    now: fx.valuation_time,
    certStore: fx.cert_store,
    teeStore,
  });
  const funds = fundsIn.map((fund, i) => {
    const result = scored[i];
    const cert = certificateFromResult(fund, result);
    const seed = sha256(fund.fund_id);
    const hashRows = liveLoans.filter((l) => l.fund_id === fund.fund_id);
    const loans = fund.loans.map((loan) => {
      const hashRow = hashRows.find((h) => h.loan_id === loan.id) || null;
      const doc = docs.get(loan.id) || null;
      const economics = loanEconomics({ ...loan, policy_markdown: fund.policy_markdown }, fx);
      return buildLoan(fund, loan, hashRow, doc, seed, economics);
    });
    const open = loans.filter((l) => l.data_room.engine.open);
    const carrying = open.reduce((s, l) => s + Number(l.data_room.engine.ead_cents), 0);
    const managerName = fund.fund_id === "meridian-yield-fund" ? "Meridian Capital Partners (fictional)" : "Harbor Credit Partners (fictional)";
    return {
      fund_id: fund.fund_id,
      on_chain: true,
      anchors: {
        source: "recorded",
        registry: REGISTRY,
        fund_account: fund.fund_id === "harbor-credit-fund" ? "harbor.tnlab-368aa2.testnet" : "meridian.tnlab-368aa2.testnet",
        fund_account_source: "certify/testnet.mjs FUND_ACCOUNT names these testnet accounts. Confirm with get_fund.",
        manager_id: fund.certificate.signer,
        manager_id_source: "spec/nav/fixtures.json certificate.signer",
        certificate: cert,
        loan_hashes: hashRows.map((h) => h.loan_hash),
        carrying_value_cents: String(carrying),
        open_loans: open.length,
      },
      profile: { ...demoProfile(fund.fund_id, fund.name), aum_cents: cert.headline_cents, aum_source: "headline NAV from the engine certificate, not a separate valuation" },
      manager: {
        tag: "demo",
        manager_id: fund.certificate.signer,
        name: managerName,
        founded: fund.fund_id === "meridian-yield-fund" ? 2019 : 2018,
        hq: "fictional",
        team: [{ role: "PM", alias: "Manager A" }],
      },
      nav_history: navHistory(fund.fund_id, cert, Number(cert.policy_nav_cents)),
      loans,
      cash_flows: cashFlowMonthly(loans),
      accrued_reconciliation: accruedReconciliation(fund.loans, loans),
      stress_scenarios: stressScenarios(fx, fund, { teeStore }),
      exposures: exposuresFromLoans(loans),
      why_score: whyScore(result),
      investor_reports: [
        { period: "2026-10", type: "LP letter", tag: "demo", body: "Demo letter. Fictional. No performance claim beyond the figures in this file." },
        { type: "TrueNav report", tag: "recorded", href: `/reports/${fund.fund_id}`, note: "The printable report uses the certificate pins. A live page should rebuild it from get_latest_certificate." },
      ],
    };
  });

  const demoFunds = datasets().map((ds) => {
    const r = runFund(ds, {
      key: "demo-pseudonym-key-not-secret",
      asOf: RUN_AS_OF,
      period: PERIOD,
      daysInPeriod: DAYS_IN_PERIOD,
      bankFetchedAt: BANK_FETCHED_AT,
    });
    const m = r.public_metrics;
    const roster = ds.kind === "credit"
      ? ds.servicer_tape.loans.map((l) => ({ loan_id: l.loan_id, principal_cents: l.principal_cents, rate_bps: l.rate_bps, pay_type: l.pay_type }))
      : ds.manager_export.units.map((u) => ({ unit_id: u.unit_id, occupied: u.occupied, rent_cents: u.rent_cents }));
    return {
      fund_id: ds.id,
      on_chain: false,
      tag: "demo, not on chain",
      name: ds.name,
      kind: ds.kind,
      method: METHOD,
      score: r.score.score,
      band: r.score.band,
      uncapped_score: r.score.uncapped_score,
      caps: r.score.caps.map((c) => c.reason),
      holds: (r.score.holds || []).map((h) => h.reason),
      period: PERIOD,
      as_of: RUN_AS_OF,
      claimed_vs_settled: {
        tag: "computed",
        source: "cashflow/run.mjs on cashflow/demo/data.mjs",
        claimed_cash_cents: m.claimed_cash_cents,
        cash_received_cents: m.cash_received_cents,
        cash_match_bps: m.cash_match_bps,
        claimed_not_settled_cents: m.exceptions.claimed_not_settled_cents,
      },
      public_metrics: {
        reported_yield_bps: m.reported_yield_bps ?? null,
        cash_yield_bps: m.cash_yield_bps ?? null,
        collection_rate_bps: m.collection_rate_bps ?? m.collection?.rate_bps ?? null,
        occupancy_bps: m.occupancy_bps ?? null,
        rent_due_cents: m.rent_due_cents ?? null,
        rent_collected_cents: m.rent_collected_cents ?? null,
        net_operating_cash_cents: m.net_operating_cash_cents ?? null,
        distributions_cents: m.distributions_cents ?? null,
      },
      roster,
    };
  });

  return {
    schema: "truenav-fund-detail-v1",
    generator: "web/data/demo/generate.mjs",
    generated_from: {
      repo_commit: "9fe5985",
      fixtures: "spec/nav/fixtures.json",
      loans: "tee/loans.json",
      docs: "tee/docs/",
      verdicts: "tee/fixtures/verdicts-368aa2.json",
      cashflow: "cashflow/demo/data.mjs",
      engine: "engine/src/score.mjs",
    },
    disclaimer: "Demo data. Fictional funds, managers, borrowers and documents. Testnet demo. Market data is not in this file.",
    valuation_time: fx.valuation_time,
    model: { pd: fx.pd, lgd: fx.lgd, source: "spec/nav/fixtures.json" },
    funds,
    demo_funds: demoFunds,
  };
}

export function writeDemo(target = join(here, "funds.demo.json")) {
  const data = buildDemo();
  const cashflowOnly = {
    schema: "truenav-cashflow-demo-v1",
    generator: "web/data/demo/generate.mjs",
    disclaimer: "Demo data. These four funds are not on chain.",
    method: METHOD,
    funds: data.demo_funds,
  };
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(join(here, "cashflow-funds.json"), `${JSON.stringify(cashflowOnly, null, 2)}\n`);
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = writeDemo();
  for (const f of data.funds) {
    console.log(`${f.fund_id}: open ${f.anchors.open_loans}, carrying ${f.anchors.carrying_value_cents}, trueVal ${f.anchors.certificate.true_val_cents}, score ${f.anchors.certificate.score}`);
  }
  for (const f of data.demo_funds) console.log(`${f.fund_id}: ${f.score} ${f.band} (${f.tag})`);
}
