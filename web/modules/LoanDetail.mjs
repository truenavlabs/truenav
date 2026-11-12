import { createElement as h } from "react";
import { bpsToPct, formatUsdFromCents, shortHash } from "./format.mjs";
import { Banner, Panel, SourceChip } from "./ui.mjs";

export function LoanDetail({ loan, lens = "data_room", outOfSync }) {
  if (!loan) return h(Panel, { title: "Loan" }, h("p", { className: "tn-empty" }, "Unknown loan hash."));
  const d = loan.data_room || {};
  const showRoom = lens === "data_room" && !outOfSync;
  const checks = d.checks;
  return h(Panel, {
    id: "tn-loan-detail",
    title: showRoom ? (d.loan_id || "Loan") : shortHash(loan.loan_hash),
    mix: showRoom ? "demo" : "recorded",
    note: loan.public_sources && loan.public_sources.verdict,
  },
  h("dl", { className: "tn-kv" },
    h("dt", null, "Loan hash"),
    h("dd", { className: "tn-mono" }, loan.loan_hash || "No pledge token"),
    h("dt", null, "Asset"),
    h("dd", null, loan.asset_type || ""),
    h("dt", null, "Verdict"),
    h("dd", null, loan.verdict || "none", " ", h(SourceChip, { tag: loan.public_tags && loan.public_tags.verdict || "recorded" })),
    h("dt", null, "Pledged at"),
    h("dd", null, "Read live from nft_token. Not stored in the demo file.")),
  checks ? h("div", null,
    h("p", { className: "tn-check" }, checks.line),
    h("p", { className: "tn-note" }, checks.citation)) : null,
  showRoom ? h(Room, { loan }) : h("p", { className: "tn-note" }, "Public lens. Principal, borrower and documents stay off this view."),
  outOfSync ? h(Banner, null, outOfSync) : null);
}

function Room({ loan }) {
  const d = loan.data_room;
  const rec = d.recorded;
  const demo = d.demo;
  const eng = d.engine;
  return h("div", null,
    h(Banner, null, "Demo data room. In production only the manager and the enclave see this. Here it is fictional so you can see what TrueNav checks."),
    h("dl", { className: "tn-kv" },
      row("Borrower", rec.borrower_alias),
      row("Sector", demo.sector),
      row("Geography", demo.geography ? `${demo.geography.country}, ${demo.geography.region}` : ""),
      row("Principal", formatUsdFromCents(rec.principal_cents)),
      row("Accrued", formatUsdFromCents(rec.accrued_cents)),
      row("Coupon", rec.coupon_bps == null ? "n/a" : bpsToPct(rec.coupon_bps)),
      row("LTV", demo.ltv_bps == null ? "n/a" : bpsToPct(demo.ltv_bps)),
      row("Advance", demo.advance_rate_bps == null ? "n/a" : bpsToPct(demo.advance_rate_bps)),
      row("DSCR", demo.dscr == null ? "" : String(demo.dscr)),
      row("Bucket", rec.bucket),
      row("Days past due", String(rec.dpd)),
      row("Status", demo.status),
      row("Origination", rec.origination_date || ""),
      row("Maturity", demo.maturity_date || ""),
      row("EAD", formatUsdFromCents(eng.ead_cents)),
      row("Mark", formatUsdFromCents(eng.mark_cents)),
      row("Expected loss", formatUsdFromCents(eng.expected_loss_cents)),
      row("In TrueVal", eng.verified ? "yes" : `no, ${eng.reason || ""}`)),
    d.documents && d.documents.length ? h("p", { className: "tn-note" },
      `Document type on file: ${d.documents.map((doc) => `${doc.type}, enclave ${doc.enclave_verdict || "n/a"}`).join("; ")}. ${d.documents[0].source || ""}`) : null,
    rec.fixture_note ? h("p", { className: "tn-note" }, `Fixture note: ${rec.fixture_note}`) : null);
}

function row(label, value) {
  return [h("dt", { key: `${label}-k` }, label), h("dd", { key: `${label}-v` }, value)];
}
