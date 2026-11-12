// Formatting only. Money arrives as integer cents (numbers or strings); times as ms since epoch or ISO strings.
export const TZ = "Asia/Bangkok";

export function usd(cents: number | string | null | undefined, digits = 0): string {
  if (cents === null || cents === undefined || cents === "") return "n/a";
  const v = Number(cents) / 100;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function usdM(cents: number | string | null | undefined, digits = 2): string {
  if (cents === null || cents === undefined) return "n/a";
  const v = Number(cents) / 1e8;
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(digits)}M`;
}
export const usdWhole = (dollars: number) => `${dollars < 0 ? "-" : ""}$${Math.round(Math.abs(dollars)).toLocaleString("en-US")}`;
export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
export const int = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : n.toLocaleString("en-US"));

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function f(opts: Intl.DateTimeFormatOptions) {
  const k = JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }));
  return fmtCache.get(k)!;
}
const toDate = (t: number | string) => new Date(typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t);
/** "11 Nov 22:41" in Bangkok time. */
export function when(t: number | string | null | undefined): string {
  if (t === null || t === undefined) return "n/a";
  const d = toDate(t);
  if (Number.isNaN(d.getTime())) return "n/a";
  return `${f({ day: "numeric", month: "short" }).format(d)} ${f({ hour: "2-digit", minute: "2-digit", hour12: false }).format(d)}`;
}
export const whenFull = (t: number | string | null | undefined) => (t === null || t === undefined ? "n/a" : `${when(t)} Bangkok`);
export const clock = (t: number | string) => f({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(toDate(t));
export const dayKey = (t: number) => f({ year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function countdown(ms: number): string {
  if (ms < 0) return "expired";
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `${d}d ${h}h left` : `${h}h ${m}m left`;
}
export const short = (h: string | null | undefined, a = 6, z = 4) => (!h ? "n/a" : h.length > a + z + 3 ? `${h.slice(0, a)}...${h.slice(-z)}` : h);
export const assetLabel = (a: string | null | undefined) => (a === "real_estate" ? "Real estate" : a === "invoices" ? "Invoices" : a || "unknown");
export const FUND_NAMES: Record<string, string> = { "harbor-credit-fund": "Harbor Credit Fund", "meridian-yield-fund": "Meridian Yield Fund" };
export const fundName = (id: string | null | undefined) => (id ? FUND_NAMES[id] ?? id : "n/a");
export const EXPLORER = "https://testnet.nearblocks.io";
export const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;
export const accountUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const REPO = "https://github.com/truenavlabs/truenav";
export const srcUrl = (path: string) => `${REPO}/blob/main/${path}`;
