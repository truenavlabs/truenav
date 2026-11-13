import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEEDS,
  TIMEOUT_MS,
  fetchFeed,
  planInterval,
  shouldPoll,
  startPoll,
  presentFeed,
  poolChartUrl,
  parseCoinGeckoSimple,
  parseStablecoins,
  parseFrankfurter,
  parseNearStatus,
  parseNearblocksStats,
  trimYieldCurveXml,
  trimRwaProtocols,
} from "./feeds.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test("unknown feed ids and open URLs are refused", async () => {
  await assert.rejects(() => fetchFeed("https://example.com"), /not allowlisted/);
  await assert.rejects(() => fetchFeed("fred-dgs10"), /not allowlisted/);
  assert.throws(() => poolChartUrl("https://yields.llama.fi/chart/abc"), /allowlisted uuid/);
  assert.throws(() => poolChartUrl("../etc"), /allowlisted uuid/);
  const id = "11111111-2222-3333-4444-555555555555";
  assert.equal(poolChartUrl(id), `https://yields.llama.fi/chart/${id}`);
});

test("poll intervals cannot go under the spec caps", () => {
  assert.equal(planInterval("coingecko-simple", 1000), 120000);
  assert.equal(planInterval("frankfurter-fx", 1000), 3600000);
  assert.equal(planInterval("treasury-avg-rates", 7200000), 7200000);
  assert.equal(planInterval("nyfed-sofr"), 3600000);
  assert.equal(FEEDS["coingecko-simple"].minIntervalMs, 120000);
});

test("a hidden tab does not poll", async () => {
  let calls = 0;
  const stop = startPoll("coingecko-simple", {
    hidden: () => true,
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    onResult: () => {},
  });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.equal(calls, 0);
  assert.equal(shouldPoll({ hidden: () => true }), false);
  assert.equal(shouldPoll({ hidden: () => false }), true);
});

test("fetch uses only the allowlisted URL and keeps CoinGecko attribution", async () => {
  let seen;
  const row = await fetchFeed("coingecko-simple", {
    now: () => Date.parse("2026-11-12T12:00:00Z"),
    fetchImpl: async (url) => {
      seen = url;
      return jsonResponse({
        near: { usd: 3.41, usd_24h_change: -7.87 },
        bitcoin: { usd: 71518, usd_24h_change: -1 },
        ethereum: { usd: 2009.46, usd_24h_change: -2 },
        "usd-coin": { usd: 0.9996, usd_24h_change: 0 },
      });
    },
  });
  assert.equal(seen, FEEDS["coingecko-simple"].url);
  assert.equal(row.mode, "live");
  assert.equal(row.attribution, "Data provided by CoinGecko");
  assert.equal(row.value.near.usd, 3.41);
  assert.equal(row.fetchedAt, "2026-11-12T12:00:00.000Z");
});

test("HTTP 429 hides the value and the snapshot fallback is amber", async () => {
  await assert.rejects(
    () => fetchFeed("frankfurter-fx", { fetchImpl: async () => jsonResponse({}, 429) }),
    (err) => err.status === 429,
  );
  const shown = presentFeed({
    id: "frankfurter-fx",
    live: { id: "frankfurter-fx", mode: "error", status: 429, value: null },
    snapshot: {
      value: { date: "2026-11-12", base: "USD", rates: { EUR: 0.9, THB: 33.8, GBP: 0.75, JPY: 159.7 } },
      fetchedAt: "2026-11-13T07:00:00.000Z",
      mode: "snapshot",
    },
    now: Date.parse("2026-11-13T08:00:00Z"),
  });
  assert.equal(shown.chip, "snapshot");
  assert.equal(shown.stale, true);
  assert.equal(shown.dim, true);
  assert.notEqual(shown.value, 0);
  const hidden = presentFeed({
    id: "nyfed-sofr",
    live: { mode: "error", value: null },
    snapshot: { mode: "error", value: null },
  });
  assert.equal(hidden.mode, "hidden");
  assert.equal(hidden.value, null);
});

test("a live price older than three intervals is stale, not relabeled as current", () => {
  const fetchedAt = "2026-11-13T00:00:00.000Z";
  const shown = presentFeed({
    id: "coingecko-simple",
    live: { mode: "live", value: { near: { usd: 1, usd_24h_change: 0 } }, fetchedAt, attribution: "Data provided by CoinGecko" },
    now: Date.parse(fetchedAt) + 120000 * 3 + 1,
  });
  assert.equal(shown.chip, "stale");
  assert.equal(shown.mode, "live");
});

test("parsers trim fixtures and do not invent a zero", () => {
  assert.equal(parseCoinGeckoSimple({}), null);
  assert.equal(parseStablecoins({ peggedAssets: [] }), null);
  const fx = parseFrankfurter({ date: "2026-11-12", base: "USD", rates: { EUR: 0.9, THB: 33, GBP: 0.7, JPY: 150, CAD: 1.4 } });
  assert.deepEqual(Object.keys(fx.rates).sort(), ["EUR", "GBP", "JPY", "THB"]);
  const stats = parseNearblocksStats({ data: { nodes_online: 27, tps: 5, near_price: null } });
  assert.equal(stats.nodes, 27);
  assert.equal(stats.tps, 5);
  const status = parseNearStatus({ jsonrpc: "2.0", result: { chain_id: "testnet", sync_info: { latest_block_height: 10, latest_block_hash: "abc" } } });
  assert.equal(status.latest_block_height, 10);
  const rwa = trimRwaProtocols([{ name: "Re", category: "RWA", tvl: 10, symbol: "RE" }, { name: "Dex", category: "Dexs", tvl: 99 }]);
  assert.equal(rwa.length, 1);
  const xml = `<entry><d:NEW_DATE>2026-11-10T00:00:00</d:NEW_DATE><d:BC_1MONTH>4.05</d:BC_1MONTH><d:BC_2YEAR>4.73</d:BC_2YEAR><d:BC_10YEAR>4.98</d:BC_10YEAR><d:BC_30YEAR>5.10</d:BC_30YEAR></entry>`;
  assert.equal(trimYieldCurveXml(xml).latest.y10, 4.98);
  assert.equal(trimYieldCurveXml("no curve"), null);
});

test("timeout aborts the request", async () => {
  await assert.rejects(() => fetchFeed("near-testnet-status", {
    timeoutMs: 15,
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }),
  }));
  assert.equal(TIMEOUT_MS, 4000);
});

test("feeds module does not import node or read a secret", () => {
  const src = readFileSync(join(here, "feeds.mjs"), "utf8");
  assert.equal(src.includes("node:"), false);
  assert.equal(src.includes("process.env"), false);
  assert.equal(src.includes("API_KEY"), false);
  assert.equal(src.includes("\u2014"), false);
  assert.equal(src.includes("\u2013"), false);
});

test("committed snapshot stays under 100 KB and stamps fetchedAt", () => {
  const path = join(here, "../../public/feeds/snapshot.json");
  const raw = readFileSync(path, "utf8");
  assert.ok(Buffer.byteLength(raw) < 100 * 1024);
  const doc = JSON.parse(raw);
  assert.equal(doc.schema, "truenav-feeds-v1");
  assert.ok(doc.generatedAt);
  for (const [id, row] of Object.entries(doc.feeds)) {
    assert.ok(row.fetchedAt, id);
    assert.ok(row.attribution || row.mode === "error", id);
    if (row.mode !== "error") assert.notEqual(row.value, 0);
  }
});

test("parsers drop objects, unbounded strings and non-finite numbers from hostile feeds", async () => {
  const f = await import("./feeds.mjs");
  const fiscal = f.parseFiscalRates({ data: [
    { record_date: "2026-11-01", security_desc: { a: 1 }, avg_interest_rate_amt: "4.1" },
    { record_date: "2026-11-01", security_desc: "x".repeat(50000), avg_interest_rate_amt: "4.25" },
    { record_date: "2026-11-01", security_desc: "Treasury Bills", avg_interest_rate_amt: "abc" },
  ] });
  assert.equal(fiscal.rows.length, 1);
  assert.equal(fiscal.rows[0].security_desc.length, 80);
  assert.equal(fiscal.rows[0].avg_interest_rate_amt, "4.25");
  const stats = f.parseNearblocksStats({ stats: { nodes_online: { a: 1 }, tps: "12", block: "x" } });
  assert.deepEqual(stats, { nodes: null, tps: 12, near_price_usd: null, block_height: null });
  assert.equal(f.parseNyFed({ refRates: [{ percentRate: "abc" }] }), null);
  assert.equal(f.parseNyFed({ refRates: [{ percentRate: "4.33", type: { x: 1 } }] }).percent_rate, 4.33);
  const good = "8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs";
  const txns = f.parseNearblocksTxns({ txns: [
    { transaction_hash: good, method: "pledge_loan", signer_account_id: "a.testnet" },
    { transaction_hash: "javascript:alert(1)", method: { a: 1 }, signer_account_id: ["x"] },
    { hash: "0".repeat(44), method: "m".repeat(500) },
  ] });
  assert.equal(txns[0].explorer, `https://testnet.nearblocks.io/txns/${good}`);
  assert.equal(txns[1].explorer, null);
  assert.equal(txns[1].hash, null);
  assert.equal(txns[1].method, null);
  assert.equal(txns[1].signer, null);
  assert.equal(txns[2].explorer, null, "0 is not base58");
  assert.equal(txns[2].method.length, 64);
  const st = f.parseStablecoins({ peggedAssets: [{ symbol: { a: 1 }, name: "N".repeat(500), circulating: { peggedUSD: 5 } }] });
  assert.equal(st.top[0].symbol.length, 16);
  assert.equal(st.top[0].name.length, 64);
  assert.equal(f.parseNearStatus({ sync_info: { latest_block_height: { a: 1 } } }), null);
  assert.equal(f.parseNearStatus({ sync_info: { latest_block_height: 5, latest_block_hash: "<b>" } }).latest_block_hash, null);
});
