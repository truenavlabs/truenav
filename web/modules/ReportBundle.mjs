import { createElement as h, useState } from "react";
import { formatUsdFromCents, shortHash } from "./format.mjs";
import { bundleFileName, buildReportBundle } from "./report.mjs";

export function ReportBundle({ fund, bundle, readAt, onDownload }) {
  const [local, setLocal] = useState(bundle || null);
  const [error, setError] = useState("");
  const cert = fund && fund.anchors && fund.anchors.certificate;
  const active = local || bundle;
  async function make() {
    try {
      const next = await buildReportBundle({
        fund: fund && { fund_id: fund.fund_id, name: fund.profile && fund.profile.name, on_chain: fund.on_chain },
        certificate: cert || null,
        derived: cert ? {
          true_range_low_cents: String(Number(cert.true_val_cents) - Number(cert.true_range_cents)),
          true_range_high_cents: String(Number(cert.true_val_cents) + Number(cert.true_range_cents)),
          tag: "computed",
        } : null,
        loans: (fund && fund.loans || []).map((l) => ({
          loan_hash: l.loan_hash,
          asset_type: l.asset_type,
          verdict: l.verdict,
          loan_id: l.data_room && l.data_room.loan_id,
          verified: l.data_room && l.data_room.engine && l.data_room.engine.verified,
          tag: "demo loan id, recorded hash",
        })),
        readAt: readAt || null,
        sourceTags: ["recorded", "computed", "demo"],
      });
      setLocal(next);
      if (onDownload) onDownload(next);
      return next;
    } catch (err) {
      setError(err && err.message ? err.message : "Could not build the bundle.");
      return null;
    }
  }
  return h("div", { id: "tn-report" },
    h("div", { className: "tn-noprint tn-controls" },
      h("button", { type: "button", className: "tn-btn", onClick: () => make() }, "Build JSON bundle"),
      h("button", {
        type: "button",
        className: "tn-btn",
        onClick: () => {
          const run = active ? Promise.resolve(active) : make();
          Promise.resolve(run).then((doc) => doc && downloadJson(bundleFileName(fund && fund.fund_id, readAt), doc));
        },
      }, "Download JSON"),
      h("button", { type: "button", className: "tn-btn", onClick: () => { if (typeof window !== "undefined" && window.print) window.print(); } }, "Print")),
    error ? h("p", { className: "tn-note" }, error) : null,
    h(ReportSheet, { fund, bundle: active }));
}

export function ReportSheet({ fund, bundle }) {
  if (!fund) return h("article", { className: "tn-report" }, h("p", null, "No fund was passed to the report."));
  const cert = fund.anchors.certificate;
  const low = Number(cert.true_val_cents) - Number(cert.true_range_cents);
  const high = Number(cert.true_val_cents) + Number(cert.true_range_cents);
  const limits = bundle && bundle.limits || [];
  const how = bundle && bundle.how_to_verify || [];
  return h("article", { className: "tn-report" },
    h("p", { className: "tn-kicker" }, "TrueNav Labs"),
    h("h2", null, `${fund.profile.name} report`),
    h("p", null, "Testnet demo. Funds, loans and documents are fictional. This sheet is the print source. Save as PDF from the print dialog. A PDF library is not included."),
    h("h3", null, "Summary"),
    h("table", null,
      h("tbody", null,
        line("Fund", fund.fund_id),
        line("Score", `${cert.score} ${cert.band} (raw_x100 ${cert.raw_x100})`),
        line("Reported NAV", formatUsdFromCents(cert.headline_cents)),
        line("Policy NAV", formatUsdFromCents(cert.policy_nav_cents)),
        line("TrueVal", formatUsdFromCents(cert.true_val_cents)),
        line("TrueRange", `${formatUsdFromCents(String(low))} to ${formatUsdFromCents(String(high))}`))),
    h("h3", null, "Loans"),
    h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Loan"), h("th", null, "Hash"), h("th", null, "Asset"), h("th", null, "In TrueVal"))),
      h("tbody", null, (fund.loans || []).map((l) => h("tr", { key: l.data_room.loan_id },
        h("td", null, l.data_room.loan_id),
        h("td", null, shortHash(l.loan_hash)),
        h("td", null, l.asset_type),
        h("td", null, l.data_room.engine.verified ? "yes" : l.data_room.engine.reason || "no"))))),
    limits.length ? h("h3", null, "Limits") : null,
    limits.length ? h("ul", null, limits.map((item) => h("li", { key: item.source }, `${item.text} (${item.source})`))) : null,
    how.length ? h("h3", null, "How to verify") : null,
    how.length ? h("ol", null, how.map((step) => h("li", { key: step }, step))) : null,
    bundle ? h("p", null, h("b", null, "Bundle section hashes"), h("br"), h("span", { className: "tn-mono" }, JSON.stringify(bundle.manifest.sha256))) : h("p", null, "JSON bundle not built yet."));
}

function line(k, v) {
  return h("tr", { key: k }, h("th", null, k), h("td", { className: "num" }, v));
}

function downloadJson(name, doc) {
  if (typeof document === "undefined" || typeof Blob === "undefined") return;
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
