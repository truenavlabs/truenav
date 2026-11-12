// Turns allowlisted feed results into display rows. Hides a missing value.
// Market figures are context only.

import { formatCompactUsd, formatPct, formatUsd } from "../../modules/format.mjs";

function row(id, label, valueText, extra = {}) {
  if (!valueText) return null;
  return { id, label, valueText, ...extra };
}

export function tickerItems(feeds) {
  const g = feeds["coingecko-simple"];
  const fx = feeds["frankfurter-fx"];
  const stables = feeds["defillama-stablecoins"];
  const sofr = feeds["nyfed-sofr"];
  const bills = feeds["treasury-avg-rates"];
  const curve = feeds["treasury-yield-curve"];
  const rwa = feeds["defillama-rwa-protocols"];
  const near = feeds["near-testnet-status"];
  const tvl = feeds["defillama-near-tvl"];
  const items = [];
  const price = (id, label, key) => {
    const v = g && g.value && g.value[key];
    if (!v) return;
    items.push(row(id, label, formatUsd(v.usd, v.usd < 2 ? 4 : 2), {
      changeText: v.usd_24h_change == null ? "" : formatPct(v.usd_24h_change),
      chip: g.chip || g.mode,
      source: g.source,
      attribution: g.attribution,
      fetchedAt: g.fetchedAt,
      dim: !!g.dim,
    }));
  };
  if (g && g.value) {
    price("near", "NEAR", "near");
    price("btc", "BTC", "bitcoin");
    price("eth", "ETH", "ethereum");
    price("usdc", "USDC", "usd-coin");
  }
  const y10 = curve && curve.value && curve.value.latest && curve.value.latest.y10;
  const y2 = curve && curve.value && curve.value.latest && curve.value.latest.y2;
  if (y2 != null) items.push(metaRow("us2y", "US 2Y", `${y2.toFixed(2)}%`, curve));
  if (y10 != null) items.push(metaRow("us10y", "US 10Y", `${y10.toFixed(2)}%`, curve));
  const bill = bills && bills.value && (bills.value.rows || []).find((r) => /bill/i.test(r.security_desc || ""));
  if (bill) items.push(metaRow("bill", "Bills", `${bill.avg_interest_rate_amt}%`, bills));
  if (sofr && sofr.value && sofr.value.percent_rate != null) items.push(metaRow("sofr", "SOFR", `${Number(sofr.value.percent_rate).toFixed(2)}%`, sofr));
  if (fx && fx.value && fx.value.rates) {
    items.push(metaRow("usdthb", "USD/THB", Number(fx.value.rates.THB).toFixed(3), fx));
    items.push(metaRow("eurusd", "EUR per USD", Number(fx.value.rates.EUR).toFixed(4), fx));
  }
  if (stables && stables.value && stables.value.total_usd) {
    items.push(metaRow("stables", "Stablecoins", formatCompactUsd(stables.value.total_usd), stables));
  }
  if (rwa && Array.isArray(rwa.value) && rwa.value.length) {
    const total = rwa.value.reduce((s, p) => s + p.tvl_usd, 0);
    items.push(metaRow("rwa", "RWA TVL", formatCompactUsd(total), rwa));
  }
  if (tvl && tvl.value && tvl.value.tvl_usd != null) items.push(metaRow("neartvl", "NEAR DeFi TVL", formatCompactUsd(tvl.value.tvl_usd), tvl));
  if (near && near.value && near.value.latest_block_height != null) {
    items.push(metaRow("block", "Testnet block", Number(near.value.latest_block_height).toLocaleString("en-US"), near));
  }
  return items.filter(Boolean);
}

function metaRow(id, label, valueText, feed) {
  return row(id, label, valueText, {
    chip: feed.chip || feed.mode,
    source: feed.source,
    attribution: feed.attribution,
    fetchedAt: feed.fetchedAt,
    dim: !!feed.dim,
  });
}

export function marketsModel(feeds) {
  return {
    rwa: {
      categories: feeds["coingecko-categories"] && feeds["coingecko-categories"].value,
      protocols: feeds["defillama-rwa-protocols"] && feeds["defillama-rwa-protocols"].value,
      yields: feeds["defillama-tbill-yields"] && feeds["defillama-tbill-yields"].value,
      feed: feeds["defillama-rwa-protocols"] || feeds["coingecko-categories"] || null,
    },
    rates: {
      curve: feeds["treasury-yield-curve"] && feeds["treasury-yield-curve"].value,
      averages: feeds["treasury-avg-rates"] && feeds["treasury-avg-rates"].value,
      sofr: feeds["nyfed-sofr"] && feeds["nyfed-sofr"].value,
      effr: feeds["nyfed-effr"] && feeds["nyfed-effr"].value,
      feed: feeds["treasury-avg-rates"] || feeds["nyfed-sofr"] || null,
    },
    crypto: {
      prices: feeds["coingecko-simple"] && feeds["coingecko-simple"].value,
      stables: feeds["defillama-stablecoins"] && feeds["defillama-stablecoins"].value,
      feed: feeds["coingecko-simple"] || null,
    },
    fx: {
      book: feeds["frankfurter-fx"] && feeds["frankfurter-fx"].value,
      feed: feeds["frankfurter-fx"] || null,
    },
    near: {
      status: feeds["near-testnet-status"] && feeds["near-testnet-status"].value,
      stats: feeds["nearblocks-testnet-stats"] && feeds["nearblocks-testnet-stats"].value,
      txns: feeds["nearblocks-registry-txns"] && feeds["nearblocks-registry-txns"].value,
      tvl: feeds["defillama-near-tvl"] && feeds["defillama-near-tvl"].value,
      feed: feeds["near-testnet-status"] || null,
    },
  };
}
