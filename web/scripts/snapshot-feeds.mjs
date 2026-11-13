// Builds web/public/feeds/snapshot.json. Node only, no keys, no npm packages.
// Heavy lists (DefiLlama protocols and yields, Treasury curve XML) are trimmed here.
// FRED is not fetched: the dashboard spec (3D) says FRED terms prohibit caching.
//
//   node web/scripts/snapshot-feeds.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEEDS,
  SCHEMA,
  fetchFeed,
  snapshotEntry,
  trimRwaProtocols,
  trimTbillYields,
  trimCategories,
  trimChainTvl,
  trimYieldCurveXml,
  parsePoolChart,
} from "../data/feeds/feeds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "../public/feeds/snapshot.json");

const SNAPSHOT_ONLY = [
  {
    id: "coingecko-categories",
    url: "https://api.coingecko.com/api/v3/coins/categories",
    source: "CoinGecko",
    attribution: "Data provided by CoinGecko",
    attributionUrl: "https://www.coingecko.com",
    licenceNote: FEEDS["coingecko-simple"].licenceNote,
    trim: trimCategories,
    timeoutMs: 15000,
  },
  {
    id: "defillama-rwa-protocols",
    url: "https://api.llama.fi/protocols",
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    attributionUrl: "https://defillama.com",
    licenceNote: FEEDS["defillama-coins"].licenceNote,
    trim: trimRwaProtocols,
    timeoutMs: 20000,
  },
  {
    id: "defillama-tbill-yields",
    url: "https://yields.llama.fi/pools",
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    attributionUrl: "https://defillama.com",
    licenceNote: FEEDS["defillama-coins"].licenceNote,
    trim: trimTbillYields,
    timeoutMs: 20000,
  },
  {
    id: "defillama-near-tvl",
    url: "https://api.llama.fi/v2/historicalChainTvl/Near",
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    attributionUrl: "https://defillama.com",
    licenceNote: FEEDS["defillama-coins"].licenceNote,
    trim: trimChainTvl,
    timeoutMs: 15000,
  },
  {
    id: "treasury-yield-curve",
    url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=202611",
    source: "US Treasury",
    attribution: "U.S. Department of the Treasury",
    attributionUrl: "https://home.treasury.gov",
    licenceNote: "US Treasury par yield curve. The dashboard spec (3B) describes it as public domain. This feed is snapshot only because the XML is slow.",
    trim: trimYieldCurveXml,
    timeoutMs: 25000,
    text: true,
  },
];

async function fetchTrim(row) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), row.timeoutMs);
  try {
    const res = await fetch(row.url, { signal: ctrl.signal, headers: { accept: row.text ? "application/xml,text/xml,*/*" : "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = row.text ? await res.text() : await res.json();
    const value = row.trim(body);
    if (value == null) throw new Error("trim returned empty");
    return snapshotEntry(row.id, value, { ...row, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return snapshotEntry(row.id, null, { ...row, fetchedAt: new Date().toISOString(), message: err.message || "fetch failed" });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLive(id) {
  try {
    const row = await fetchFeed(id, { timeoutMs: 8000 });
    return snapshotEntry(id, row.value, { ...row, mode: "snapshot" });
  } catch (err) {
    return snapshotEntry(id, null, { fetchedAt: new Date().toISOString(), message: err.message || "fetch failed" });
  }
}

const directIds = Object.keys(FEEDS).filter((id) => id !== "defillama-pool-chart");
const [direct, extra] = await Promise.all([
  Promise.all(directIds.map(async (id) => [id, await fetchLive(id)])),
  Promise.all(SNAPSHOT_ONLY.map(async (row) => [row.id, await fetchTrim(row)])),
]);

const feeds = Object.fromEntries([...direct, ...extra]);
const yields = feeds["defillama-tbill-yields"];
if (yields && yields.value) {
  const charts = {};
  for (const row of yields.value) {
    if (!row.pool) continue;
    try {
      const chart = await fetchFeed("defillama-pool-chart", { poolId: row.pool, timeoutMs: 8000 });
      const trimmed = parsePoolChart(chart.value && chart.value.points ? { data: chart.value.points } : chart.value);
      charts[row.pool] = snapshotEntry("defillama-pool-chart", trimmed || chart.value, {
        fetchedAt: chart.fetchedAt,
        source: chart.source,
        sourceUrl: chart.sourceUrl,
        licenceNote: chart.licenceNote,
        attribution: chart.attribution,
      });
    } catch (err) {
      charts[row.pool] = snapshotEntry("defillama-pool-chart", null, { message: err.message, sourceUrl: `https://yields.llama.fi/chart/${row.pool}` });
    }
  }
  feeds["defillama-pool-charts"] = snapshotEntry("defillama-pool-chart", charts, {
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    sourceUrl: "https://yields.llama.fi/chart/{pool}",
    licenceNote: FEEDS["defillama-pool-chart"].licenceNote,
  });
}

const doc = {
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  note: "Committed snapshot for the TrueNav dashboard. Panels prefer a live browser fetch and fall back to this file with an amber snapshot chip. External market data is context only and never feeds a TrueNav score. FRED is not included.",
  feeds,
};

let text = `${JSON.stringify(doc)}\n`;
if (Buffer.byteLength(text) > 100 * 1024) {
  if (doc.feeds["defillama-pool-charts"] && doc.feeds["defillama-pool-charts"].value) {
    for (const chart of Object.values(doc.feeds["defillama-pool-charts"].value)) {
      if (chart.value && Array.isArray(chart.value.points)) chart.value.points = chart.value.points.slice(-8);
    }
  }
  text = `${JSON.stringify(doc)}\n`;
}
const bytes = Buffer.byteLength(text);
if (bytes > 100 * 1024) {
  console.error(`snapshot is ${bytes} bytes, over 100 KB`);
  process.exitCode = 1;
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, text);
const failed = Object.entries(feeds).filter(([, v]) => v.mode === "error").map(([k]) => k);
console.log(`wrote ${outPath} (${bytes} bytes)`);
if (failed.length) console.log(`feeds with no value: ${failed.join(", ")}`);
