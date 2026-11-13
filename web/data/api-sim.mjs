// Browser simulation of the paid report API's entitlement rules (api/server.mjs). A fake in-memory chain stands in
// for the query contract, which is not deployed. Same status codes and messages as the tested server. Nothing is sent.

export const FEE_YOCTO = "10000000000000000000000"; // 0.01 NEAR, api/main.mjs default
export const QUERY_CONTRACT = "the query contract (not deployed)";

const RECEIPTS = {
  "HONEST-CREDIT": { score: 100, band: "green", caps: [], holds: [], failed: false },
  "DEMO-CREDIT": { failed: true },
};

async function sha256Hex(s) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const queryHash = (kind, token) => sha256Hex(`${kind}|${token}`);

export function createSim() {
  const ents = new Map(); // request_id -> { buyer, kind, query_hash, uses_left, expires_ms }
  let spentYocto = 0n, seq = 0;
  const toBuy = async (token, why) => ({ error: "payment_required", reason: why, buy: { contract: QUERY_CONTRACT, method: "buy_query", args: { request_id: "<your unique id>", query_hash: await queryHash("report", token), kind: "report" }, attach_yocto: FEE_YOCTO } });

  async function score(token) {
    const r = RECEIPTS[token];
    if (!r) return { status: 404, body: { error: "no receipt for this token" } };
    if (r.failed) return { status: 409, body: { error: "run_failed" } };
    return { status: 200, body: { token_id: token, score: r.score, band: r.band, caps: r.caps, holds: r.holds, synthetic: true } };
  }
  async function report(token, { entitlement, buyer, now = Date.now() } = {}) {
    const r = RECEIPTS[token];
    if (!r) return { status: 404, body: { error: "no receipt for this token" } };
    if (r.failed) return { status: 409, body: { error: "run_failed" } }; // refused before any redeem: nothing is spent
    if (!entitlement) return { status: 402, body: await toBuy(token, "no entitlement given") };
    const e = ents.get(entitlement);
    if (!e) return { status: 402, body: await toBuy(token, "unknown entitlement") };
    if (buyer !== e.buyer) return { status: 403, body: { error: "entitlement is bound to another buyer" } };
    if (e.kind !== "report" || e.query_hash !== (await queryHash("report", token))) return { status: 403, body: { error: "entitlement is for another query" } };
    if (e.expires_ms <= now) return { status: 402, body: await toBuy(token, "entitlement expired") };
    if (e.uses_left < 1) return { status: 402, body: await toBuy(token, "entitlement already used") };
    e.uses_left -= 1;
    return { status: 200, body: { token_id: token, entitlement: { request_id: entitlement, uses_left: e.uses_left }, receipt: { score: r.score, band: r.band, caps: r.caps, holds: r.holds, synthetic: true } } };
  }
  async function buy(token, buyer, { now = Date.now(), ttlMs = 3600e3 } = {}) {
    const request_id = `demo-${++seq}`;
    ents.set(request_id, { buyer, kind: "report", query_hash: await queryHash("report", token), uses_left: 1, expires_ms: now + ttlMs });
    spentYocto += BigInt(FEE_YOCTO);
    return { request_id, uses_left: 1, attached_yocto: FEE_YOCTO };
  }
  return { score, report, buy, spent: () => spentYocto, entitlements: ents };
}
