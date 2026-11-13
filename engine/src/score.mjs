// TrueNav score engine v2. Implements the rules decided by owner 5 Nov 2026 (R1 to R24),
// documented in spec/nav/NAV_SPEC.md and engine/README.md.
// Plain Node, no dependencies, no network. The engine never throws on bad fund or loan data.

/** Display labels and one-line explainers. Single source for UI and docs. */
export const LABELS = Object.freeze({
  trueVal: Object.freeze({
    label: "TrueVal",
    tooltip: "what the fund's loans are worth after expected losses. model estimate, not fair value.",
  }),
  trueRange: Object.freeze({
    label: "TrueRange",
    tooltip: "where TrueVal likely falls, assuming loans default independently. demo estimate.",
  }),
  score: Object.freeze({
    label: "TrueNav score",
    tooltip: "how far you can trust the fund's reported NAV, 0 to 100.",
  }),
});

/** Model labels (decided by owner 5 Nov 2026). */
export const MODEL_LABELS = Object.freeze({
  pd: "demo, not calibrated",
  lgd: "inference from a corporate stress table; KBRA methodology does not address CRE CLOs",
  trueRange: "demo range (independent defaults)",
});

/** R3 model tables (decided by owner 5 Nov 2026). real_estate is first-lien real estate; invoices are treated as unsecured. */
export const DEFAULT_MODEL = Object.freeze({
  pd: Object.freeze({ current: 0.02, dpd_1_30: 0.1, dpd_31_60: 0.25, dpd_61_90: 0.45, dpd_over_90: 1.0 }),
  lgd: Object.freeze({ real_estate: 0.31, invoices: 0.67 }),
});

/** R1 days-past-due range per bucket (decided by owner 5 Nov 2026). */
export const BUCKET_DPD = Object.freeze({
  current: [-Infinity, 0],
  dpd_1_30: [1, 30],
  dpd_31_60: [31, 60],
  dpd_61_90: [61, 90],
  dpd_over_90: [91, Infinity],
});

/** Thresholds (decided by owner 5 Nov 2026). 30 days, 50% and 10% are TrueNav's own policy, not agency figures. */
export const THRESHOLDS = Object.freeze({
  green: 85,
  yellow: 60,
  z: 1.96,
  gapTolerance: 0.1,
  freshFullHours: 24,
  freshZeroHours: 168,
  staleDays: 30,
  disclaimShare: 0.5,
  cashMaxAgeHours: 168,
  shellShare: 0.1,
  managerWindowDays: 90,
  noGreenDays: 30,
  penaltyBase: 15,
  penaltyHalfLifeDays: 30,
  concentrationLargest: 0.15,
  concentrationTopFive: 0.5,
  teeGraceDays: 7,
  clockSkewMinutes: 10,
});

/** R14 sort order. not_rated is outside the order (rank null). invalid_fund_fields ranks 0 with verification_failed (decided by owner). */
export const STATUS_RANK = Object.freeze({ verification_failed: 0, invalid_fund_fields: 0, disclaimed: 1, red: 2, yellow: 3, green: 4 });

const HOUR = 3600 * 1000;
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isId = (x) => (typeof x === "string" && x.length > 0) || isNum(x);
// Own-property lookup, so bucket or asset names like "toString" or "__proto__" never hit Object.prototype (hole 3).
const own = (obj, key) => (obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
const toCents = (x) => Math.round(x * 100);

/** Strict ISO 8601 date-time with a time zone, as required for cash_asof (6b). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(x) {
  if (typeof x === "string") return Date.parse(x);
  if (isNum(x)) return x;
  return NaN;
}

/** R24: age in hours, clamped at 0. A missing or unparseable as-of is treated as infinitely old (proposed, pending owner). */
export function ageHours(asof, now) {
  const t = parseTime(asof);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return Infinity;
  return Math.max(0, (now - t) / HOUR);
}

/** R8 freshness curve: 1 at 24 h or less, linear to 0 at 168 h. */
export function freshness(hours) {
  if (typeof hours !== "number" || Number.isNaN(hours)) return 0;
  const h = Math.max(0, hours);
  if (h <= THRESHOLDS.freshFullHours) return 1;
  return Math.max(0, 1 - (h - THRESHOLDS.freshFullHours) / (THRESHOLDS.freshZeroHours - THRESHOLDS.freshFullHours));
}

/** R9 cost of one attempt. Non-finite or negative ages count as age 0 (full cost; proposed, pending owner). */
export function attemptCost(ageDays) {
  const d = isNum(ageDays) && ageDays > 0 ? ageDays : 0;
  return THRESHOLDS.penaltyBase * 0.5 ** (d / THRESHOLDS.penaltyHalfLifeDays);
}

/** R9: dedupe delivery retries by action_id; attempts without an action_id each count (proposed, pending owner). */
export function dedupeAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const seen = new Map();
  const kept = [];
  let retries = 0;
  list.forEach((a, i) => {
    const raw = a && typeof a === "object" ? a : {};
    const id = isId(raw.action_id) ? String(raw.action_id) : null;
    const age = isNum(raw.age_days) && raw.age_days > 0 ? raw.age_days : 0;
    if (id !== null && seen.has(id)) {
      // A retry keeps the youngest listed age, matching the cross-fund rule (hole 8).
      retries++;
      const k = kept[seen.get(id)];
      if (age < k.age_days) {
        k.age_days = age;
        k.cost = attemptCost(age);
      }
      return;
    }
    if (id !== null) seen.set(id, kept.length);
    // Payload snapshots are ignored: shell size comes only from the verifier record (opts.attemptLog).
    kept.push({ action_id: id ?? `#${i}`, hasId: id !== null, age_days: age, cost: attemptCost(age) });
  });
  return { attempts: kept, retries };
}

/** R9 penalty: linear stacking of distinct attempts. */
export function penalty(attempts) {
  return dedupeAttempts(attempts).attempts.reduce((s, a) => s + a.cost, 0);
}

/** R11 rounding. */
export function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

/** R11 band on the rounded score. */
export function bandOf(score) {
  if (score >= THRESHOLDS.green) return "green";
  if (score >= THRESHOLDS.yellow) return "yellow";
  return "red";
}

/**
 * R6 gap points. beyond = max(over, under); band edges inside; no verified loans gives 0.
 * over = max(0, LIH - hi); under = max(0, lo - min(LIH, Policy NAV)).
 */
export function gapPoints({ lih, policyNav, lo, hi, trueVal, hasVerified }) {
  const over = Math.max(0, lih - hi);
  const under = Math.max(0, lo - Math.min(lih, policyNav));
  const beyond = Math.max(over, under);
  const boundSide = beyond === 0 ? "inside" : over >= under ? "over" : "under";
  let points;
  if (!hasVerified) points = 0;
  else if (beyond === 0) points = 40;
  else {
    const tol = THRESHOLDS.gapTolerance * trueVal;
    points = tol > 0 ? 40 * Math.max(0, 1 - beyond / tol) : 0;
  }
  return { over, under, beyond, boundSide, points };
}

/** R7 coverage points; R22 fails closed on a zero denominator. */
export function coveragePoints(policyNav, lih, listedBook) {
  const denom = Math.max(lih, listedBook);
  if (!(denom > 0)) return { ratio: 0, points: 0 };
  const ratio = Math.min(1, Math.max(0, policyNav / denom));
  return { ratio, points: 40 * ratio };
}

/** R14: any numeric filter only ever passes a scored fund. */
export function passesMinScore(result, min) {
  return result.status === "scored" && typeof result.score === "number" && result.score >= min;
}

/** A cert store is a plain object (prototype Object or null, not an array) whose every own value is an array. */
export function validCertStore(x) {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(x).every((k) => Array.isArray(x[k]));
}

function resolveNow(now) {
  if (now === undefined) return Date.now();
  return parseTime(now);
}

/**
 * TEE verdict store read from the chain (owner decisions 6 Nov 2026): { [loan_hash]: { pledged_at_ms, latest } },
 * latest = { verdict: "pass" | "flag", anomalies: string[], at_ms } or null. Valid only as a plain object whose
 * every own value is an object.
 */
export function validTeeStore(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(x).every((v) => v && typeof v === "object" && !Array.isArray(v));
}

/**
 * TEE status of one pledged loan (owner decisions 6 Nov 2026): the latest stored verdict counts. A flag makes the
 * loan unverified ("TEE flag: <codes>"). With no verdict the loan is pending for 7 days after its on-chain pledge
 * time, then unverified ("TEE check overdue"). A verdict whose expires_at_ms is before the verdict clock is "expired": not a
 * pass, the loan is unverified ("TEE verdict expired"); expiry equal to the clock is still current. A loan with no loan_hash or no store entry is "not checked" and its
 * score is unchanged.
 */
function teeStatus(teeStore, l, nowMs, verdictNowMs = nowMs) {
  if (!teeStore) return { status: "not checked" };
  if (!isId(l.loan_hash)) return { status: "not checked" };
  const e = own(teeStore, String(l.loan_hash));
  if (!e || typeof e !== "object") return { status: "not checked" };
  // C2 (decided by owner 6 Nov 2026): a verdict counts only if stored at or after the current pledge time.
  const raw = e.latest && typeof e.latest === "object" ? e.latest : null;
  const v = raw && (!isNum(e.pledged_at_ms) || (isNum(raw.at_ms) && raw.at_ms >= e.pledged_at_ms)) ? raw : null;
  // N-02: a verdict past its expiry no longer counts, whether pass or flag: the loan is unverified ("TEE verdict
  // expired") until a fresh verdict is stored. A verdict without expires_at_ms is read as before. Same rule as the
  // contract (expires_at_ms >= now is current) and tee/expiry.mjs: expiry equal to the clock is current, +1 ms expired.
  if (v && isNum(v.expires_at_ms) && v.expires_at_ms < verdictNowMs) return { status: "expired" };
  if (v && v.verdict === "flag") return { status: "flag", anomalies: Array.isArray(v.anomalies) ? v.anomalies.map(String) : [] };
  if (v && v.verdict === "pass") return { status: "pass" };
  if (isNum(e.pledged_at_ms) && nowMs - e.pledged_at_ms > THRESHOLDS.teeGraceDays * 86400000) return { status: "overdue" };
  return { status: "pending" };
}

function assessLoans(model, fund, sharedNfts, teeStore = null, nowMs = Date.now(), verdictNowMs = nowMs) {
  const pdT = (model && model.pd) || {};
  const lgdT = (model && model.lgd) || {};
  const md = fund.policy_markdown && typeof fund.policy_markdown === "object" ? fund.policy_markdown : {};
  const loansIn = Array.isArray(fund.loans) ? fund.loans : [];
  const seenNft = new Set();
  const seenLoanHash = new Set();
  const lines = [];

  loansIn.forEach((input, i) => {
    const l = input && typeof input === "object" ? input : {};
    const id = isId(l.id) ? String(l.id) : `#${i}`;
    const reasons = [];
    const push = (r) => {
      if (!reasons.includes(r)) reasons.push(r);
    };

    const pd = own(pdT, l.bucket);
    const lgd = own(lgdT, l.asset);
    if (!isNum(lgd)) push("unknown asset");
    if (!isNum(pd)) push("invalid bucket");

    const p = l.principal;
    const a = l.accrued;
    const r = l.repaid;
    const eadOk = isNum(p) && isNum(a) && isNum(r);
    if (!eadOk) push("incomplete data");
    const ead = eadOk ? p + a - r : null;

    // R1: fully repaid loans are closed, not open.
    if (eadOk && ead === 0) {
      lines.push({ id, open: false, closed: true, ead: 0, mark: 0, markRaw: 0, reasons: [], verified: false });
      return;
    }

    // R1 / T16 / R13: EAD for the 50% test. A non-finite or missing repaid counts as principal + accrued.
    // Non-finite principal or accrued is unknown exposure; the fund is disclaimed (decided by owner).
    const unknownExposure = !(isNum(p) && isNum(a));
    const ead50 = unknownExposure ? null : isNum(r) ? p + a - r : p + a;

    // R1 / T17: dpd present and finite must sit inside the tagged bucket. Absent (undefined or null) is fine.
    // A present non-finite dpd is incomplete data (proposed, pending owner).
    if (l.dpd !== undefined && l.dpd !== null) {
      if (!isNum(l.dpd)) push("incomplete data");
      else if (Array.isArray(own(BUCKET_DPD, l.bucket))) {
        const [lo, hi] = own(BUCKET_DPD, l.bucket);
        if (l.dpd < lo || l.dpd > hi) push("invalid bucket");
      }
    }

    const nftHeld = l.nft === true;
    const nftId = isId(l.nft_id) ? String(l.nft_id) : null;
    if (nftHeld && nftId === null) push("incomplete data"); // R23

    if (eadOk && ead < 0) push("overpaid, check servicing"); // R1

    // Fund mark: reported_value, else EAD x (1 - policy markdown). A present non-finite reported_value or an
    // invalid markdown is incomplete data with mark 0 (proposed, pending owner).
    let markRaw = 0;
    if (l.reported_value !== undefined) {
      if (isNum(l.reported_value)) markRaw = l.reported_value;
      else push("incomplete data");
    } else if (eadOk) {
      const m = own(md, l.bucket) === undefined ? 0 : own(md, l.bucket);
      if (isNum(m) && m >= 0 && m <= 1) markRaw = ead * (1 - m);
      else push("incomplete data");
    }
    const mark = Math.max(0, markRaw); // R1 / R5 / B5: lines floor at 0

    // R23 duplicate NFT identity: first occurrence may verify, later copies are excluded.
    if (nftHeld && nftId !== null) {
      if (seenNft.has(nftId)) push("duplicate nft");
      else seenNft.add(nftId);
      // Offline fallback (6a, decided by owner 6 Nov 2026): with no chain data, an nft_id verified in more than one
      // fund counts as verified in neither. With chain data the on-chain pledge holder decides (below).
      if (!teeStore && sharedNfts && sharedNfts.has(nftId)) push("nft_id listed by several funds");
    }
    // Duplicate loan_hash: first occurrence may verify, later copies are excluded.
    if (isId(l.loan_hash)) {
      const h = String(l.loan_hash);
      if (seenLoanHash.has(h)) push("duplicate loan");
      else seenLoanHash.add(h);
    }
    // 6a (decided by owner 6 Nov 2026): with chain data, a loan counts as verified only for the fund whose on-chain
    // pledge holds it. A rival listing the same loan is unverified for the rival only.
    if (nftHeld && teeStore) {
      const e = isId(l.loan_hash) ? own(teeStore, String(l.loan_hash)) : undefined;
      if (!e || typeof e !== "object") push("not pledged on chain");
      else if (isId(e.fund_id) && String(e.fund_id) !== String(fund.fund_id)) push("pledged by another fund");
    }

    // TEE underwriter verdict for a pledged loan (owner decisions 6 Nov 2026).
    const tee = nftHeld ? teeStatus(teeStore, l, nowMs, verdictNowMs) : { status: "not pledged" };
    if (tee.status === "flag") push(`TEE flag: ${tee.anomalies.join(", ")}`);
    if (tee.status === "overdue") push("TEE check overdue");
    if (tee.status === "expired") push("TEE verdict expired");

    const excluded = reasons.length > 0;
    const anomaly = l.anomaly === true;
    const verified = !excluded && nftHeld && !anomaly;
    const unverifiedReason = verified ? null : excluded ? reasons[0] : !nftHeld ? "no nft" : "anomaly flag";
    const v50 = Math.max(mark, ead50 === null ? 0 : Math.max(0, ead50)); // R13
    // R15: same exposure as the 50% test when EAD is not computable (hole 10).
    const concEad = eadOk ? Math.max(0, ead) : v50;

    lines.push({
      id,
      open: true,
      closed: false,
      asset: l.asset,
      bucket: l.bucket,
      pd: isNum(pd) ? pd : null,
      lgd: isNum(lgd) ? lgd : null,
      ead,
      ead50,
      unknownExposure,
      mark,
      markRaw,
      reasons,
      excluded,
      verified,
      unverifiedReason,
      v50,
      concEad,
      // Grouping key: obligor when given, else the loan's input position, so a generated "#1" can never merge
      // with a supplied id "#1" (hole 11).
      obligor: isId(l.obligor_id) ? `obligor:${l.obligor_id}` : `loan-index:${i}`,
      nftId: nftHeld ? nftId : null,
      tee: tee.status,
      servicerAsof: l.servicer_asof,
    });
  });
  return { lines, loansIn };
}

function concentration(open) {
  const total = open.reduce((s, l) => s + l.concEad, 0);
  const groups = new Map();
  for (const l of open) groups.set(l.obligor, (groups.get(l.obligor) ?? 0) + l.concEad);
  const sizes = [...groups.values()].sort((x, y) => y - x);
  const largest = total > 0 ? sizes[0] / total : 0;
  const topFive = total > 0 ? sizes.slice(0, 5).reduce((s, x) => s + x, 0) / total : 0;
  return {
    basis: "EAD on open listed loans",
    largestShare: largest,
    topFiveShare: topFive,
    largestBreach: largest > THRESHOLDS.concentrationLargest,
    topFiveBreach: topFive > THRESHOLDS.concentrationTopFive,
    reference: "S&P AIF para 91 (15% and 50%), as cited by owner; flag only, no score impact",
  };
}

function finalize(result) {
  const p = result.pillars;
  const raw = p.gap + p.coverage + p.freshness - p.penalty;
  result.raw = raw;
  result.rawDisplay = (Math.round(raw * 10) / 10).toFixed(1);
  const numeric = roundHalfUp(Math.max(0, raw));
  // Floor bind only on a scored fund that carries a penalty (decided by owner).
  result.floorBind = result.status === "scored" && p.penalty > 0 && raw <= 0;
  if (result.status === "scored") {
    let band = bandOf(numeric);
    result.noGreenCapApplied = false;
    if (band === "green" && result.noGreenCap) {
      band = "yellow";
      result.noGreenCapApplied = true;
    }
    result.score = numeric;
    result.band = band;
    result.color = band;
    result.statusRank = STATUS_RANK[band];
  } else {
    result.score = null;
    result.band = null;
    result.noGreenCapApplied = false;
    result.color = result.status === "not_rated" ? "grey" : "red";
    result.statusRank = STATUS_RANK[result.status] ?? null;
  }
  result.pillarsHidden = false;
  return result;
}

/**
 * Score one fund on its own (own attempts only). Use scorePortfolio for R10 manager-wide rules.
 * @param {object} model { pd, lgd }
 * @param {object} fund  fund input (see engine/README.md)
 * @param {object} [opts] { now: ISO string or ms, certStore: { [fund_id]: [{ fund_id, signed_at }] } }
 */
export function scoreFund(model, fund, opts = {}) {
  const f = fund && typeof fund === "object" ? fund : {};
  const now = resolveNow(opts.now);
  const flags = [];
  const invalidReasons = [];

  // R21 / R19 fund-level fields.
  const headlinePresent = isNum(f.headline_nav);
  if (f.headline_nav !== undefined && !headlinePresent) flags.push("headline invalid, treated as missing");
  let cash = 0;
  let negativeCash = 0;
  if (f.cash !== undefined) {
    if (isNum(f.cash)) cash = f.cash;
    else invalidReasons.push("cash invalid");
  }
  if (cash < 0) {
    // Negative cash counts as a liability (decided by owner).
    negativeCash = -cash;
    cash = 0;
    flags.push("negative cash treated as liability");
  }
  let liabilities = 0;
  if (f.liabilities !== undefined) {
    if (isNum(f.liabilities) && f.liabilities >= 0) liabilities = f.liabilities;
    else invalidReasons.push("liabilities invalid");
  }
  liabilities += negativeCash;
  const liabilitiesAttested = f.liabilities_attested === true;

  // R20 cash statement (6b, decided by owner 6 Nov 2026): only a valid ISO 8601 date within 168 h, and no more
  // than 10 minutes in the future (clock skew), attests cash. Expired, malformed, missing, future and not-claimed
  // attestations are all unattested cash with no freshness penalty, each flagged with its own reason.
  const cashClaimed = f.cash_attested === true;
  let cashStatus = cashClaimed ? "valid" : "not claimed";
  let cashAgeH = null;
  if (cashClaimed) {
    const t = typeof f.cash_asof === "string" && ISO_DATE.test(f.cash_asof) ? Date.parse(f.cash_asof) : NaN;
    if (!Number.isFinite(t)) {
      cashStatus = "invalid";
      flags.push("attestation date invalid");
    } else if (t - now > THRESHOLDS.clockSkewMinutes * 60000) {
      cashStatus = "future";
      flags.push("attestation date in the future");
    } else {
      cashAgeH = Math.max(0, (now - t) / 3600000);
      if (cashAgeH > THRESHOLDS.cashMaxAgeHours) {
        cashStatus = "expired";
        flags.push("cash attestation expired");
      }
    }
  }
  const cashAttested = cashStatus === "valid";
  const attestedCash = cashAttested ? cash : 0;
  const unattestedCash = cashAttested ? 0 : cash;

  // R17 / R18 certificate-derived identity.
  const cert = f.certificate && typeof f.certificate === "object" ? f.certificate : null;
  const managerId = cert ? (isId(cert.manager_id) ? String(cert.manager_id) : isId(cert.signer) ? String(cert.signer) : null) : null;
  const managerIdSpoof = f.manager_id !== undefined && String(f.manager_id) !== String(managerId);
  if (managerIdSpoof) flags.push("manager_id spoof");
  // previously_certified: verifier cert store unioned with payload history, prior to now (decided by owner).
  // The store counts only as a plain object whose every own value is an array (decided by owner 5 Nov 2026 20:10).
  const store = validCertStore(opts.certStore) ? opts.certStore : null;
  if (!store) flags.push("no cert store: previously_certified not verifiable");
  const cutoff = now;
  const history = [
    ...(cert && Array.isArray(cert.history) ? cert.history : []),
    ...(store && isId(f.fund_id) && Object.prototype.hasOwnProperty.call(store, String(f.fund_id)) ? store[String(f.fund_id)] : []),
  ];
  const previouslyCertified =
    isId(f.fund_id) &&
    history.some((h) => h && String(h.fund_id) === String(f.fund_id) && parseTime(h.signed_at) < cutoff);
  const previouslyCertifiedSpoof = typeof f.previously_certified === "boolean" && f.previously_certified !== previouslyCertified;
  if (previouslyCertifiedSpoof) flags.push("previously_certified spoof");

  // Loans.
  const sharedNfts = opts.sharedNftIds instanceof Set ? opts.sharedNftIds : null;
  const teeStore = validTeeStore(opts.teeStore) ? opts.teeStore : null;
  if (!teeStore) flags.push("TEE verdicts not checked");
  if (!teeStore) flags.push("ownership not checkable (no chain data)");
  // Verdict expiry is judged at opts.verdictNow (the time the chain was read; live readers pass the wall clock), or at
  // the valuation time when it is not given, so replays of fixed fixtures stay deterministic.
  const verdictNow = opts.verdictNow === undefined ? now : resolveNow(opts.verdictNow);
  const { lines } = assessLoans(model, f, sharedNfts, teeStore, now, verdictNow);
  if (lines.some((l) => l.reasons && l.reasons.includes("nft_id listed by several funds"))) flags.push("nft_id listed by several funds");
  const open = lines.filter((l) => l.open);
  const verified = open.filter((l) => l.verified);
  const unverified = open.filter((l) => !l.verified);

  // R5 walk.
  const listedBook = open.reduce((s, l) => s + l.mark, 0);
  if (!headlinePresent) flags.push("headline missing; pillars computed with headline = listed book");
  const headline = headlinePresent ? f.headline_nav : listedBook;
  const residual = headline - (listedBook + cash - liabilities);
  const notListed = Math.max(0, residual);
  const bookBase = listedBook + cash - liabilities;
  const headlineBelowBook =
    residual < 0 ? { amount: -residual, percent: bookBase > 0 ? -residual / bookBase : null, percentBasis: "listed book + cash - liabilities" } : null;
  if (headlineBelowBook) flags.push("headline below book");

  // R6 LIH.
  const lih = headline + liabilities - attestedCash;

  // R4.
  const policyNav = verified.reduce((s, l) => s + l.mark, 0);
  const trueVal = verified.reduce((s, l) => s + l.ead * (1 - l.pd * l.lgd), 0);
  const variance = verified.reduce((s, l) => s + l.ead ** 2 * l.lgd ** 2 * l.pd * (1 - l.pd), 0);
  const trueRange = THRESHOLDS.z * Math.sqrt(variance);
  const lo = trueVal - trueRange;
  const hi = trueVal + trueRange;

  const gap = gapPoints({ lih, policyNav, lo, hi, trueVal, hasVerified: verified.length > 0 });
  const cov = coveragePoints(policyNav, lih, listedBook);

  // R8 / R24 data age: oldest of every loan's servicer_asof, the NAV report date, cash_asof when attested,
  // and the certificate data_asof.
  const loanInputs = Array.isArray(f.loans) ? f.loans : [];
  const asofs = [...loanInputs.map((l) => (l && typeof l === "object" ? l.servicer_asof : undefined)), f.nav_report_date];
  // Only a valid cash attestation enters the data age (6b, decided by owner 6 Nov 2026; replaces hole 6 and V4).
  if (cashAttested) asofs.push(f.cash_asof);
  if (cert) asofs.push(cert.data_asof);
  const ages = asofs.map((x) => ageHours(x, now));
  // A missing or unparseable as-of makes the data age unknown: null, scored as stale with freshness 0.
  const dataAgeHours = ages.length && ages.every((x) => Number.isFinite(x)) ? Math.max(...ages) : null;
  const freshPts = 20 * freshness(dataAgeHours);

  // R9 own penalty.
  const own = dedupeAttempts(f.blocked_attempts);
  const ownPenalty = own.attempts.reduce((s, a) => s + a.cost, 0);
  const ownRecent = own.attempts.some((a) => a.age_days <= THRESHOLDS.noGreenDays);

  // R13 50% test.
  const unverifiedLoansValue = unverified.reduce((s, l) => s + l.v50, 0);
  const unverifiedValue = unverifiedLoansValue + notListed + Math.max(0, unattestedCash);
  // Hole 2 (decided by owner 6 Nov 2026 13:32): in the 50% test only, a verified line counts at most its EAD.
  const listedBook50 = open.reduce((s, l) => s + (l.verified ? Math.min(l.mark, Math.max(0, l.ead)) : l.mark), 0);
  const denom50 = Math.max(headline, listedBook50);
  const shareRaw = denom50 > 0 ? unverifiedValue / denom50 : unverifiedValue > 0 ? Infinity : 0;
  // Hole 7: "over 50%" is decided in integer cents, so float noise at exactly 50% never disclaims.
  const overHalf = denom50 > 0 ? 2 * toCents(unverifiedValue) > toCents(denom50) : unverifiedValue > 0;
  const shareDisplay = Math.min(1, shareRaw);

  // Hole 12: amounts so large that the arithmetic overflows (or yields NaN) are rejected, never scored.
  const preRaw = gap.points + cov.points + freshPts - ownPenalty;
  if (![trueVal, trueRange, listedBook, policyNav, lih, preRaw].every((x) => Number.isFinite(x))) invalidReasons.push("amounts overflow");

  // R14 status. invalid_fund_fields is checked first (order proposed, pending owner).
  let status;
  const statusReasons = [];
  const stale = dataAgeHours === null || dataAgeHours > THRESHOLDS.staleDays * 24;
  if (invalidReasons.length) {
    status = "invalid_fund_fields";
    statusReasons.push(...invalidReasons);
  } else if ((previouslyCertified && (!cert || !headlinePresent || stale)) || (cert && stale)) {
    // R14 as changed by owner: a certificate over stale data fails, whether or not the fund was certified before.
    status = "verification_failed";
    if (!cert) statusReasons.push("certificate missing");
    if (!headlinePresent && previouslyCertified) statusReasons.push("headline missing");
    if (stale) statusReasons.push(dataAgeHours === null ? "data age unknown" : "data age over 30 days");
  } else if (!previouslyCertified && (!cert || !headlinePresent)) {
    status = "not_rated";
    if (!cert) statusReasons.push("certificate missing");
    if (!headlinePresent) statusReasons.push("headline missing");
  } else if (open.length === 0) {
    // headline <= 0 with no loans is not_rated (negative headline: proposed, pending owner).
    if (headline > 0) {
      status = "disclaimed";
      statusReasons.push("no loans in book, headline above 0 (100% unverified)");
    } else {
      status = "not_rated";
      statusReasons.push("no loans in book");
    }
  } else if (unverified.some((l) => l.unknownExposure)) {
    status = "disclaimed";
    statusReasons.push("unverified line with unknown exposure");
  } else if (overHalf) {
    status = "disclaimed";
    statusReasons.push("unverified share over 50%");
  } else {
    status = "scored";
  }

  // Exclusions grouped by reason.
  const exclusions = open
    .filter((l) => l.excluded)
    .map((l) => ({ id: l.id, reason: l.reasons[0], reasons: l.reasons, value: l.mark, raw_value: l.markRaw, ead_raw: l.ead }));
  const exclusionsByReason = {};
  for (const e of exclusions) {
    const g = (exclusionsByReason[e.reason] ??= { count: 0, total: 0, raw_total: 0, ids: [] });
    g.count++;
    g.total += e.value;
    g.raw_total += e.raw_value;
    g.ids.push(e.id);
  }
  const zeroMarked = unverified.filter((l) => l.mark === 0);

  const result = {
    fundId: isId(f.fund_id) ? String(f.fund_id) : null,
    name: typeof f.name === "string" ? f.name : null,
    status,
    statusReasons,
    managerId,
    previouslyCertified,
    spoofFlags: { previouslyCertified: previouslyCertifiedSpoof, managerId: managerIdSpoof },
    flags,
    headline,
    headlinePresent,
    listedBook,
    cash: { amount: cash, attested: cashAttested, attestationClaimed: cashClaimed, asof: typeof f.cash_asof === "string" ? f.cash_asof : null, ageHours: cashAgeH, attestationStatus: cashStatus, attestationRevokedForAge: cashStatus === "expired" },
    liabilities: { amount: liabilities, attested: liabilitiesAttested, label: liabilitiesAttested ? "liabilities attested" : "liabilities self-reported" },
    lih,
    residual: notListed > 0 ? { kind: "not listed in book", amount: notListed, percent: headline > 0 ? notListed / headline : null } : headlineBelowBook ? { kind: "headline below book", ...headlineBelowBook } : { kind: "none", amount: 0, percent: 0 },
    headlineBelowBook,
    policyNav,
    trueVal: Number.isNaN(trueVal) ? null : trueVal,
    trueRange: Number.isNaN(trueRange) ? null : trueRange,
    trueRangeLow: Number.isNaN(lo) ? null : lo,
    trueRangeHigh: Number.isNaN(hi) ? null : hi,
    policyInRange: verified.length > 0 && policyNav >= lo && policyNav <= hi,
    gap: { over: gap.over, under: gap.under, beyond: gap.beyond, boundSide: gap.boundSide },
    coverage: cov.ratio,
    dataAgeHours,
    verifiedNftIds: verified.map((l) => l.nftId).filter((x) => x !== null),
    exclusions,
    exclusionsByReason,
    zeroMarkedUnverified: { count: zeroMarked.length, ids: zeroMarked.map((l) => l.id), reasons: zeroMarked.map((l) => l.unverifiedReason) },
    unverified: {
      value: unverifiedValue,
      loans: unverifiedLoansValue,
      notListed,
      unattestedCash: Math.max(0, unattestedCash),
      shareRaw,
      shareDisplay,
      overHalf,
      listedBook50,
      ids: unverified.map((l) => l.id),
      reasons: unverified.map((l) => ({ id: l.id, reason: l.unverifiedReason })),
    },
    concentration: concentration(open),
    counts: {
      loans: lines.length,
      open: open.length,
      closed: lines.length - open.length,
      verified: verified.length,
      unverified: unverified.length,
      excluded: exclusions.length,
    },
    // TEE underwriter status of the open pledged loans (owner decisions 6 Nov 2026).
    tee: {
      checked: !!teeStore,
      pass: open.filter((l) => l.tee === "pass").length,
      flag: open.filter((l) => l.tee === "flag").length,
      pending: open.filter((l) => l.tee === "pending").length,
      overdue: open.filter((l) => l.tee === "overdue").length,
      expired: open.filter((l) => l.tee === "expired").length,
      notChecked: open.filter((l) => l.tee === "not checked").length,
      loans: open.filter((l) => l.tee && l.tee !== "not pledged").map((l) => ({ id: l.id, status: l.tee })),
    },
    pillars: {
      gap: Number.isFinite(gap.points) ? gap.points : 0,
      coverage: Number.isFinite(cov.points) ? cov.points : 0,
      freshness: freshPts,
      penalty: ownPenalty,
    },
    penaltyDetail: {
      own: ownPenalty,
      sibling: 0,
      attemptsCounted: own.attempts.length,
      dedupedRetries: own.retries,
      attempts: own.attempts.map(({ action_id, hasId, age_days, cost }) => ({ action_id, hasId, age_days, cost })),
      managerWide: false,
      managerWideReasons: [],
      siblingAttempts: [],
    },
    managerWarning: false,
    noGreenCap: ownRecent,
    labels: LABELS,
  };
  return finalize(result);
}

/**
 * Score a set of funds and apply R10 / R12 manager-wide rules across funds that share a manager_id.
 * manager_id comes from the certificate. A fund with no certificate takes it from its verifier attempt records:
 * one named manager makes it a member of that manager; several make it a member of each, with each attempt
 * going to the manager its own record names (decided by owner 5 Nov 2026 20:10).
 * One action_id listed by several funds of a manager is one attempt: its age is the youngest listed age and every
 * listing fund pays it at that age as its own penalty (decided by owner 5 Nov 2026 20:10).
 * Manager-wide is decided per attempt: any listing fund is a shell at the event, or the attempt is the manager's
 * 2nd or later within 90 days, or any scored manager fund with a penalty has its floor bind (raw <= 0).
 * @param {object} [opts] { now, certStore, attemptLog: { [fund_id]: { [action_id]: record } } }
 *   record: { attempting_status, attempting_policy_nav, largest_policy_nav, attempting_open_loans, manager_id }
 *   Shell size is read only from the record; payload snapshots are ignored. With no record, current size is used.
 */
export function scorePortfolio(model, funds, opts = {}) {
  const list = Array.isArray(funds) ? funds : [];
  // Hole 1 (decided by owner 6 Nov 2026 13:32): an nft_id verified in more than one fund counts as verified in
  // neither. First pass finds such ids; funds that list one are scored again with those lines excluded.
  const first = list.map((f) => scoreFund(model, f, opts));
  const nftFunds = new Map();
  first.forEach((r, i) => {
    for (const id of new Set(r.verifiedNftIds)) {
      if (!nftFunds.has(id)) nftFunds.set(id, new Set());
      nftFunds.get(id).add(i);
    }
  });
  const shared = new Set([...nftFunds].filter(([, fs]) => fs.size > 1).map(([id]) => id));
  const results = shared.size
    ? first.map((r, i) => (r.verifiedNftIds.some((id) => shared.has(id)) ? scoreFund(model, list[i], { ...opts, sharedNftIds: shared }) : r))
    : first;
  const log = opts.attemptLog && typeof opts.attemptLog === "object" ? opts.attemptLog : {};
  const recordsOf = (r) =>
    r.fundId !== null && Object.prototype.hasOwnProperty.call(log, r.fundId) && log[r.fundId] && typeof log[r.fundId] === "object" ? log[r.fundId] : {};
  const recordFor = (i, a) => {
    if (!a.hasId) return null;
    const recs = recordsOf(results[i]);
    const rec = Object.prototype.hasOwnProperty.call(recs, a.action_id) ? recs[a.action_id] : null;
    return rec && typeof rec === "object" ? rec : null;
  };
  const flag = (r, text) => {
    if (!r.flags.includes(text)) r.flags.push(text);
  };

  // Manager membership per fund and per attempt.
  const attemptMgr = results.map(() => []);
  results.forEach((r, i) => {
    const atts = r.penaltyDetail.attempts;
    if (r.managerId !== null) {
      r.managerIdSource = "certificate";
      r.managerIds = [r.managerId];
      attemptMgr[i] = atts.map(() => r.managerId);
      return;
    }
    const named = [...new Set(Object.values(recordsOf(r)).filter((x) => x && isId(x.manager_id)).map((x) => String(x.manager_id)))].sort();
    if (named.length === 0) {
      r.managerIds = [];
      if (atts.length) flag(r, "attempts not attributable to a manager");
      attemptMgr[i] = atts.map(() => null);
      return;
    }
    r.managerIdSource = "attempt log";
    r.managerIds = named;
    // Hole 9: a payload manager_id that matches a manager named in the attempt log is not a spoof.
    const payloadMgr = list[i] && typeof list[i] === "object" ? list[i].manager_id : undefined;
    if (payloadMgr !== undefined && named.includes(String(payloadMgr))) {
      r.spoofFlags.managerId = false;
      r.flags = r.flags.filter((x) => x !== "manager_id spoof");
    }
    if (named.length === 1) {
      r.managerId = named[0];
      attemptMgr[i] = atts.map(() => named[0]);
      return;
    }
    flag(r, "conflicting manager_id in attempt log");
    attemptMgr[i] = atts.map((a) => {
      const rec = recordFor(i, a);
      if (rec && isId(rec.manager_id)) return String(rec.manager_id);
      flag(r, "attempts not attributable to a manager");
      return null;
    });
  });

  const byManager = new Map();
  results.forEach((r, i) => {
    for (const m of r.managerIds) {
      if (!byManager.has(m)) byManager.set(m, []);
      byManager.get(m).push(i);
    }
  });

  // Group attempts per manager by action_id. Attempts without an action_id stay per fund.
  const managers = [];
  for (const [mgr, idxs] of byManager) {
    const groups = new Map();
    for (const i of idxs) {
      results[i].penaltyDetail.attempts.forEach((a, k) => {
        if (attemptMgr[i][k] !== mgr) return;
        const key = a.hasId ? `id:${a.action_id}` : `fund:${i}:${a.action_id}`;
        if (!groups.has(key)) groups.set(key, { action_id: a.action_id, listings: [] });
        groups.get(key).listings.push({ i, k, listedAge: a.age_days });
      });
    }
    for (const g of groups.values()) {
      g.age = Math.min(...g.listings.map((l) => l.listedAge));
      g.cost = attemptCost(g.age);
      g.listers = [...new Set(g.listings.map((l) => l.i))];
    }
    managers.push({ mgr, idxs, groups: [...groups.values()] });
  }

  // Pass 1: every listing fund pays a shared attempt at its youngest listed age, as its own penalty.
  const eff = results.map((r) => r.penaltyDetail.attempts.map((a) => ({ age: a.age_days, cost: a.cost })));
  for (const m of managers) {
    for (const g of m.groups) {
      for (const l of g.listings) eff[l.i][l.k] = { age: g.age, cost: g.cost };
      if (g.listers.length > 1) for (const i of g.listers) flag(results[i], "action_id listed by several funds");
    }
  }
  results.forEach((r, i) => {
    const own = eff[i].reduce((s, e) => s + e.cost, 0);
    r.penaltyDetail.attempts = r.penaltyDetail.attempts.map((a, k) => ({ ...a, listed_age_days: a.age_days, age_days: eff[i][k].age, cost: eff[i][k].cost }));
    r.penaltyDetail.own = own;
    r.pillars.penalty = own;
    r.noGreenCap = eff[i].some((e) => e.age <= THRESHOLDS.noGreenDays);
    finalize(r);
    r.ownFloorBind = r.floorBind;
    r.penaltyDetail.ownAttemptsManagerWide = [];
  });

  // Pass 2: manager-wide decision per attempt, sibling penalties and warnings.
  const shellStatuses = new Set(["not_rated", "disclaimed", "verification_failed", "invalid_fund_fields"]);
  const extra = results.map(() => []);
  for (const m of managers) {
    const largest = Math.max(0, ...m.idxs.map((i) => results[i].policyNav));
    const floorBind = m.idxs.some((i) => results[i].ownFloorBind);
    for (const g of m.groups) {
      const reasons = [];
      g.perLister = new Map();
      for (const i of g.listers) {
        const r = results[i];
        const listing = g.listings.find((l) => l.i === i);
        const rec = recordFor(i, r.penaltyDetail.attempts[listing.k]);
        const attStatus = rec && typeof rec.attempting_status === "string" ? rec.attempting_status : r.status;
        const attPolicy = rec && isNum(rec.attempting_policy_nav) ? rec.attempting_policy_nav : r.policyNav;
        const attLargest = rec && isNum(rec.largest_policy_nav) ? rec.largest_policy_nav : largest;
        const attOpen = rec && isNum(rec.attempting_open_loans) ? rec.attempting_open_loans : r.counts.open;
        if (attOpen === 0 || shellStatuses.has(attStatus)) reasons.push(`shell: ${attOpen === 0 ? "empty" : attStatus}`);
        else if (attLargest > 0 && attPolicy < THRESHOLDS.shellShare * attLargest) reasons.push("shell: policy nav under 10% of manager's largest fund");
        g.perLister.set(i, { policyShare: attLargest > 0 ? attPolicy / attLargest : null, sizeSource: rec ? "verifier record" : "current" });
      }
      // Hole 4 (decided by owner 6 Nov 2026 13:32): rank attempts by age, then action_id. An attempt escalates
      // only against strictly earlier attempts (older, or the same age with a lower action_id) within 90 days,
      // so two same-day attempts give one first and one second.
      const earlier = m.groups.filter(
        (b) => b !== g && (b.age > g.age || (b.age === g.age && String(b.action_id) < String(g.action_id))) && b.age - g.age <= THRESHOLDS.managerWindowDays,
      );
      if (earlier.length >= 1) reasons.push("2+ attempts in 90 days");
      if (floorBind) reasons.push("floor bind on a manager fund");
      g.reasons = [...new Set(reasons)];
      g.managerWide = g.reasons.length > 0;
    }
    for (const i of m.idxs) {
      const r = results[i];
      for (const g of m.groups) {
        if (g.listers.includes(i)) {
          const mine = g.listings.find((l) => l.i === i);
          // I1: every listing fund warns when the shared attempt's effective (youngest) age is within 90 days.
          if (g.listers.length > 1 && g.age <= THRESHOLDS.managerWindowDays) r.managerWarning = true;
          const pl = g.perLister.get(i);
          r.penaltyDetail.ownAttemptsManagerWide.push({
            action_id: g.action_id, managerWide: g.managerWide, reasons: g.reasons, age_days: g.age,
            listed_age_days: mine.listedAge, listedBy: g.listers.map((j) => results[j].fundId),
            policyShareOfLargest: pl.policyShare, sizeSource: pl.sizeSource, manager: m.mgr,
          });
        } else {
          if (g.age <= THRESHOLDS.managerWindowDays) r.managerWarning = true;
          if (g.managerWide) extra[i].push({ g, mgr: m.mgr });
        }
      }
    }
  }

  results.forEach((r, i) => {
    if (!extra[i].length) return;
    const add = extra[i].reduce((s, x) => s + x.g.cost, 0);
    r.pillars.penalty += add;
    r.penaltyDetail.sibling = add;
    r.penaltyDetail.managerWide = true;
    r.penaltyDetail.managerWideReasons = [...new Set(extra[i].flatMap((x) => x.g.reasons))];
    r.penaltyDetail.siblingAttempts = extra[i].map((x) => {
      // I2: from is one fund_id, the youngest listing fund (ties broken by fund_id); listedBy names all listers.
      const ranked = [...x.g.listings].sort((a, b) => a.listedAge - b.listedAge || String(results[a.i].fundId).localeCompare(String(results[b.i].fundId)));
      return {
        from: results[ranked[0].i].fundId, listedBy: x.g.listers.map((j) => results[j].fundId), action_id: x.g.action_id,
        age_days: x.g.age, cost: x.g.cost, reasons: x.g.reasons, manager: x.mgr,
      };
    });
    if (extra[i].some((x) => x.g.age <= THRESHOLDS.noGreenDays)) r.noGreenCap = true;
    finalize(r);
  });
  results.forEach((r) => {
    r.floorBind = r.ownFloorBind; // floor bind is read from the own-penalty pass
    delete r.ownFloorBind;
  });
  return results;
}
