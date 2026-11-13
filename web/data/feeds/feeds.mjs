// Browser-direct market feeds. Keyless allowlist only. No Node builtin imports, no secrets.
// External values are context. They never feed a TrueNav score.
// Poll at most every 120s for prices and network, and every hour for rates and FX.
// Stop polling while the tab is hidden. A failed feed hides its value rather than showing zero.

export const SCHEMA = "truenav-feeds-v1";
export const TIMEOUT_MS = 4000;
export const REGISTRY_ACCOUNT = "registry.tnlab-368aa2.testnet";

const COINGECKO_ATTR = "Data provided by CoinGecko";
const DEFILLAMA_NOTE = "Free DefiLlama API. The dashboard spec (3B, 13 Nov 2026) reads the terms as a personal, non-commercial licence. That reading was not confirmed with DefiLlama. Cite DefiLlama.";
const TREASURY_NOTE = "US Treasury Fiscal Data. The dashboard spec (3B) describes this as US government work in the public domain.";
const NYFED_NOTE = "Source: Federal Reserve Bank of New York Markets API. The dashboard spec marks the exact attribution wording as unverified.";
const FX_NOTE = "Frankfurter, ECB reference rates. The dashboard spec (3B) describes the project as open source.";
const NEAR_NOTE = "Public NEAR testnet JSON-RPC. Read only.";
const NEARBLOCKS_NOTE = "NearBlocks API v3 on testnet. The dashboard spec (3B) says testnet v1 retired on 5 Nov 2026. Keyless rate limit was not published.";

export const FEEDS = Object.freeze({
  "coingecko-simple": feed({
    group: "prices",
    minIntervalMs: 120000,
    method: "GET",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=near,usd-coin,ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true",
    source: "CoinGecko",
    attribution: COINGECKO_ATTR,
    attributionUrl: "https://www.coingecko.com",
    licenceNote: "Keyless CoinGecko is for testing and is not for production or scheduled polling. Attribution is required. A commercial licence needs a paid plan (dashboard spec 3B).",
    parse: parseCoinGeckoSimple,
  }),
  "defillama-coins": feed({
    group: "prices",
    minIntervalMs: 120000,
    method: "GET",
    url: "https://coins.llama.fi/prices/current/coingecko:near,coingecko:bitcoin,coingecko:ethereum,coingecko:usd-coin",
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    attributionUrl: "https://defillama.com",
    licenceNote: DEFILLAMA_NOTE,
    parse: parseDefiLlamaCoins,
  }),
  "defillama-pool-chart": feed({
    group: "prices",
    minIntervalMs: 120000,
    method: "GET",
    url: "https://yields.llama.fi/chart/{pool}",
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    attributionUrl: "https://defillama.com",
    licenceNote: DEFILLAMA_NOTE,
    parse: parsePoolChart,
  }),
  "defillama-stablecoins": feed({
    group: "prices",
    minIntervalMs: 120000,
    method: "GET",
    url: "https://stablecoins.llama.fi/stablecoins?includePrices=true",
    source: "DefiLlama",
    attribution: "Data from DefiLlama",
    attributionUrl: "https://defillama.com",
    licenceNote: DEFILLAMA_NOTE,
    parse: parseStablecoins,
  }),
  "treasury-avg-rates": feed({
    group: "rates",
    minIntervalMs: 3600000,
    method: "GET",
    url: "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=30",
    source: "US Treasury Fiscal Data",
    attribution: "U.S. Department of the Treasury, Fiscal Data",
    attributionUrl: "https://fiscaldata.treasury.gov",
    licenceNote: TREASURY_NOTE,
    parse: parseFiscalRates,
  }),
  "nyfed-sofr": feed({
    group: "rates",
    minIntervalMs: 3600000,
    method: "GET",
    url: "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json",
    source: "Federal Reserve Bank of New York",
    attribution: "Federal Reserve Bank of New York",
    attributionUrl: "https://www.newyorkfed.org",
    licenceNote: NYFED_NOTE,
    parse: parseNyFed,
  }),
  "nyfed-effr": feed({
    group: "rates",
    minIntervalMs: 3600000,
    method: "GET",
    url: "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
    source: "Federal Reserve Bank of New York",
    attribution: "Federal Reserve Bank of New York",
    attributionUrl: "https://www.newyorkfed.org",
    licenceNote: NYFED_NOTE,
    parse: parseNyFed,
  }),
  "frankfurter-fx": feed({
    group: "fx",
    minIntervalMs: 3600000,
    method: "GET",
    url: "https://api.frankfurter.app/latest?from=USD&to=EUR,THB,GBP,JPY",
    source: "Frankfurter",
    attribution: "Frankfurter (ECB reference rates)",
    attributionUrl: "https://www.frankfurter.app",
    licenceNote: FX_NOTE,
    parse: parseFrankfurter,
  }),
  "near-testnet-status": feed({
    group: "network",
    minIntervalMs: 120000,
    method: "POST",
    url: "https://test.rpc.fastnear.com",
    body: { jsonrpc: "2.0", id: "truenav", method: "status", params: {} },
    source: "NEAR testnet RPC",
    attribution: "NEAR testnet RPC (test.rpc.fastnear.com)",
    attributionUrl: "https://docs.near.org",
    licenceNote: NEAR_NOTE,
    parse: parseNearStatus,
  }),
  "nearblocks-testnet-stats": feed({
    group: "network",
    minIntervalMs: 120000,
    method: "GET",
    url: "https://api-testnet.nearblocks.io/v3/stats",
    source: "NearBlocks",
    attribution: "NearBlocks testnet v3",
    attributionUrl: "https://api-testnet.nearblocks.io",
    licenceNote: NEARBLOCKS_NOTE,
    parse: parseNearblocksStats,
  }),
  "nearblocks-registry-txns": feed({
    group: "network",
    minIntervalMs: 120000,
    method: "GET",
    url: `https://api-testnet.nearblocks.io/v3/accounts/${REGISTRY_ACCOUNT}/txns?limit=25`,
    source: "NearBlocks",
    attribution: "NearBlocks testnet v3",
    attributionUrl: `https://testnet.nearblocks.io/address/${REGISTRY_ACCOUNT}`,
    licenceNote: NEARBLOCKS_NOTE,
    parse: parseNearblocksTxns,
  }),
});

function feed(spec) {
  return Object.freeze(spec);
}

const POOL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function poolChartUrl(poolId) {
  if (typeof poolId !== "string" || !POOL_ID.test(poolId)) {
    throw new Error("pool id is not an allowlisted uuid");
  }
  return `https://yields.llama.fi/chart/${poolId}`;
}

export function planInterval(id, requestedMs) {
  const spec = FEEDS[id];
  if (!spec) throw new Error(`feed not allowlisted: ${id}`);
  const asked = Number(requestedMs);
  if (!Number.isFinite(asked) || asked <= 0) return spec.minIntervalMs;
  return Math.max(spec.minIntervalMs, asked);
}

export function shouldPoll({ hidden } = {}) {
  if (typeof hidden === "function" && hidden()) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return true;
}

export function assertAllowlisted(id) {
  if (!Object.prototype.hasOwnProperty.call(FEEDS, id)) {
    throw new Error(`feed not allowlisted: ${id}`);
  }
  return FEEDS[id];
}

export async function fetchFeed(id, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = () => Date.now(), poolId } = {}) {
  const spec = assertAllowlisted(id);
  let url = spec.url;
  if (id === "defillama-pool-chart") url = poolChartUrl(poolId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: spec.method,
      headers: spec.body
        ? { accept: "application/json", "content-type": "application/json" }
        : { accept: "application/json" },
      body: spec.body ? JSON.stringify(spec.body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`feed ${id} HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const value = spec.parse(json);
    if (value == null) throw new Error(`feed ${id} returned no value`);
    return {
      id,
      value,
      fetchedAt: new Date(now()).toISOString(),
      source: spec.source,
      sourceUrl: url,
      licenceNote: spec.licenceNote,
      attribution: spec.attribution,
      attributionUrl: spec.attributionUrl,
      mode: "live",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function startPoll(id, { onResult, fetchImpl, intervalMs, hidden, poolId, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now } = {}) {
  const every = planInterval(id, intervalMs);
  let stopped = false;
  const tick = async () => {
    if (stopped || !shouldPoll({ hidden })) return;
    try {
      onResult(await fetchFeed(id, { fetchImpl, now, poolId }));
    } catch (err) {
      onResult({
        id,
        mode: "error",
        status: err && err.status ? err.status : null,
        message: err && err.message ? err.message : "feed failed",
        value: null,
      });
    }
  };
  const timer = setIntervalImpl(tick, every);
  tick();
  return () => {
    stopped = true;
    clearIntervalImpl(timer);
  };
}

/** Live result wins. A failure or a 429 falls back to the snapshot with an amber snapshot chip. No zero fill. */
export function presentFeed({ id, live, snapshot, now = Date.now() }) {
  const spec = assertAllowlisted(id);
  if (live && live.mode === "live" && live.value != null) {
    const age = now - Date.parse(live.fetchedAt);
    const stale = Number.isFinite(age) && age > spec.minIntervalMs * 3;
    return { ...live, chip: stale ? "stale" : "live", stale, dim: stale };
  }
  if (snapshot && snapshot.value != null && snapshot.mode !== "error") {
    return {
      id,
      value: snapshot.value,
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source || spec.source,
      sourceUrl: snapshot.sourceUrl || spec.url,
      licenceNote: snapshot.licenceNote || spec.licenceNote,
      attribution: snapshot.attribution || spec.attribution,
      attributionUrl: snapshot.attributionUrl || spec.attributionUrl,
      mode: "snapshot",
      chip: "snapshot",
      stale: true,
      dim: true,
    };
  }
  return {
    id,
    value: null,
    mode: "hidden",
    chip: "unavailable",
    stale: true,
    dim: false,
    source: spec.source,
    attribution: spec.attribution,
    message: "Feed unavailable. The value is hidden rather than shown as zero.",
  };
}

// Feed values are untrusted. Parsers keep bounded strings and finite numbers only, null otherwise,
// so a hostile or broken response cannot put an object into the page or stretch the layout.
export function str(x, n = 64) {
  return typeof x === "string" ? x.slice(0, n) : null;
}
export function num(x) {
  if (typeof x !== "number" && typeof x !== "string") return null;
  if (typeof x === "string" && !/^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(x)) return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** A NEAR transaction or block hash: base58, 43 or 44 characters. */
export function nearHash(x) {
  return typeof x === "string" && BASE58_HASH.test(x) ? x : null;
}

export function parseCoinGeckoSimple(json) {
  const ids = ["near", "bitcoin", "ethereum", "usd-coin"];
  const out = {};
  for (const id of ids) {
    const row = json && json[id];
    if (!row || num(row.usd) == null || typeof row.usd !== "number") return null;
    out[id] = { usd: row.usd, usd_24h_change: typeof row.usd_24h_change === "number" ? num(row.usd_24h_change) : null };
  }
  return out;
}

export function parseDefiLlamaCoins(json) {
  const coins = json && json.coins;
  if (!coins || typeof coins !== "object") return null;
  const map = {
    near: "coingecko:near",
    bitcoin: "coingecko:bitcoin",
    ethereum: "coingecko:ethereum",
    "usd-coin": "coingecko:usd-coin",
  };
  const out = {};
  for (const [id, key] of Object.entries(map)) {
    const row = coins[key];
    if (!row || typeof row.price !== "number" || num(row.price) == null) return null;
    out[id] = { usd: row.price };
  }
  return out;
}

export function parseStablecoins(json) {
  const assets = json && (json.peggedAssets || json.assets);
  if (!Array.isArray(assets)) return null;
  const rows = assets.filter((a) => a && typeof a === "object").map((a) => {
    const circ = a.circulating && typeof a.circulating === "object" ? a.circulating.peggedUSD : a.circulating;
    const symbol = str(a.symbol, 16) || str(a.name, 16) || "";
    return {
      symbol,
      name: str(a.name, 64) || symbol,
      circulating_usd: typeof circ === "number" ? num(circ) : null,
    };
  }).filter((a) => a.circulating_usd != null && a.symbol);
  if (!rows.length) return null;
  rows.sort((a, b) => b.circulating_usd - a.circulating_usd);
  const total = rows.reduce((s, a) => s + a.circulating_usd, 0);
  return { total_usd: total, top: rows.slice(0, 5) };
}

export function parseFiscalRates(json) {
  const rows = json && json.data;
  if (!Array.isArray(rows) || !rows.length) return null;
  const latestDate = rows[0] && str(rows[0].record_date, 10);
  if (!latestDate) return null;
  const latest = rows.filter((r) => r && r.record_date === latestDate).map((r) => {
    const rate = num(r.avg_interest_rate_amt);
    return {
      record_date: latestDate,
      security_desc: str(r.security_desc, 80),
      avg_interest_rate_amt: rate == null ? null : String(rate),
    };
  }).filter((r) => r.security_desc && r.avg_interest_rate_amt != null);
  if (!latest.length) return null;
  return { record_date: latestDate, rows: latest.slice(0, 12) };
}

export function parseNyFed(json) {
  const rows = json && (json.refRates || json.refRate || json.data);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row !== "object") return null;
  const rate = num(row.percentRate ?? row.rate ?? row.effectiveRate);
  if (rate == null) return null;
  return {
    type: str(row.type, 16) || str(row.rateType, 16),
    effective_date: str(row.effectiveDate, 10) || str(row.effective_date, 10),
    percent_rate: rate,
    target_low: num(row.targetRateFrom ?? row.target_low),
    target_high: num(row.targetRateTo ?? row.target_high),
  };
}

export function parseFrankfurter(json) {
  if (!json || !json.rates || typeof json.rates !== "object") return null;
  const want = ["EUR", "THB", "GBP", "JPY"];
  const rates = {};
  for (const k of want) {
    if (typeof json.rates[k] !== "number" || num(json.rates[k]) == null) return null;
    rates[k] = json.rates[k];
  }
  return { date: str(json.date, 10), base: str(json.base, 3) || "USD", rates };
}

export function parseNearStatus(json) {
  const sync = json && (json.sync_info || (json.result && json.result.sync_info));
  const height = sync ? num(sync.latest_block_height) : null;
  if (height == null) return null;
  return {
    chain_id: str(json.chain_id, 16) || str(json.result && json.result.chain_id, 16) || "testnet",
    latest_block_height: height,
    latest_block_hash: nearHash(sync.latest_block_hash),
  };
}

export function parseNearblocksStats(json) {
  const src = json && json.stats ? json.stats : json && json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
  if (!src || typeof src !== "object") return null;
  const pick = (keys) => {
    for (const k of keys) if (src[k] != null) return num(src[k]);
    return null;
  };
  return {
    nodes: pick(["nodes_online", "nodes", "total_nodes", "validators"]),
    tps: pick(["tps", "avg_tps", "near_tps"]),
    near_price_usd: pick(["near_price", "price", "near_usd"]),
    block_height: pick(["block_height", "last_block", "block"]),
  };
}

export function parseNearblocksTxns(json) {
  const list = Array.isArray(json) ? json : json && (json.txns || json.txnsList || json.data);
  if (!Array.isArray(list)) return null;
  return list.slice(0, 25).filter((tx) => tx && typeof tx === "object").map((tx) => {
    const hash = nearHash(tx.transaction_hash) || nearHash(tx.hash);
    const act = Array.isArray(tx.actions) && tx.actions[0] && typeof tx.actions[0] === "object" ? tx.actions[0] : null;
    const ts = tx.block_timestamp ?? tx.timestamp;
    return {
      hash,
      signer: str(tx.signer_account_id, 64) || str(tx.signer, 64) || str(tx.predecessor_account_id, 64),
      receiver: str(tx.receiver_account_id, 64) || str(tx.receiver, 64),
      method: str(tx.method, 64) || (act && (str(act.method, 64) || str(act.action, 64))) || null,
      block_timestamp: typeof ts === "number" ? num(ts) : str(ts, 32),
      explorer: hash ? `https://testnet.nearblocks.io/txns/${hash}` : null,
    };
  });
}

export function parsePoolChart(json) {
  const list = Array.isArray(json) ? json : json && (json.data || json.chart);
  if (!Array.isArray(list)) return null;
  const points = list.slice(-30).filter((p) => p && typeof p === "object").map((p) => ({
    timestamp: str(p.timestamp, 32) || str(p.date, 32),
    apy: typeof p.apy === "number" ? num(p.apy) : null,
    tvl_usd: typeof p.tvlUsd === "number" ? num(p.tvlUsd) : (typeof p.tvl === "number" ? num(p.tvl) : null),
  }));
  return { points };
}

export function trimRwaProtocols(json) {
  const list = Array.isArray(json) ? json : json && json.protocols;
  if (!Array.isArray(list)) return null;
  return list
    .filter((p) => p && p.category === "RWA" && typeof p.tvl === "number" && num(p.tvl) != null && str(p.name, 64))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, 15)
    .map((p) => ({ name: str(p.name, 64), symbol: str(p.symbol, 16), tvl_usd: p.tvl }));
}

export function trimTbillYields(json) {
  const list = json && (json.data || json.pools || json);
  if (!Array.isArray(list)) return null;
  const want = ["BUIDL", "USDY", "USYC"];
  const hits = [];
  for (const p of list) {
    const symbol = String(p.symbol || "");
    const name = String(p.project || p.name || "");
    const hit = want.find((w) => symbol.toUpperCase().includes(w) || name.toUpperCase().includes(w));
    if (!hit) continue;
    hits.push({
      match: hit,
      pool: p.pool || null,
      project: p.project || null,
      symbol: p.symbol || null,
      apy: typeof p.apy === "number" ? p.apy : null,
      tvl_usd: typeof p.tvlUsd === "number" ? p.tvlUsd : null,
    });
  }
  const best = new Map();
  for (const hit of hits) {
    const prev = best.get(hit.match);
    if (!prev || (hit.tvl_usd || 0) > (prev.tvl_usd || 0)) best.set(hit.match, hit);
  }
  return [...best.values()];
}

export function trimCategories(json) {
  if (!Array.isArray(json)) return null;
  const want = [
    { id: "tokenized-private-credit", test: (c) => /private credit/i.test(c.name || "") || c.id === "tokenized-private-credit" },
    { id: "tokenized-treasuries", test: (c) => /treasur/i.test(c.name || "") || /t-bill/i.test(c.name || "") },
    { id: "real-world-assets-rwa", test: (c) => c.id === "real-world-assets-rwa" || /real.world.asset/i.test(c.name || "") },
  ];
  const out = [];
  for (const w of want) {
    const hit = json.find(w.test);
    if (!hit) continue;
    out.push({
      id: hit.id,
      name: hit.name,
      market_cap_usd: hit.market_cap ?? null,
      note: hit.id === "real-world-assets-rwa" ? "RWA-related tokens. The category includes assets that are not private credit." : null,
    });
  }
  return out.length ? out : null;
}

export function trimChainTvl(json) {
  if (!Array.isArray(json) || !json.length) return null;
  const last = json[json.length - 1];
  if (!last || typeof last.tvl !== "number") return null;
  return { date: last.date || null, tvl_usd: last.tvl };
}

/** Treasury daily yield curve XML. Regex trim, no XML library. Snapshot only. */
export function trimYieldCurveXml(xml) {
  if (typeof xml !== "string" || !xml.includes("BC_1MONTH")) return null;
  const blocks = xml.split(/<entry>/).slice(1);
  const parsed = [];
  for (const block of blocks) {
    const date = /<d:NEW_DATE[^>]*>([^<]+)/.exec(block);
    if (!date) continue;
    const num = (tag) => {
      const m = new RegExp(`<d:${tag}[^>]*>([^<]+)`).exec(block);
      return m ? Number(m[1]) : null;
    };
    parsed.push({
      date: date[1].slice(0, 10),
      m1: num("BC_1MONTH"),
      y2: num("BC_2YEAR"),
      y10: num("BC_10YEAR"),
      y30: num("BC_30YEAR"),
    });
  }
  if (!parsed.length) return null;
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  const latest = parsed[parsed.length - 1];
  const monthAgo = parsed.filter((p) => p.date <= shiftDays(latest.date, -28)).pop() || parsed[0];
  return { latest, earlier: monthAgo };
}

function shiftDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function snapshotEntry(id, value, extra = {}) {
  const spec = FEEDS[id] || extra;
  return {
    value,
    fetchedAt: extra.fetchedAt || new Date().toISOString(),
    source: extra.source || spec.source,
    sourceUrl: extra.sourceUrl || spec.url || null,
    licenceNote: extra.licenceNote || spec.licenceNote || "",
    attribution: extra.attribution || spec.attribution || "",
    attributionUrl: extra.attributionUrl || spec.attributionUrl || null,
    mode: value == null ? "error" : "snapshot",
    message: value == null ? (extra.message || "fetch failed") : null,
  };
}
