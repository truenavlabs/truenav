// Mock bank-data API (synthetic, labeled synthetic in every response). It stands in for a bank-aggregator API that
// the TrueNav TEE calls itself with a sealed read-only token. Frozen snapshots only: the same request always returns
// the same bytes, and the response carries their sha256 so a receipt can record the evidence hash (reproducibility
// is claimed only against a frozen snapshot, owner decision 7 Nov).
//
//   GET /health
//   GET /v1/accounts/{account_id}/transactions      Authorization: Bearer <token bound to that account>
//
// Tokens map to exactly one account and are read-only. A wrong or missing token is 401, a token for another account
// is 403, an unknown account is 404. Nothing here ever accepts a write.
import { createServer as httpServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const json = (res, status, body, headers = {}) => {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Synthetic-Data": "true", ...headers });
  res.end(bytes);
};
const sameToken = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** feeds: { account_id: feed }  tokens: { token: account_id }  snapshotId: label of the frozen snapshot. */
export function handler({ feeds, tokens, snapshotId = "frozen-2026-10-31" }) {
  const bodies = Object.fromEntries(
    Object.entries(feeds).map(([acct, feed]) => {
      const body = { synthetic: true, notice: "Synthetic demo data. Not a real bank.", snapshot_id: snapshotId, account_id: acct, transactions: feed.transactions };
      const bytes = Buffer.from(JSON.stringify(body));
      return [acct, { bytes, sha: createHash("sha256").update(bytes).digest("hex") }];
    }),
  );
  return (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") return json(res, 405, { error: "read only" }, { Allow: "GET" });
    if (url.pathname === "/health") return json(res, 200, { ok: true, synthetic: true });
    const m = url.pathname.match(/^\/v1\/accounts\/([A-Za-z0-9._-]{1,64})\/transactions$/);
    if (!m) return json(res, 404, { error: "not found" });
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const entry = Object.entries(tokens).find(([t]) => token && sameToken(t, token));
    if (!entry) return json(res, 401, { error: "missing or invalid token" });
    if (!bodies[m[1]]) return json(res, 404, { error: "unknown account" });
    if (entry[1] !== m[1]) return json(res, 403, { error: "token not valid for this account" });
    const b = bodies[m[1]];
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Synthetic-Data": "true", "X-Snapshot-Id": snapshotId, "X-Snapshot-Sha256": b.sha });
    res.end(b.bytes);
  };
}

export function createServer(opts) {
  return httpServer(handler(opts));
}
