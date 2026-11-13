import { createElement as h } from "react";
import { formatCompactUsd, formatPct, formatUsd } from "./format.mjs";
import { Empty, Panel, SourceChip } from "./ui.mjs";

function chipOf(feed) {
  return feed && (feed.chip || feed.mode) || "external";
}

function when(feed) {
  if (!feed || !feed.fetchedAt) return "";
  const kind = feed.chip || feed.mode || "snapshot";
  return `${kind}, ${feed.fetchedAt}`;
}

export function MarketsPanels({ model = {}, feeds = {} }) {
  const rwa = model.rwa || {};
  const rates = model.rates || {};
  const crypto = model.crypto || {};
  const fx = model.fx || {};
  const near = model.near || {};
  return h("div", { id: "tn-markets" },
    h(Panel, {
      title: "RWA market",
      kicker: "For comparison",
      mix: chipOf(rwa.feed),
      note: `Tokenized private credit and treasuries are third-party market caps. ${when(rwa.feed)}. Not a TrueNav input.`,
    },
    h(CategoryTable, { rows: rwa.categories, feed: feeds["coingecko-categories"] }),
    h("h3", null, "Top RWA protocols by TVL"),
    h(ProtocolTable, { rows: rwa.protocols }),
    h("h3", null, "Tokenized T-bill yields"),
    h(YieldTable, { rows: rwa.yields })),
    h(Panel, {
      title: "Rates",
      mix: chipOf(rates.feed),
      note: "Treasury par yields are a committed snapshot when the XML is too slow for page load. SOFR and EFFR are the NY Fed Markets API.",
    },
    h(CurveTable, { curve: rates.curve }),
    h(RateLine, { label: "SOFR", row: rates.sofr, feed: feeds["nyfed-sofr"] }),
    h(RateLine, { label: "EFFR", row: rates.effr, feed: feeds["nyfed-effr"] }),
    h(AvgTable, { averages: rates.averages })),
    h(Panel, {
      title: "Crypto",
      mix: chipOf(crypto.feed),
      note: "Data provided by CoinGecko. Stablecoin supply is DefiLlama.",
    },
    h(PriceTable, { prices: crypto.prices }),
    h(StableTable, { stables: crypto.stables })),
    h(Panel, {
      title: "FX",
      mix: chipOf(fx.feed),
      note: "Frankfurter, ECB reference rates. USD against EUR, THB, GBP and JPY.",
    },
    h(FxTable, { book: fx.book })),
    h(Panel, {
      title: "NEAR network",
      mix: chipOf(near.feed),
      note: "Testnet only. Transactions are NearBlocks v3 for registry.tnlab-368aa2.testnet.",
    },
    h(NearBlock, { near })));
}

function CategoryTable({ rows, feed }) {
  if (!rows || !rows.length) return h(Empty, null, "No category snapshot in this read.");
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, "Category"), h("th", { className: "num" }, "Market cap"), h("th", null, "Note"))),
    h("tbody", null, rows.map((r) => h("tr", { key: r.id },
      h("td", null, r.name),
      h("td", { className: "num tn-num" }, r.market_cap_usd == null ? "" : formatCompactUsd(r.market_cap_usd)),
      h("td", null, r.note || (feed && feed.attribution) || "")))));
}

function ProtocolTable({ rows }) {
  if (!rows || !rows.length) return h(Empty, null, "No protocol snapshot in this read.");
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, "Protocol"), h("th", { className: "num" }, "TVL"))),
    h("tbody", null, rows.map((r) => h("tr", { key: r.name },
      h("td", null, r.name),
      h("td", { className: "num tn-num" }, formatCompactUsd(r.tvl_usd))))));
}

function YieldTable({ rows }) {
  if (!rows || !rows.length) return h(Empty, null, "No T-bill yield snapshot in this read.");
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, "Pool"), h("th", { className: "num" }, "APY"), h("th", { className: "num" }, "TVL"))),
    h("tbody", null, rows.map((r) => h("tr", { key: r.pool || r.symbol },
      h("td", null, `${r.symbol || ""} ${r.project || ""}`.trim()),
      h("td", { className: "num tn-num" }, r.apy == null ? "" : `${r.apy.toFixed(2)}%`),
      h("td", { className: "num tn-num" }, r.tvl_usd == null ? "" : formatCompactUsd(r.tvl_usd))))));
}

function CurveTable({ curve }) {
  if (!curve || !curve.latest) return h(Empty, null, "Yield curve snapshot unavailable.");
  const cols = [["1M", "m1"], ["2Y", "y2"], ["10Y", "y10"], ["30Y", "y30"]];
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, "Date"), cols.map(([label]) => h("th", { className: "num", key: label }, label)))),
    h("tbody", null, ["latest", "earlier"].map((key) => {
      const row = curve[key];
      if (!row) return null;
      return h("tr", { key },
        h("td", null, `${row.date} (${key === "latest" ? "latest" : "earlier"})`),
        cols.map(([label, field]) => h("td", { className: "num tn-num", key: field }, row[field] == null ? "" : `${row[field].toFixed(2)}%`)));
    })));
}

function RateLine({ label, row, feed }) {
  if (!row || row.percent_rate == null) return h(Empty, null, `${label} is hidden because the feed has no value.`);
  return h("p", null,
    h("b", null, label),
    " ",
    h("span", { className: "tn-num" }, `${Number(row.percent_rate).toFixed(2)}%`),
    row.effective_date ? ` on ${row.effective_date}` : "",
    " ",
    feed ? h(SourceChip, { tag: feed.chip || feed.mode || "external", title: feed.attribution }) : null);
}

function AvgTable({ averages }) {
  if (!averages || !averages.rows) return null;
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, `Average rate ${averages.record_date || ""}`), h("th", { className: "num" }, "Percent"))),
    h("tbody", null, averages.rows.slice(0, 8).map((r) => h("tr", { key: r.security_desc },
      h("td", null, r.security_desc),
      h("td", { className: "num tn-num" }, r.avg_interest_rate_amt == null ? "" : `${r.avg_interest_rate_amt}%`)))));
}

function PriceTable({ prices }) {
  if (!prices) return h(Empty, null, "Prices are hidden because the feed has no value.");
  const order = [["near", "NEAR"], ["bitcoin", "BTC"], ["ethereum", "ETH"], ["usd-coin", "USDC"]];
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, "Asset"), h("th", { className: "num" }, "USD"), h("th", { className: "num" }, "24h"))),
    h("tbody", null, order.map(([key, label]) => {
      const row = prices[key];
      if (!row) return null;
      return h("tr", { key },
        h("td", null, label),
        h("td", { className: "num tn-num" }, formatUsd(row.usd, row.usd < 2 ? 4 : 2)),
        h("td", { className: "num tn-num" }, row.usd_24h_change == null ? "" : formatPct(row.usd_24h_change)));
    })));
}

function StableTable({ stables }) {
  if (!stables || !stables.top) return h(Empty, null, "Stablecoin supply is hidden because the feed has no value.");
  return h("div", null,
    h("p", null, "Total ", h("span", { className: "tn-num" }, formatCompactUsd(stables.total_usd))),
    h("table", { className: "tn-table" },
      h("tbody", null, stables.top.map((r) => h("tr", { key: r.symbol },
        h("td", null, r.symbol),
        h("td", { className: "num tn-num" }, formatCompactUsd(r.circulating_usd)))))));
}

function FxTable({ book }) {
  if (!book || !book.rates) return h(Empty, null, "FX is hidden because the feed has no value.");
  return h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, h("th", null, `USD on ${book.date || ""}`), h("th", { className: "num" }, "Rate"))),
    h("tbody", null, Object.entries(book.rates).map(([k, v]) => h("tr", { key: k },
      h("td", null, k),
      h("td", { className: "num tn-num" }, Number(v).toFixed(4))))));
}

function nearTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "";
  const ms = n > 1e15 ? n / 1e6 : n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function NearBlock({ near }) {
  const status = near.status;
  const stats = near.stats;
  const txns = Array.isArray(near.txns) ? near.txns : [];
  return h("div", null,
    status ? h("p", null, `${status.chain_id} block `, h("span", { className: "tn-num" }, Number(status.latest_block_height).toLocaleString("en-US"))) : h(Empty, null, "Testnet status is hidden because the feed has no value."),
    stats && (stats.nodes != null || stats.tps != null) ? h("p", null, `NearBlocks testnet: ${stats.nodes == null ? "" : `${stats.nodes} nodes`} ${stats.tps == null ? "" : `${stats.tps} tps`}`) : null,
    near.tvl && near.tvl.tvl_usd != null ? h("p", null, "NEAR DeFi TVL ", formatCompactUsd(near.tvl.tvl_usd), " (DefiLlama snapshot)") : null,
    txns.length ? h("table", { className: "tn-table" },
      h("thead", null, h("tr", null, h("th", null, "Method"), h("th", null, "Signer"), h("th", null, "Time"))),
      h("tbody", null, txns.slice(0, 8).map((tx) => h("tr", { key: tx.hash || tx.method },
        h("td", null, tx.explorer ? h("a", { href: tx.explorer }, tx.method || "txn") : (tx.method || "")),
        h("td", { className: "tn-mono" }, tx.signer || ""),
        h("td", null, nearTime(tx.block_timestamp)))))) : h(Empty, null, "No registry transactions in this read."));
}
