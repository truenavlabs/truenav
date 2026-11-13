import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";

await register(new URL("./harness/react-loader.mjs", import.meta.url), import.meta.url);
const { renderToHtml } = await import("./harness/react-shim.mjs");
const { createElement } = await import("react");
const { LoanDetail, MarketTicker, loansToCsv } = await import("./index.mjs");
const { buildReportBundle } = await import("./report.mjs");

const demo = JSON.parse(readFileSync(new URL("../data/demo/funds.demo.json", import.meta.url), "utf8"));
const meridian = demo.funds.find((f) => f.fund_id === "meridian-yield-fund");
const loan = meridian.loans.find((l) => l.data_room.loan_id === "M-IN-03");

test("M-IN-03 shows the enclave pass and the servicer exclusion", () => {
  const html = renderToHtml(createElement(LoanDetail, { loan, lens: "data_room" }));
  assert.match(html, /documents: pass \(enclave\)\. servicer data: anomaly, excluded from TrueVal\./);
  assert.match(html, /H-RE-03/);
  assert.equal(html.includes("INV-DEMO"), false);
  assert.equal(html.includes("\u2014"), false);
});

test("the ticker states that market data does not feed a score and cites CoinGecko", () => {
  const html = renderToHtml(createElement(MarketTicker, {
    items: [{
      id: "near",
      label: "NEAR",
      valueText: "$3.40",
      changeText: "-1.00%",
      chip: "snapshot",
      source: "CoinGecko",
      attribution: "Data provided by CoinGecko",
      fetchedAt: "2026-11-12T00:00:00.000Z",
      dim: true,
    }],
  }));
  assert.match(html, /does not feed a TrueNav score/);
  assert.match(html, /Data provided by CoinGecko/);
});

test("public lens CSV does not include principal", () => {
  const csv = loansToCsv(meridian.loans, "public");
  assert.equal(csv.includes("principal"), false);
  assert.match(csv, new RegExp(loan.loan_hash));
});

test("report bundle hashes its sections and names TrueNav Labs", async () => {
  const bundle = await buildReportBundle({
    fund: { fund_id: meridian.fund_id },
    certificate: meridian.anchors.certificate,
    readAt: "2026-11-12T00:00:00.000Z",
  });
  assert.equal(bundle.manifest.publisher, "TrueNav Labs");
  assert.equal(bundle.manifest.contract, "registry.tnlab-368aa2.testnet");
  assert.equal(bundle.manifest.sha256.certificate.length, 64);
  assert.equal(bundle.limits.some((item) => /informs only/.test(item.text)), true);
});
