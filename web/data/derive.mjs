// Pure functions over a loadRegistry() result. No I/O, no framework. Money stays in integer cents (BigInt-safe
// strings on chain); the layout formats it. Every derived value says which tag it carries.

export const BANDS = Object.freeze({ green: 85, yellow: 60 }); // green 85 and up, yellow 60 to 84, red below 60
export const bandOf = (score) => (score === null || score === undefined ? null : score >= BANDS.green ? "green" : score >= BANDS.yellow ? "yellow" : "red");

const n = (cents) => (cents === null || cents === undefined ? null : Number(cents));

/** TrueRange low and high from the certificate (computed from live). */
export function rangeOf(cert) {
  if (!cert) return null;
  const tv = n(cert.true_val_cents), r = n(cert.true_range_cents);
  return { trueVal: tv, half: r, low: tv - r, high: tv + r };
}

/** Where a NAV sits against the range: "inside", "above" or "below". */
export function navPosition(navCents, range) {
  if (navCents === null || !range) return null;
  if (navCents > range.high) return "above";
  if (navCents < range.low) return "below";
  return "inside";
}

/** Verdict freshness at `now`: "current", "expired" or "none". Same boundary as the contract: expiry equal to now is current. */
export function verdictState(latest, now) {
  if (!latest) return "none";
  return now <= Number(latest.expires_at_ms) ? "current" : "expired";
}

/** One row per fund for tables and cards. */
export function fundSummary(reg, fundId, now = Date.now()) {
  const row = (reg.funds || []).find((f) => f.fund_id === fundId);
  if (!row) return null;
  const stored = row.certificate;
  const cert = stored ? stored.certificate : null;
  const range = rangeOf(cert);
  const loans = (reg.loans || []).filter((l) => (l.lock ? l.lock.fund_id === fundId : row.fund && l.owner_id === row.fund.account_id));
  const verdicts = { pass: 0, flag: 0, none: 0, expired: 0 };
  for (const l of loans) {
    const st = verdictState(l.latest, now);
    if (st === "none") verdicts.none++;
    else if (st === "expired") verdicts.expired++;
    else if (l.latest.verdict === "pass") verdicts.pass++;
    else verdicts.flag++;
  }
  const byAsset = {};
  for (const l of loans) byAsset[l.asset_type || "unknown"] = (byAsset[l.asset_type || "unknown"] || 0) + 1;
  const headline = cert ? n(cert.headline_cents) : null;
  const policy = cert ? n(cert.policy_nav_cents) : null;
  const expiries = loans.map((l) => (l.latest ? Number(l.latest.expires_at_ms) : null)).filter((x) => x !== null);
  return {
    fund_id: fundId, registered: !!row.fund, account_id: row.fund ? row.fund.account_id : null, manager_id: row.fund ? row.fund.manager_id : null,
    score: cert ? cert.score : null, band: cert ? cert.band : null, rawX100: cert ? cert.raw_x100 : null, status: cert ? cert.status : null,
    trueVal: range ? range.trueVal : null, range, headline, policy,
    headlinePosition: navPosition(headline, range), policyPosition: navPosition(policy, range),
    gapCents: headline !== null && range ? (headline > range.high ? headline - range.high : headline < range.low ? headline - range.low : 0) : null,
    loans: loans.length, byAsset, verdicts, flagsEver: loans.reduce((s, l) => s + (l.flagCount || 0), 0),
    attempts: row.attempts ? row.attempts.count : null, attemptList: row.attempts ? row.attempts.attempts : [],
    alerts: row.alertCount, alertList: row.alerts || [],
    certCount: row.certCount, certHistory: row.certHistory || [],
    signedAt: cert ? cert.signed_at_ms : null, dataAsOf: cert ? cert.data_asof_ms : null, storedAt: stored ? stored.stored_at_ms : null,
    certSigner: stored ? stored.signer : null, engineCommit: cert ? cert.engine_commit : null,
    verdictsValidUntil: expiries.length ? Math.min(...expiries) : null,
    blockedAttemptsInCert: cert ? cert.blocked_attempts : null,
  };
}

export const fundSummaries = (reg, now) => (reg.funds || []).map((f) => fundSummary(reg, f.fund_id, now)).filter(Boolean);

/** Overview tiles. */
export function overviewKpis(reg, now = Date.now()) {
  const fs = fundSummaries(reg, now);
  const sum = (k) => fs.reduce((s, f) => s + (f[k] || 0), 0);
  const loans = reg.loans || [];
  return {
    funds: fs.filter((f) => f.registered).length,
    trueValCovered: sum("trueVal"),
    headlineCovered: sum("headline"),
    pledged: reg.totalSupply,
    verdictsPass: loans.filter((l) => verdictState(l.latest, now) === "current" && l.latest.verdict === "pass").length,
    verdictsFlag: loans.filter((l) => verdictState(l.latest, now) === "current" && l.latest.verdict !== "pass").length,
    verdictsExpired: loans.filter((l) => verdictState(l.latest, now) === "expired").length,
    blocked: sum("attempts"),
    alerts: sum("alerts"),
    teeSigners: Array.isArray(reg.teeSigners) ? reg.teeSigners.length : null,
    outsideRange: fs.filter((f) => f.headlinePosition && f.headlinePosition !== "inside").length,
  };
}

/** On-chain activity events, newest first: pledges, verdicts, certificates, blocked attempts, signer registration. */
export function activity(reg) {
  const ev = [];
  for (const l of reg.loans || []) {
    if (l.issued_at_ms) ev.push({ at: l.issued_at_ms, kind: "pledge", fund_id: l.fund_id, ref: l.loan_hash, text: `Loan pledged (${(l.asset_type || "").replace("_", " ")})` });
    if (l.latest) ev.push({ at: Number(l.latest.at_ms), kind: "verdict", fund_id: l.fund_id, ref: l.loan_hash, text: `Enclave verdict stored: ${l.latest.verdict}` });
  }
  for (const f of reg.funds || []) {
    if (f.certificate) ev.push({ at: Number(f.certificate.stored_at_ms), kind: "certificate", fund_id: f.fund_id, text: `Certificate stored: score ${f.certificate.certificate.score} ${f.certificate.certificate.band}` });
    for (const a of (f.attempts && f.attempts.attempts) || []) ev.push({ at: Number(a.at_ms), kind: "blocked", fund_id: f.fund_id, ref: a.attempt_id, text: "Double pledge refused; blocked attempt and alert recorded" });
  }
  for (const t of reg.teeSigners || []) ev.push({ at: Number(t.registered_at_ms), kind: "signer", text: `TEE signer registered (${t.model_id})`, ref: t.address });
  return ev.filter((e) => Number.isFinite(e.at)).sort((a, b) => b.at - a.at);
}

/** Loans per asset type per fund, for the asset chart. */
export function assetSplit(reg) {
  const out = {};
  for (const l of reg.loans || []) {
    const f = l.fund_id || l.owner_id;
    out[f] = out[f] || {};
    out[f][l.asset_type || "unknown"] = (out[f][l.asset_type || "unknown"] || 0) + 1;
  }
  return out;
}

/** Age of a read in ms, and whether the session cache should be called stale (spec: 5 minutes). */
export const STALE_MS = 5 * 60 * 1000;
export function freshness(readAtIso, now = Date.now()) {
  const age = now - Date.parse(readAtIso);
  return { ageMs: age, stale: age > STALE_MS };
}

/** The headline data state for the top bar pill. */
export function dataState(reg, now = Date.now()) {
  if (!reg) return { state: "loading" };
  if (reg.state === "offline") return { state: "offline" };
  const f = freshness(reg.readAt, now);
  if (f.stale) return { state: "stale", readAt: reg.readAt, block: reg.block };
  return { state: reg.state, readAt: reg.readAt, block: reg.block };
}
