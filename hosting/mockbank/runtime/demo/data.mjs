// Synthetic demo datasets (spec/v2/SPEC.md section 12). Every fund, borrower, tenant, manager and amount is
// fictional; there is no real platform or provider data. Deterministic: the same call gives the same bytes.
// Each dataset holds what each source would deliver: the servicer or property-manager export, the mock bank-data
// feed (bank-aggregator sign convention: positive = money out), and the issuer's public claims.
// Real timestamps of 8 Nov 2026 (no future time): the exports were taken at 06:00 UTC, the bank feed fetched at
// 08:30 and the run made at 09:00, so every source covers through 7 Nov, October's collection cutoff (spec 5.7).
// The reporting period is October; the exports also hold the November dues and the payments made so far.
export const RUN_AS_OF = "2026-11-08T09:00:00Z";
export const BANK_FETCHED_AT = "2026-11-08T08:30:00Z";
export const EXPORT_AS_OF = "2026-11-08T06:00:00Z";
export const AS_OF = RUN_AS_OF.slice(0, 10);
export const PERIOD = "2026-10";
export const DAYS_IN_PERIOD = 31;
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11"];
const pad = (n) => String(n).padStart(2, "0");
const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

/**
 * Credit fund. Loans pay monthly interest in cash, or are PIK (interest capitalized, no cash due). `missed[i]` lists
 * the months loan i did not pay; `falseClaims[i]` lists months the servicer reports a payment the bank never saw.
 */
function creditFund({ id, name, n, principal, rate_bps, pik = [], missed = {}, falseClaims = {}, reported_yield_bps }) {
  const interest = Math.round((principal * rate_bps) / 10000 / 12);
  const loans = [];
  const schedule = [];
  const payments = [];
  const transactions = [];
  for (let i = 0; i < n; i++) {
    const loan_id = `${id}-L${pad(i)}`;
    const payer = `Borrower ${pad(i)} LLC`;
    const isPik = pik.includes(i);
    loans.push({ loan_id, borrower_payer: payer, principal_cents: principal, rate_bps, pay_type: isPik ? "pik" : "cash" });
    if (isPik) continue;
    for (const m of MONTHS) {
      const due_date = `${m}-01`;
      schedule.push({ loan_id, due_date, component: "interest", amount_cents: interest });
      const paid = !(missed[i] || []).includes(m);
      const falseClaim = (falseClaims[i] || []).includes(m);
      if (paid || falseClaim) payments.push({ payment_id: `${loan_id}-${m}`, loan_id, paid_date: addDays(due_date, 1), amount_cents: interest, status: "paid" });
      if (paid) transactions.push({ transaction_id: `bk-${loan_id}-${m}`, date: addDays(due_date, 2), amount_cents: -interest, counterparty: payer, category: "LOAN_PAYMENT", pending: false });
    }
  }
  const total = principal * n;
  const pikInterest = pik.length * interest;
  return {
    id,
    name,
    kind: "credit",
    synthetic: true,
    servicer_tape: { as_of: EXPORT_AS_OF, loans, schedule, payments },
    bank_feed: { synthetic: true, account_id: `${id}-operating`, transactions },
    issuer: { token_id: id, as_of: EXPORT_AS_OF, period: PERIOD, reported_yield_bps, principal_outstanding_cents: total + pikInterest, accrued_interest_cents: n * interest, capitalized_interest_cents: pikInterest },
  };
}

/**
 * Rental token. `unpaid[u]` lists months unit u did not pay. Options add the edge cases: a batched manager deposit,
 * a bounced payment, a duplicated bank line, a security deposit, a sponsor transfer before the payout.
 */
function rentalToken({ id, name, units, rent, vacant = [], unpaid = {}, batch = [], bounced = [], duplicate = [], securityDeposit = null, sponsor = 0, expenses, reserves, distribution }) {
  const unitsOut = [];
  const charges = [];
  const ledger = [];
  const transactions = [];
  const manager = `${name} Property Services`;
  let batchSum = 0;
  for (let u = 0; u < units; u++) {
    const unit_id = `${id}-U${pad(u)}`;
    const occupied = !vacant.includes(u);
    const tenant = occupied ? `Tenant ${id} ${pad(u)}` : null;
    unitsOut.push({ unit_id, occupied, tenant_payer: tenant, rent_cents: rent });
    if (!occupied) continue;
    for (const m of MONTHS) {
      const due_date = `${m}-01`;
      charges.push({ unit_id, due_date, amount_cents: rent });
      if ((unpaid[u] || []).includes(m)) continue;
      const inBatch = m === "2026-10" && batch.includes(u);
      ledger.push({ entry_id: `${unit_id}-${m}`, unit_id, paid_date: addDays(due_date, 2), amount_cents: rent, status: "paid", batch_ref: inBatch ? `${id}-B-OCT` : null });
      if (inBatch) {
        batchSum += rent;
        continue;
      }
      const tx = { transaction_id: `bk-${unit_id}-${m}`, date: addDays(due_date, 3), amount_cents: -rent, counterparty: tenant, category: "RENT", pending: false };
      transactions.push(tx);
      if (m === "2026-10" && duplicate.includes(u)) transactions.push({ ...tx });
      if (m === "2026-10" && bounced.includes(u)) transactions.push({ transaction_id: `bk-${unit_id}-${m}-return`, date: addDays(due_date, 9), amount_cents: rent, counterparty: tenant, category: "REFUND", pending: false, reversal_of: tx.transaction_id });
    }
  }
  if (batchSum) transactions.push({ transaction_id: `bk-${id}-batch-oct`, date: "2026-10-04", amount_cents: -batchSum, counterparty: manager, category: "RENT", pending: false });
  if (securityDeposit !== null) transactions.push({ transaction_id: `bk-${id}-deposit`, date: "2026-10-12", amount_cents: -rent, counterparty: `New tenant ${id} ${pad(securityDeposit)}`, category: "SECURITY_DEPOSIT", pending: false });
  transactions.push({ transaction_id: `bk-${id}-expenses-oct`, date: "2026-10-15", amount_cents: expenses, counterparty: manager, category: "EXPENSE", pending: false });
  if (sponsor) transactions.push({ transaction_id: `bk-${id}-sponsor-oct`, date: "2026-10-27", amount_cents: -sponsor, counterparty: `${name} Sponsor LP`, category: "OWNER_TRANSFER", pending: false });
  transactions.push({ transaction_id: `bk-${id}-payout-oct`, date: "2026-10-30", amount_cents: distribution, counterparty: `${name} token holders`, category: "DISTRIBUTION", pending: false });
  transactions.push({ transaction_id: `bk-${id}-pending`, date: "2026-10-31", amount_cents: -rent, counterparty: "Unknown sender", category: "RENT", pending: true });
  const occupied = units - vacant.length;
  return {
    id,
    name,
    kind: "rental",
    synthetic: true,
    manager_export: { as_of: EXPORT_AS_OF, units: unitsOut, charges, ledger },
    bank_feed: { synthetic: true, account_id: `${id}-operating`, transactions },
    issuer: { token_id: id, as_of: EXPORT_AS_OF, period: PERIOD, occupancy_bps: Math.round((10000 * occupied) / units), expenses_cents: expenses, reserves_cents: reserves, distributions_paid_cents: distribution },
  };
}

export function datasets() {
  return [
    creditFund({
      id: "DEMO-CREDIT",
      name: "Ashgrove Private Credit Fund",
      n: 20,
      principal: 50_000_000,
      rate_bps: 1100,
      pik: [11, 12, 13, 14, 15, 16],
      missed: { 17: ["2026-09", "2026-10", "2026-11"], 18: ["2026-09", "2026-10", "2026-11"], 19: ["2026-09", "2026-10", "2026-11"] },
      falseClaims: { 17: ["2026-10"], 18: ["2026-10"] },
      reported_yield_bps: 1100,
    }),
    rentalToken({
      id: "DEMO-RENTAL",
      name: "Larkspur Residences",
      units: 24,
      rent: 200_000,
      vacant: [23],
      unpaid: { 19: ["2026-09", "2026-10", "2026-11"], 20: ["2026-10", "2026-11"], 21: ["2026-08", "2026-09", "2026-10", "2026-11"], 22: ["2026-10", "2026-11"] },
      batch: [0, 1, 2, 3, 4],
      bounced: [18],
      duplicate: [5],
      securityDeposit: 22,
      sponsor: 600_000,
      expenses: 1_200_000,
      reserves: 400_000,
      distribution: 3_000_000,
    }),
    creditFund({ id: "HONEST-CREDIT", name: "Kestrel Lending Fund", n: 20, principal: 50_000_000, rate_bps: 1100, missed: { 19: ["2026-10"] }, reported_yield_bps: 1080 }),
    rentalToken({ id: "HONEST-RENTAL", name: "Linden Court", units: 24, rent: 200_000, vacant: [23], unpaid: { 22: ["2026-10"] }, expenses: 1_000_000, reserves: 300_000, distribution: 2_500_000 }),
  ];
}
