// Vercel serverless adapter for the mock bank-data API (cashflow/mockbank/server.mjs): synthetic data only, the
// three TEE documents of the 4 synthetic funds, read with ONE bearer token taken from env TRUENAV_DATA_TOKEN.
// vercel.json rewrites every path here; the original path arrives in ?__path= (or as req.url).
//
// Fails closed: with TRUENAV_DATA_TOKEN unset or shorter than 32 characters, every data route answers 503 and serves
// nothing. /health stays public. The token is never logged, echoed or written anywhere.
import { handler, BASE_HEADERS } from "../runtime/mockbank/server.mjs";
import { fundDocs } from "../runtime/mockbank/funds.mjs";

export const MIN_TOKEN_LENGTH = 32;
export const SNAPSHOT_ID = "synthetic-2026-11-08";

function failClosed(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  const ok = path === "/health";
  res.writeHead(ok ? 200 : 503, BASE_HEADERS);
  res.end(JSON.stringify(ok ? { ok: true, synthetic: true, configured: false } : { error: "data token not configured" }));
}

/** The request handler for an environment: the mock bank with one all-funds token, or fail-closed. */
export function makeHandler(env = process.env) {
  const token = env.TRUENAV_DATA_TOKEN;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) return failClosed;
  return handler({ docs: fundDocs(), allFundsTokens: [token], snapshotId: SNAPSHOT_ID });
}

/**
 * A plain local path: one leading "/", then only letters, digits and - . _ ~ / with no "//" and no "." or ".."
 * segment. Anything else (a second leading slash, a scheme, %00 or any control character, a backslash, %, ?, #) is
 * not one.
 */
export const isPlainPath = (p) => typeof p === "string" && /^\/[A-Za-z0-9._~\-\/]*$/.test(p) && !p.includes("//") && !p.split("/").some((s) => s === "." || s === "..");

/**
 * Put the original path back when the rewrite passed it as ?__path=. Returns null when the path (the __path value,
 * or the request's own path) is not a plain local path; the caller answers 404.
 */
export function restorePath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return null;
  const q = rawUrl.indexOf("?");
  const ownPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const params = new URLSearchParams(q < 0 ? "" : rawUrl.slice(q + 1));
  if (!params.has("__path")) return isPlainPath(ownPath) ? rawUrl : null;
  const all = params.getAll("__path");
  if (all.length !== 1 || !isPlainPath(all[0])) return null;
  params.delete("__path");
  const rest = params.toString();
  return `${all[0]}${rest ? `?${rest}` : ""}`;
}

function notFound(res) {
  res.writeHead(404, BASE_HEADERS);
  res.end(JSON.stringify({ error: "not found" }));
}

let cached;
export default function vercelHandler(req, res) {
  cached ??= makeHandler(process.env);
  const url = restorePath(req.url);
  if (url === null) return notFound(res);
  req.url = url;
  return cached(req, res);
}
