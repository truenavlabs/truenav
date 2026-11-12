// Renders the depth modules to a static HTML page for local review.
//   node web/modules/harness/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEEDS, presentFeed } from "../../data/feeds/feeds.mjs";
import { marketsModel, tickerItems } from "../../data/feeds/view.mjs";
import { buildReportBundle } from "../report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
await register(new URL("./react-loader.mjs", import.meta.url), import.meta.url);
const { renderToHtml } = await import("./react-shim.mjs");
const { createElement: h } = await import("react");
const ui = await import("../index.mjs");

const demo = JSON.parse(readFileSync(join(here, "../../data/demo/funds.demo.json"), "utf8"));
const snap = JSON.parse(readFileSync(join(here, "../../public/feeds/snapshot.json"), "utf8"));
const feeds = {};
for (const [id, row] of Object.entries(snap.feeds)) {
  if (!Object.prototype.hasOwnProperty.call(FEEDS, id)) {
    feeds[id] = { ...row, chip: row.mode === "error" ? "unavailable" : "snapshot", dim: row.mode !== "error", stale: true };
    continue;
  }
  feeds[id] = presentFeed({ id, snapshot: row, now: Date.parse(snap.generatedAt) });
}
const meridian = demo.funds.find((f) => f.fund_id === "meridian-yield-fund");
const min03 = meridian.loans.find((l) => l.data_room.loan_id === "M-IN-03");
const ashgrove = demo.demo_funds.find((f) => f.fund_id === "DEMO-CREDIT");
const bundle = await buildReportBundle({
  fund: { fund_id: meridian.fund_id, name: meridian.profile.name, on_chain: true },
  certificate: meridian.anchors.certificate,
  loans: meridian.loans.map((l) => ({ loan_hash: l.loan_hash, loan_id: l.data_room.loan_id })),
  readAt: snap.generatedAt,
  sourceTags: ["recorded", "computed", "demo", "external"],
});
const css = readFileSync(join(here, "../terminal.css"), "utf8");
const body = renderToHtml(h("div", { className: "tn-root" },
  h("header", null,
    h("p", { className: "tn-kicker" }, "TrueNav Labs"),
    h("h1", null, "Depth modules harness"),
    h("p", { className: "tn-note" }, "Static render for review. Testnet demo. Funds, loans and documents are fictional. Market data is a committed snapshot and is context only.")),
  h(ui.MarketTicker, { items: tickerItems(feeds) }),
  h(ui.MarketsPanels, { model: marketsModel(feeds), feeds }),
  h(ui.NavHistoryChart, { points: meridian.nav_history }),
  h(ui.ExposurePanel, { exposures: meridian.exposures, concentration: meridian.why_score.concentration }),
  h(ui.CashFlowPanel, { cashFlows: meridian.cash_flows }),
  h(ui.CashFlowPanel, { cashFlows: { tag: "demo", monthly: [], rule: "Ashgrove is a cash-flow demo fund, not on chain." }, claimedVsSettled: ashgrove.claimed_vs_settled }),
  h(ui.StressPanel, { scenarios: meridian.stress_scenarios }),
  h(ui.LoanBook, { loans: meridian.loans, lens: "data_room" }),
  h(ui.LoanDetail, { loan: min03, lens: "data_room" }),
  h(ui.InvestorView, { funds: demo.funds }),
  h(ui.ManagerView, { fund: meridian }),
  h(ui.AuditorView, { funds: demo.funds }),
  h(ui.ReportBundle, { fund: meridian, bundle, readAt: snap.generatedAt })));

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TrueNav Labs depth modules</title>
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;
const out = join(here, "index.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${Buffer.byteLength(html)} bytes)`);
