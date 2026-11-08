// Mock bank-data API feed (cashflow/mockbank) to the settled schema (spec/v2/SPEC.md section 3.3).
// The feed follows the common bank-aggregator convention: a positive amount is money leaving the account. The
// adapter flips the sign (credits > 0), pseudonymizes the counterparty, maps the category to a kind hint, and keeps
// pending transactions out (only posted transactions are settled cash).
import { payerRef } from "../pseudo.mjs";

const KIND = {
  RENT: "rent",
  LOAN_PAYMENT: "loan_payment",
  SECURITY_DEPOSIT: "security_deposit",
  OWNER_TRANSFER: "owner_transfer",
  LOAN_PROCEEDS: "loan_proceeds",
  REFUND: "refund",
  EXPENSE: "expense",
  DISTRIBUTION: "distribution",
};

export function settledFromFeed(feed, key) {
  if (!feed || !Array.isArray(feed.transactions)) throw new Error("feed has no transactions array");
  const out = [];
  for (const t of feed.transactions) {
    if (t.pending) continue;
    if (!Number.isSafeInteger(t.amount_cents)) throw new Error(`transaction ${t.transaction_id}: amount_cents must be integer`);
    out.push({
      txn_id: String(t.transaction_id),
      posted_date: t.date,
      amount_cents: -t.amount_cents,
      counterparty_ref: payerRef(key, t.counterparty || "UNKNOWN"),
      kind_hint: KIND[t.category] || "unknown",
      reversal_of: t.reversal_of ? String(t.reversal_of) : null,
    });
  }
  return out;
}
