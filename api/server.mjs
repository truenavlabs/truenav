// TrueNav agent API (build step 4, spec/v2/SPEC.md section 13). Reads receipts from the receipt contract and checks
// entitlements on the query contract; it never computes or changes a score, and a payment never reaches the score
// path (GET /score does not read the query contract at all).
//
//   GET  /health
//   GET  /fund/{token}/score    free: score, band, caps and holds with reasons, collection status, receipt hash
//   GET  /fund/{token}/report   needs header x-truenav-entitlement: <request_id> for a "report" entitlement bound to
//                               queryHash("report", token); spends its one use, returns the stored public receipt
//   POST /ask                   needs a "ask" entitlement bound to queryHash("ask", token); Q&A is build step 6, so
//                               this returns 501 after the check and spends nothing
//
// Without a usable entitlement the API answers 402 with exactly what to buy (contract, method, args, fee).
import { createServer as httpServer } from "node:http";
import { createHash } from "node:crypto";
import {validToken, decodeReceipt, publicV3} from "./receipt.mjs";

export const queryHash = (kind, token) => createHash("sha256").update(`${kind}|${token}`).digest("hex");
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY = 4096;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * chain: { view(contractId, method, args) -> value, redeem(requestId, queryHash) -> uses_left (throws on refusal),
 * nowNs() -> current chain time in ns as BigInt }. receipts, query: contract account ids. fee: yoctoNEAR string.
 */
export function handler({ chain, receipts, query, fee }) {
  const latest = (token) => chain.view(receipts, "get_latest", { token_id: token });
  const toBuy = (kind, token, why) => ({ error: "payment_required", reason: why, buy: { contract: query, method: "buy_query", args: { request_id: "<your unique id, 8 to 64 of [A-Za-z0-9_-]>", query_hash: queryHash(kind, token), kind }, attach_yocto: fee } });

  async function entitlement(req, kind, token) {
    const id = req.headers["x-truenav-entitlement"];
    if (!id) return { status: 402, body: toBuy(kind, token, "no entitlement given") };
    if (!REQUEST_ID.test(id)) return { status: 400, body: { error: "bad entitlement id" } };
    const e = await chain.view(query, "get_entitlement", { request_id: id });
    if (!e) return { status: 402, body: toBuy(kind, token, "unknown entitlement") };
    if (e.kind !== kind || e.query_hash !== queryHash(kind, token)) return { status: 403, body: { error: "entitlement is for another query" } };
    if (BigInt(e.expires_ns) <= (await chain.nowNs())) return { status: 402, body: toBuy(kind, token, "entitlement expired") };
    if (e.uses_left < 1) return { status: 402, body: toBuy(kind, token, "entitlement already used") };
    return { id, e };
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, receipts, query });
    const m = url.pathname.match(/^\/fund\/([^/]+)\/(score|report)$/);
    if (m) {
      if (req.method !== "GET") return send(res, 405, { error: "GET only" });
      const token = decodeURIComponent(m[1]);
      if (!validToken(token)) return send(res, 400, { error: "token must be an ASCII kebab id of 1 to 64 characters" });
      let r = await latest(token);
      if (!r) return send(res, 404, { error: "no receipt for this token" });
      let decoded;
      try { decoded = decodeReceipt(r); } catch (error) { return send(res, 502, {error:error.code ?? "receipt_invalid"}); }
      r = decoded.record;
      const rec = decoded.receipt;
      if (m[2] === "score") {
        if (decoded.version === "3") return send(res, 200, {...publicV3(rec), stored_block:r.block_height});
        const c = rec.metrics.collection;
        return send(res, 200, {
          token_id: token, seq: r.seq, method: r.method, version_key: r.version_key, period: r.period, as_of: r.as_of,
          score: r.score, band: r.band, uncapped_score: rec.uncapped_score, caps: rec.caps, holds: rec.holds,
          collection: { period: c.period, cutoff: c.cutoff, status: c.status, rate_bps: c.rate_bps },
          synthetic: rec.synthetic, receipt_sha256: r.receipt_sha256, stored_block: r.block_height,
        });
      }
      const ent = await entitlement(req, "report", token);
      if (!ent.e) return send(res, ent.status, ent.body);
      let usesLeft;
      try {
        usesLeft = await chain.redeem(ent.id, queryHash("report", token));
      } catch (e) {
        return send(res, 402, { error: "redeem refused", reason: String(e.message || e).slice(0, 200) });
      }
      return send(res, 200, { token_id: token, seq: r.seq, version_key: r.version_key, receipt_sha256: r.receipt_sha256, stored_block: r.block_height, entitlement: { request_id: ent.id, uses_left: usesLeft }, receipt: rec });
    }
    if (url.pathname === "/ask") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return send(res, 413, { error: "body too large" });
      }
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(res, 400, { error: "body must be JSON" });
      }
      const token = body.token_id;
      if (typeof token !== "string" || !validToken(token)) return send(res, 400, { error: "token_id must be an ASCII kebab id of 1 to 64 characters" });
      const ent = await entitlement(req, "ask", token);
      if (!ent.e) return send(res, ent.status, ent.body);
      return send(res, 501, { error: "qa_not_built", note: "private Q&A arrives in build step 6; nothing was spent", uses_left: ent.e.uses_left });
    }
    return send(res, 404, { error: "not found" });
  }

  return (req, res) =>
    route(req, res).catch(() => {
      if (!res.headersSent) send(res, 502, { error: "chain read failed" });
    });
}

export function createServer(opts) {
  return httpServer(handler(opts));
}
