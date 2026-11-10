// TrueNav agent API (build step 4, spec/v2/SPEC.md section 13). Reads receipts from the receipt contract and checks
// entitlements on the query contract; it never computes or changes a score, and a payment never reaches the score
// path (GET /score does not read the query contract at all).
//
//   GET  /health
//   GET  /fund/{token}/score    free: score, band, caps and holds with reasons, collection status, receipt hash
//   GET  /fund/{token}/report   needs header x-truenav-entitlement: <request_id> and x-truenav-buyer: <account>
//                               for a "report" entitlement bound to queryHash("report", token) and to that buyer;
//                               spends its one use, returns the stored public receipt
//   POST /ask                   needs a "ask" entitlement bound to queryHash("ask", token); Q&A is build step 6, so
//                               this returns 501 after the check and spends nothing
//
// Without a usable entitlement the API answers 402 with exactly what to buy (contract, method, args, fee).
import { createServer as httpServer } from "node:http";
import {verifyRecord} from "../agent/agent.mjs";
import { createHash } from "node:crypto";
import { PublicKey } from "near-api-js";
import {validToken, decodeReceipt, publicV3, spendMessage} from "./receipt.mjs";
import { BUYER_LIMIT, BUYER_WINDOW_MS, createCheapLimiter, reserveSpend } from "./spend-store.mjs";

export const queryHash = (kind, token) => createHash("sha256").update(`${kind}|${token}`).digest("hex");
export { spendMessage };
function buyerProofOk(keys, message, sigB64) {
  let sig;
  try { sig = Buffer.from(String(sigB64), "base64"); } catch { return false; }
  if (sig.length !== 64) return false;
  for (const k of keys || []) {
    try {
      if (PublicKey.from(k.public_key || k).verify(message, sig)) return true;
    } catch { /* skip a key this runtime cannot parse */ }
  }
  return false;
}
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BODY = 4096;
const SPEND_TTL_MS = 5 * 60 * 1000;
export { SPEND_TTL_MS, BUYER_LIMIT, BUYER_WINDOW_MS };

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * chain: { view(contractId, method, args) -> value, redeem(requestId, queryHash) -> uses_left (throws on refusal),
 * nowNs() -> current chain time in ns as BigInt }. receipts, query: contract account ids. fee: yoctoNEAR string.
 */
export function handler({ chain, receipts, query, fee, spendStore, preIpLimit, preBuyerLimit, trustProxy = false, proxyHops = 1 }) {
  const latest = (token) => chain.view(receipts, "get_latest", { token_id: token });
  const toBuy = (kind, token, why) => ({ error: "payment_required", reason: why, buy: { contract: query, method: "buy_query", args: { request_id: "<your unique id, 8 to 64 of [A-Za-z0-9_-]>", query_hash: queryHash(kind, token), kind }, attach_yocto: fee } });
  const cheap = createCheapLimiter({ ipLimit: preIpLimit, buyerLimit: preBuyerLimit });
  const inflight = new Map();
  // One redeem at a time per request id. The next caller re-reads uses_left after the first redeem settles.
  function singleFlight(key, fn) {
    const prev = inflight.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    inflight.set(key, settled);
    settled.then(() => { if (inflight.get(key) === settled) inflight.delete(key); });
    return run;
  }

  function clientIp(req) {
    if (trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.length > 0 && forwarded.length <= 8192) {
        const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
        const hops = Number.isInteger(proxyHops) && proxyHops > 0 ? proxyHops : 1;
        const index = parts.length - hops;
        if (index >= 0 && parts[index].length <= 128) return parts[index];
      }
    }
    return req.socket?.remoteAddress || "unknown";
  }
  function limitedIp(req) {
    const buyer = req.headers["x-truenav-buyer"];
    if (typeof buyer === "string" && buyer.length > 128) return { status: 400, body: { error: "buyer header too long" } };
    const ip = clientIp(req);
    try {
      if (!cheap.allow("ip", ip, Date.now())) return { status: 429, body: { error: "ip rate limit" } };
    } catch (error) {
      if (error.code === "rate_key_rejected") return { status: 400, body: { error: "bad client address" } };
      throw error;
    }
    return null;
  }

  async function entitlement(req, kind, token) {
    const id = req.headers["x-truenav-entitlement"];
    if (!id) return { status: 402, body: toBuy(kind, token, "no entitlement given") };
    if (!REQUEST_ID.test(id)) return { status: 400, body: { error: "bad entitlement id" } };
    if (!spendStore) return { status: 503, body: { error: "spend store is not configured" } };
    const e = await chain.view(query, "get_entitlement", { request_id: id });
    if (!e) return { status: 402, body: toBuy(kind, token, "unknown entitlement") };
    if (req.headers["x-truenav-buyer"] !== String(e.buyer)) return { status: 403, body: { error: "entitlement is bound to another buyer" } };
    const sig = req.headers["x-truenav-buyer-sig"];
    const nonce = req.headers["x-truenav-buyer-nonce"];
    const expRaw = req.headers["x-truenav-buyer-exp"];
    if (typeof sig !== "string" || sig.length === 0 || typeof nonce !== "string" || !NONCE.test(nonce) || typeof expRaw !== "string" || !/^[0-9]{1,16}$/.test(expRaw) || typeof chain.accessKeys !== "function") return { status: 403, body: { error: "buyer proof required" } };
    const exp = Number(expRaw);
    const nowMs = Number((await chain.nowNs()) / 1_000_000n);
    if (!Number.isSafeInteger(exp) || exp <= nowMs) return { status: 403, body: { error: "spend proof expired" } };
    if (exp > nowMs + SPEND_TTL_MS) return { status: 403, body: { error: "spend proof expiry is too far" } };
    const keys = await chain.accessKeys(String(e.buyer));
    if (!buyerProofOk(keys, spendMessage({ audience: query, id, kind, token, nonce, exp: expRaw }), sig)) return { status: 403, body: { error: "buyer proof does not match the entitlement" } };
    try {
      if (!cheap.allow("buyer", String(e.buyer), nowMs)) return { status: 429, body: { error: "buyer rate limit" } };
    } catch (error) {
      if (error.code === "rate_key_rejected") return { status: 400, body: { error: "bad buyer" } };
      throw error;
    }
    if (e.kind !== kind || e.query_hash !== queryHash(kind, token)) return { status: 403, body: { error: "entitlement is for another query" } };
    if (BigInt(e.expires_ns) <= (await chain.nowNs())) return { status: 402, body: toBuy(kind, token, "entitlement expired") };
    if (e.uses_left < 1) return { status: 402, body: toBuy(kind, token, "entitlement already used") };
    let reserved;
    try {
      reserved = await reserveSpend(spendStore, { buyer: String(e.buyer), nonce: `${query}|${nonce}`, nowMs, exp, limit: BUYER_LIMIT, windowMs: BUYER_WINDOW_MS });
    } catch (error) {
      console.error(`spend store closed: ${error.message}`);
      return { status: 503, body: { error: "spend store closed" } };
    }
    if (!reserved.ok) return { status: reserved.error === "buyer rate limit" ? 429 : 403, body: { error: reserved.error } };
    return { id, e };
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, receipts, query });
    const m = url.pathname.match(/^\/fund\/([^/]+)\/(score|report)$/);
    if (m) {
      if (req.method !== "GET") return send(res, 405, { error: "GET only" });
      let token;
      try { token = decodeURIComponent(m[1]); }
      catch { return send(res, 400, { error: "bad token encoding" }); }
      if (!validToken(token)) return send(res, 400, { error: "token must be an ASCII kebab id of 1 to 64 characters" });
      const early = limitedIp(req);
      if (early) return send(res, early.status, early.body);
      let r = await latest(token);
      if (!r) return send(res, 404, { error: "no receipt for this token" });
      let decoded;
      try { decoded = decodeReceipt(r); } catch (error) { return send(res, 502, {error:error.code ?? "receipt_invalid"}); }
      if (m[2] === "score" && decoded.version === "3" && decoded.receipt?.head_status === "failed") {
        return send(res, 409, {error: "run_failed"});
      }
      if(decoded.version === "3") { const bad=verifyRecord(token,r); if(bad) return send(res,502,{error:bad}); }
      r = decoded.record;
      const rec = decoded.receipt;
      if (m[2] === "score") {
        if (decoded.version === "3") return send(res, 200, { ...publicV3(rec), receipt_sha256: r.receipt_sha256, public_sha256: r.receipt_sha256, attestation: "unattested" });
        const allowed = new Set(["receipt_version","token_id","seq","method_version","engine_version_key","score","band","caps","holds","synthetic","receipt_sha256"]);
        const body = {
          receipt_version: "2",
          token_id: token,
          seq: r.seq,
          method_version: r.method,
          engine_version_key: r.version_key,
          score: r.score,
          band: r.band,
          caps: Array.isArray(rec.caps) ? rec.caps.map((c) => (c && typeof c === "object" ? c.code : c)) : [],
          holds: Array.isArray(rec.holds) ? rec.holds.map((h) => (h && typeof h === "object" ? h.code : h)) : [],
          synthetic: rec.synthetic,
          receipt_sha256: r.receipt_sha256,
        };
        for (const key of Object.keys(body)) if (!allowed.has(key)) delete body[key];
        return send(res, 200, body);
      }
      const reportId = req.headers["x-truenav-entitlement"];
      const spend = async () => {
        const ent = await entitlement(req, "report", token);
        if (!ent.e) return { status: ent.status, body: ent.body };
        let usesLeft;
        try {
          usesLeft = await chain.redeem(ent.id, queryHash("report", token));
        } catch (e) {
          return { status: 402, body: { error: "redeem refused", reason: String(e.message || e).slice(0, 200) } };
        }
        const receipt = decoded.version === "3" ? { ...publicV3(rec), attestation: "unattested" } : {
          receipt_version: "2", token_id: token, seq: r.seq, method_version: r.method, engine_version_key: r.version_key,
          score: r.score, band: r.band,
          caps: Array.isArray(rec.caps) ? rec.caps.map((c) => (c && typeof c === "object" ? c.code : c)) : [],
          holds: Array.isArray(rec.holds) ? rec.holds.map((h) => (h && typeof h === "object" ? h.code : h)) : [],
          synthetic: rec.synthetic, receipt_sha256: r.receipt_sha256,
        };
        return { status: 200, body: { token_id: token, seq: r.seq, engine_version_key: r.version_key, receipt_sha256: r.receipt_sha256, entitlement: { request_id: ent.id, uses_left: usesLeft }, receipt } };
      };
      const spent = (typeof reportId === "string" && REQUEST_ID.test(reportId)) ? await singleFlight(reportId, spend) : await spend();
      return send(res, spent.status, spent.body);
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
      const early = limitedIp(req);
      if (early) return send(res, early.status, early.body);
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
