// Vercel serverless adapter for the mock bank-data API (cashflow/mockbank/server.mjs): synthetic data only, the
// three TEE documents of the 4 synthetic funds, read with ONE bearer token taken from env TRUENAV_DATA_TOKEN.
// vercel.json rewrites every path here; the original path arrives in ?__path= (or as req.url).
//
// Fails closed: with TRUENAV_DATA_TOKEN unset or shorter than 32 characters, every data route answers 503 and serves
// nothing. /health stays public. The token is never logged, echoed or written anywhere.
import { handler } from "../../../cashflow/mockbank/server.mjs";
import { fundDocs } from "../../../cashflow/mockbank/funds.mjs";

export const MIN_TOKEN_LENGTH = 32;
export const SNAPSHOT_ID = "synthetic-2026-11-08";

function failClosed(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  const ok = path === "/health";
  res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Synthetic-Data": "true" });
  res.end(JSON.stringify(ok ? { ok: true, synthetic: true, configured: false } : { error: "data token not configured" }));
}

/** The request handler for an environment: the mock bank with one all-funds token, or fail-closed. */
export function makeHandler(env = process.env) {
  const token = env.TRUENAV_DATA_TOKEN;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) return failClosed;
  return handler({ docs: fundDocs(), allFundsTokens: [token], snapshotId: SNAPSHOT_ID });
}

/** Put the original path back when the rewrite passed it as ?__path=. */
export function restorePath(rawUrl) {
  const u = new URL(rawUrl, "http://localhost");
  const p = u.searchParams.get("__path");
  if (p === null) return rawUrl;
  u.searchParams.delete("__path");
  const rest = u.searchParams.toString();
  return `${p.startsWith("/") ? p : `/${p}`}${rest ? `?${rest}` : ""}`;
}

let cached;
export default function vercelHandler(req, res) {
  cached ??= makeHandler(process.env);
  req.url = restorePath(req.url);
  return cached(req, res);
}
