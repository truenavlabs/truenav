// Browser-safe helpers for the TrueNav demo fund detail. No node: imports.
// Money in the fixtures is whole dollars. Certificates store integer cents (certify/certificate.mjs).

export const VALUATION_DATE = "2026-11-10";
export const REGISTRY = "registry.tnlab-368aa2.testnet";

export const BUCKET_DPD = Object.freeze({
  current: [-Infinity, 0],
  dpd_1_30: [1, 30],
  dpd_31_60: [31, 60],
  dpd_61_90: [61, 90],
  dpd_over_90: [91, Infinity],
});

export function dollarsToCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

export function centsToNumber(cents) {
  return Number(cents);
}

export function eadDollars(loan) {
  return loan.principal + loan.accrued - loan.repaid;
}

export function dpdInBucket(bucket, dpd) {
  const span = BUCKET_DPD[bucket];
  if (!span) return false;
  return dpd >= span[0] && dpd <= span[1];
}

export function bucketForDpd(dpd) {
  if (dpd <= 0) return "current";
  if (dpd <= 30) return "dpd_1_30";
  if (dpd <= 60) return "dpd_31_60";
  if (dpd <= 90) return "dpd_61_90";
  return "dpd_over_90";
}

/**
 * Policy mark and expected loss for one fixture loan, same formulas as engine/src/score.mjs assessLoans.
 * verified is false when the fixture anomaly flag is set, which is why M-IN-03 leaves TrueVal.
 */
export function loanEconomics(loan, model) {
  const ead = eadDollars(loan);
  const pd = Object.prototype.hasOwnProperty.call(model.pd, loan.bucket) ? model.pd[loan.bucket] : null;
  const lgd = Object.prototype.hasOwnProperty.call(model.lgd, loan.asset) ? model.lgd[loan.asset] : null;
  const markdowns = loan.policy_markdown && typeof loan.policy_markdown === "object" ? loan.policy_markdown : {};
  const markdown = Object.prototype.hasOwnProperty.call(markdowns, loan.bucket) ? markdowns[loan.bucket] : 0;
  if (ead === 0) {
    return { open: false, ead: 0, pd, lgd, mark: 0, expectedLoss: 0, trueValPart: 0, verified: false, reason: "repaid" };
  }
  const mark = ead * (1 - markdown);
  const anomaly = loan.anomaly === true;
  const verified = loan.nft === true && !anomaly && pd !== null && lgd !== null;
  let reason = null;
  if (!verified) reason = loan.nft !== true ? "no nft" : anomaly ? "anomaly flag" : "incomplete data";
  const expectedLoss = pd === null || lgd === null ? null : ead * pd * lgd;
  const trueValPart = verified ? ead * (1 - pd * lgd) : 0;
  const variancePart = verified ? ead ** 2 * lgd ** 2 * pd * (1 - pd) : 0;
  return { open: true, ead, pd, lgd, mark, markdown, expectedLoss, trueValPart, variancePart, verified, reason };
}

export function hhi(shares) {
  return shares.reduce((s, x) => s + x * x, 0);
}

/** Exposures from the data room. Asset type is joined from the fixture. Geography and sector are demo. */
export function exposuresFromLoans(loans) {
  const open = loans.filter((l) => l.data_room && l.data_room.engine && l.data_room.engine.open);
  const sum = (rows, keyFn) => {
    const m = new Map();
    let total = 0;
    for (const row of rows) {
      const ead = Number(row.data_room.engine.ead_cents);
      total += ead;
      const key = keyFn(row);
      m.set(key, (m.get(key) || 0) + ead);
    }
    const parts = [...m.entries()].map(([key, cents]) => ({
      key,
      ead_cents: String(cents),
      share: total > 0 ? cents / total : 0,
    })).sort((a, b) => Number(b.ead_cents) - Number(a.ead_cents));
    return { total_ead_cents: String(total), parts };
  };
  const byObligor = sum(open, (l) => l.data_room.recorded.borrower_alias || l.data_room.loan_id);
  const shares = byObligor.parts.map((p) => p.share);
  return {
    by_asset_type: { tag: "computed", source: "spec/nav/fixtures.json asset, joined to tee/loans.json", ...sum(open, (l) => l.asset_type) },
    by_geography: { tag: "computed (demo)", ...sum(open, (l) => `${l.data_room.demo.geography.country} / ${l.data_room.demo.geography.region}`) },
    by_sector: { tag: "computed (demo)", ...sum(open, (l) => l.data_room.demo.sector) },
    by_lien: { tag: "computed (demo)", ...sum(open, (l) => l.data_room.recorded.lien || "receivable") },
    by_vintage_quarter: { tag: "computed (demo)", ...sum(open, (l) => l.data_room.demo.vintage_quarter) },
    by_maturity_bucket: { tag: "computed (demo)", ...sum(open, (l) => l.data_room.demo.maturity_bucket) },
    by_delinquency: { tag: "computed", source: "spec/nav/fixtures.json bucket", ...sum(open, (l) => l.data_room.recorded.bucket) },
    top_obligors: { tag: "computed (demo)", parts: byObligor.parts.slice(0, 5) },
    hhi: { tag: "computed (demo)", value: hhi(shares), basis: "open loan EAD by borrower alias" },
  };
}

/**
 * Runtime guard (spec 3C.4 rule 11). If the live certificate or the loan set disagrees with the
 * anchors, the shell hides data room numbers.
 */
export function anchorsMatch(anchors, live) {
  if (!live || typeof live !== "object") {
    return { ok: false, reason: "no live read" };
  }
  const cert = anchors.certificate;
  const mismatches = [];
  if (Number(live.score) !== Number(cert.score)) mismatches.push("score");
  if (String(live.true_val_cents) !== String(cert.true_val_cents)) mismatches.push("true_val");
  if (String(live.headline_cents) !== String(cert.headline_cents)) mismatches.push("headline");
  if (String(live.policy_nav_cents) !== String(cert.policy_nav_cents)) mismatches.push("policy_nav");
  if (Array.isArray(live.loan_hashes)) {
    const want = [...anchors.loan_hashes].sort();
    const got = [...live.loan_hashes].sort();
    if (want.length !== got.length || want.some((h, i) => h !== got[i])) mismatches.push("loan_set");
  }
  if (mismatches.length) {
    return { ok: false, reason: "Demo detail is out of sync with the chain; showing chain values only.", mismatches };
  }
  return { ok: true, mismatches: [] };
}

export const OUT_OF_SYNC_COPY = "Demo detail is out of sync with the chain; showing chain values only.";
