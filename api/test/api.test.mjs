// API gates with an in-memory chain that behaves like the two contracts: the score is free, the report needs an
// unused report entitlement bound to that token and spends it once, /ask checks without spending, and a purchase
// never changes what /score returns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, queryHash } from "../server.mjs";

const fx = JSON.parse(readFileSync(new URL("../../receipts/tests/fixtures/engine-receipts.json", import.meta.url))).receipts;
// the pinned engine build, read from BUILD.md (a public wasm sha256)
const PIN = readFileSync(new URL("../../outlayer/engine-v2/BUILD.md", import.meta.url), "utf8").match(/^\| wasm sha256 \| `([0-9a-f]{64})`/m)[1];
const stored = (token, seq = 1) => {
  const rec = JSON.parse(fx[token].output);
  return { token_id: token, seq, request_id: 1, method: rec.method, version_key: PIN, score: rec.score, band: rec.band, period: rec.period, as_of: rec.as_of, caps: rec.caps.map((c) => c.code), holds: rec.holds.map((h) => h.code), receipt_sha256: "ab".repeat(32), receipt: fx[token].output, requested_ns: 1, stored_ns: 2, block_height: 100 };
};
const NOW = 5_000_000_000n;
const ents = new Map();
const redeems = [];
const chain = {
  async view(contract, method, args) {
    if (contract === "receipts.test" && method === "get_latest") return ["DEMO-CREDIT", "HONEST-RENTAL"].includes(args.token_id) ? stored(args.token_id) : null;
    if (contract === "query.test" && method === "get_entitlement") return ents.get(args.request_id) || null;
    throw new Error(`unexpected view ${contract}.${method}`);
  },
  async nowNs() {
    return NOW;
  },
  async redeem(id, hash) {
    const e = ents.get(id);
    if (!e || e.query_hash !== hash || e.uses_left < 1) throw new Error("Smart contract panicked: entitlement already used");
    e.uses_left -= 1;
    redeems.push(id);
    return e.uses_left;
  },
};
const buy = (id, kind, token, extra = {}) => ents.set(id, { request_id: id, buyer: "agent.test", kind, query_hash: queryHash(kind, token), paid: "10000000000000000000000", created_ns: "1", expires_ns: String(NOW + 1000n), uses_left: kind === "ask" ? 20 : 1, ...extra });

let server;
let base;
before(async () => {
  server = createServer({ chain, receipts: "receipts.test", query: "query.test", fee: "10000000000000000000000" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const get = (p, id) => fetch(base + p, { headers: id ? { "x-truenav-entitlement": id } : {} });
const ask = (body, id) => fetch(base + "/ask", { method: "POST", headers: { "content-type": "application/json", ...(id ? { "x-truenav-entitlement": id } : {}) }, body: JSON.stringify(body) });

test("GET /score is free and reads only the receipt contract", async () => {
  const r = await get("/fund/DEMO-CREDIT/score");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.score, 58);
  assert.equal(b.band, "red");
  assert.deepEqual(b.caps.map((c) => c.code), ["yield_gap", "claimed_not_settled", "collection_shortfall"]);
  assert.match(b.caps[2].reason, /unverified collection: 78\.57%/);
  assert.deepEqual(b.collection, { period: "2026-09", cutoff: "2026-10-07", status: "verified", rate_bps: 7857 });
  assert.deepEqual(b.holds, []);
  assert.equal(b.version_key, PIN);
});

test("GET /report without an entitlement is 402 with exactly what to buy", async () => {
  const r = await get("/fund/DEMO-CREDIT/report");
  assert.equal(r.status, 402);
  const b = await r.json();
  assert.equal(b.buy.contract, "query.test");
  assert.equal(b.buy.method, "buy_query");
  assert.equal(b.buy.args.query_hash, queryHash("report", "DEMO-CREDIT"));
  assert.equal(b.buy.args.kind, "report");
  assert.equal(b.buy.attach_yocto, "10000000000000000000000");
});

test("a report entitlement is spent once and returns the stored public receipt", async () => {
  buy("req-report-0001", "report", "DEMO-CREDIT");
  const r = await get("/fund/DEMO-CREDIT/report", "req-report-0001");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.receipt, JSON.parse(fx["DEMO-CREDIT"].output));
  assert.equal(b.entitlement.uses_left, 0);
  const again = await get("/fund/DEMO-CREDIT/report", "req-report-0001");
  assert.equal(again.status, 402);
  assert.equal((await again.json()).reason, "entitlement already used");
  assert.deepEqual(redeems, ["req-report-0001"]);
});

test("an entitlement for another token or kind, an expired one or a bad id is refused without spending", async () => {
  buy("req-report-other", "report", "HONEST-RENTAL");
  assert.equal((await get("/fund/DEMO-CREDIT/report", "req-report-other")).status, 403);
  buy("req-ask-as-report", "ask", "DEMO-CREDIT");
  assert.equal((await get("/fund/DEMO-CREDIT/report", "req-ask-as-report")).status, 403);
  buy("req-report-expired", "report", "DEMO-CREDIT", { expires_ns: String(NOW) });
  const exp = await get("/fund/DEMO-CREDIT/report", "req-report-expired");
  assert.equal(exp.status, 402);
  assert.equal((await exp.json()).reason, "entitlement expired");
  assert.equal((await get("/fund/DEMO-CREDIT/report", "x")).status, 400);
  assert.equal((await get("/fund/DEMO-CREDIT/report", "req-never-bought")).status, 402);
  assert.equal(ents.get("req-report-other").uses_left, 1);
  assert.equal(ents.get("req-report-expired").uses_left, 1);
});

test("POST /ask checks an ask entitlement and spends nothing until Q&A is built (501)", async () => {
  assert.equal((await ask({ token_id: "DEMO-CREDIT", question: "what is the collection rate?" })).status, 402);
  buy("req-ask-0001", "ask", "DEMO-CREDIT");
  const r = await ask({ token_id: "DEMO-CREDIT", question: "what is the collection rate?" }, "req-ask-0001");
  assert.equal(r.status, 501);
  assert.equal(ents.get("req-ask-0001").uses_left, 20);
  assert.equal((await ask({ token_id: "lower" }, "req-ask-0001")).status, 400);
});

test("a purchase never changes the score response", async () => {
  const a = await (await get("/fund/HONEST-RENTAL/score")).json();
  buy("req-report-hr-01", "report", "HONEST-RENTAL");
  assert.equal((await get("/fund/HONEST-RENTAL/report", "req-report-hr-01")).status, 200);
  const b = await (await get("/fund/HONEST-RENTAL/score")).json();
  assert.deepEqual(b, a);
});

test("unknown token 404, malformed token 400, wrong method 405, unknown path 404", async () => {
  assert.equal((await get("/fund/NO-SUCH-TOKEN/score")).status, 404);
  assert.equal((await get("/fund/bad%20token/score")).status, 400);
  assert.equal((await fetch(base + "/fund/DEMO-CREDIT/score", { method: "POST" })).status, 405);
  assert.equal((await get("/nope")).status, 404);
});
