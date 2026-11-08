// Severe-arrears variant of a synthetic rental fund, for the receipt contract tests and the sandbox e2e: every rent
// payment is removed (the manager's payment ledger and the bank's RENT rows), so no rent is paid from August on and
// the arrears are several months of rent. Rental late_share_bps is all arrears 60+ days late over one period's rent
// due, so it legitimately exceeds 10000 (HONEST-RENTAL: 40000). Expenses and distributions stay as they are.
export function severeArrears(dataset) {
  const ds = structuredClone(dataset);
  ds.manager_export.ledger = [];
  ds.bank_feed.transactions = ds.bank_feed.transactions.filter((t) => t.category !== "RENT");
  return ds;
}
