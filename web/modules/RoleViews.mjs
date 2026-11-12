import { createElement as h } from "react";
import { formatUsdFromCents, shortHash } from "./format.mjs";
import { Empty, Panel, SourceChip } from "./ui.mjs";

function rangeLabel(cert) {
  if (!cert) return "No certificate.";
  const headline = Number(cert.headline_cents);
  const tv = Number(cert.true_val_cents);
  const tr = Number(cert.true_range_cents);
  if (headline > tv + tr) return "Reported NAV is above TrueRange.";
  if (headline < tv - tr) return "Reported NAV is below TrueRange.";
  return "Reported NAV is inside TrueRange.";
}

export function InvestorView({ funds = [], alerts = [] }) {
  const rows = funds.filter((f) => f.on_chain !== false).slice().sort((a, b) => (b.anchors.certificate.score ?? -1) - (a.anchors.certificate.score ?? -1));
  return h("div", { id: "tn-investor" },
    h(Panel, {
      title: "Can I trust this NAV?",
      kicker: "Investor",
      mix: "recorded",
      note: "Same public data as the other roles. No access control. Watchlist storage is the shell's job and stays in the browser. README: TrueNav informs only and does not move funds.",
    },
    rows.length ? rows.map((f) => h("article", { key: f.fund_id, style: { marginBottom: "12px" } },
      h("h3", null, f.profile.name, " ", h(SourceChip, { tag: f.anchors.certificate.band || "recorded" })),
      h("p", null, `Score ${f.anchors.certificate.score}. TrueVal ${formatUsdFromCents(f.anchors.certificate.true_val_cents)}. Reported NAV ${formatUsdFromCents(f.anchors.certificate.headline_cents)}. ${rangeLabel(f.anchors.certificate)}`),
      h("p", { className: "tn-note" }, "TrueVal is a model estimate, not fair value. TrueRange assumes independent defaults (README, The three numbers)."))) : h(Empty, null, "No funds."),
    h("h3", null, "Alerts"),
    alerts.length ? h("ul", null, alerts.map((a) => h("li", { key: a.id || a.text }, a.text))) : h(Empty, null, "No alert text was passed in. The shell should pass get_alerts_page.")));
}

export function ManagerView({ fund, lensNote }) {
  if (!fund) return h(Panel, { title: "Fund manager" }, h(Empty, null, "Pick a fund to view as."));
  const cert = fund.anchors.certificate;
  const loans = fund.loans || [];
  return h("div", { id: "tn-manager" },
    h(Panel, {
      title: `View as ${fund.profile.name}`,
      kicker: "Fund manager",
      mix: "recorded",
      note: "This view does not send a transaction. Pledges need a fresh servicer signature and are sent by the fund account (contract pledge_loan). In this demo the servicer is TrueNav Labs.",
    },
    h("p", null, `NAV on record: headline ${formatUsdFromCents(cert.headline_cents)}, policy ${formatUsdFromCents(cert.policy_nav_cents)}. ${rangeLabel(cert)}`),
    h("p", { className: "tn-note" }, "There is no NAV submit method. The headline sits inside the certificate. A manager-signed NAV is not built (README, what mainnet would change, and the dashboard spec roadmap)."),
    h("h3", null, "What is public"),
    h("ul", null,
      h("li", null, `Fund id ${fund.fund_id}, account ${fund.anchors.fund_account}.`),
      h("li", null, `${fund.anchors.loan_hashes.length} pledge token hashes. Asset type is on the token. Per-loan principal is not a chain field.`),
      h("li", null, "Attempts, alerts, verdicts and certificates are public chain state (README, Security and limits)."),
      h("li", null, lensNote || "The data room lens is demo. It is not what an outsider reads from the chain.")),
    h("h3", null, "Loans"),
    h("ul", null, loans.map((l) => h("li", { key: l.loan_hash || l.data_room.loan_id, className: "tn-mono" },
      `${l.data_room.loan_id} ${shortHash(l.loan_hash)} ${l.asset_type} verdict ${l.verdict || "none"}`))),
    h("p", { className: "tn-note" }, `Blocked attempts on the certificate pin: ${cert.blocked_attempts}. The list itself is get_attempts_page, which this module does not call.`)));
}

export function AuditorView({ funds = [], feedsNote }) {
  return h("div", { id: "tn-auditor" },
    h(Panel, {
      title: "Re-check it",
      kicker: "Auditor",
      mix: "recorded",
      note: "Commands below are the ones named in the README. This module does not run them.",
    },
    h("ul", null,
      h("li", null, "npm run chain:read recomputes both scores from chain data."),
      h("li", null, "npm run verify:attestation checks the published attestation report."),
      h("li", null, "npm test runs the repository suite. The demo consistency test is web/data/demo/consistency.test.mjs."),
      h("li", null, "Engine: engine/src/score.mjs. Fixtures: spec/nav/fixtures.json. Loan hashes: tee/loans.json.")),
    h("h3", null, "Certificate pins in this bundle"),
    funds.filter((f) => f.on_chain !== false).map((f) => h("p", { key: f.fund_id, className: "tn-mono" },
      `${f.fund_id} raw_x100 ${f.anchors.certificate.raw_x100} TrueVal ${f.anchors.certificate.true_val_cents} cents`)),
    h("p", { className: "tn-note" }, feedsNote || "Market feeds are external context. They are not an audit of the score."),
    h("p", { className: "tn-note" }, "Known limits are listed in README, Known limits and disclosures. Image measurements are not pinned. The certificate key is a test key, not a TEE key.")));
}
