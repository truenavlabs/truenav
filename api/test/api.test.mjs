// API gates with an in-memory chain that behaves like the two contracts: the score is free, the report needs an
// unused report entitlement bound to that token and spends it once, /ask checks without spending, and a purchase
// never changes what /score returns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { createServer, queryHash, spendMessage } from "../server.mjs";
import { initSpendStore } from "../spend-store.mjs";
import { canonical } from "../receipt.mjs";

const fx = JSON.parse(readFileSync(new URL("../../receipts/tests/fixtures/engine-receipts.json", import.meta.url))).receipts;
// the pinned engine build, read from BUILD.md (a public wasm sha256)
const PIN = readFileSync(new URL("../../outlayer/engine-v2/BUILD.md", import.meta.url), "utf8").match(/^\| wasm sha256 \| `([0-9a-f]{64})`/m)[1];
const stored = (token, seq = 1) => {
  const rec = JSON.parse(fx[token].output);
  return { token_id: token, seq, request_id: 1, method: rec.method, version_key: PIN, score: rec.score, band: rec.band, period: rec.period, as_of: rec.as_of, caps: rec.caps.map((c) => c.code), holds: rec.holds.map((h) => h.code), receipt_sha256: "ab".repeat(32), receipt: fx[token].output, requested_ns: 1, stored_ns: 2, block_height: 100 };
};
const NOW = 5_000_000_000n;
const buyerKey = KeyPair.fromRandom("ed25519");
const EXP = "60000";
const spendStore = await initSpendStore(mkdtempSync(join(tmpdir(), "truenav-api-spend-")), { create: true });
const buyerProof = (id, kind, token, audience = "query.test") => {
  const nonce = randomBytes(16).toString("hex");
  const sig = Buffer.from(buyerKey.sign(spendMessage({ audience, id, kind, token, nonce, exp: EXP })).signature).toString("base64");
  return { nonce, exp: EXP, sig };
};
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
  async accessKeys() {
    return [{ public_key: buyerKey.getPublicKey().toString() }];
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
  server = createServer({ chain, receipts: "receipts.test", query: "query.test", fee: "10000000000000000000000", spendStore });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const auth = (id, kind, token) => {
  if (!id) return {};
  const proof = buyerProof(id, kind, token);
  return { "x-truenav-entitlement": id, "x-truenav-buyer": "agent.test", "x-truenav-buyer-sig": proof.sig, "x-truenav-buyer-nonce": proof.nonce, "x-truenav-buyer-exp": proof.exp };
};
const get = (p, id) => fetch(base + p, { headers: auth(id, p.endsWith("/report") ? "report" : "ask", p.split("/")[2]) });
const ask = (body, id) => fetch(base + "/ask", { method: "POST", headers: { "content-type": "application/json", ...auth(id, "ask", body.token_id) }, body: JSON.stringify(body) });

test("GET /score is free and reads only the receipt contract", async () => {
  const r = await get("/fund/DEMO-CREDIT/score");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.score, 58);
  assert.equal(b.band, "red");
  assert.deepEqual(b.caps, ["yield_gap", "claimed_not_settled", "collection_shortfall"]);
  assert.equal(b.uncapped_score, undefined);
  assert.equal(b.collection, undefined);
  assert.deepEqual(b.holds, []);
  assert.equal(b.method_version, "cashflow-v2.1.0");
  assert.equal(b.engine_version_key, PIN);
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
  assert.equal(b.receipt.uncapped_score, undefined);
  assert.equal(b.receipt.score, 58);
  assert.deepEqual(b.receipt.caps, ["yield_gap", "claimed_not_settled", "collection_shortfall"]);
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
  assert.equal((await ask({ token_id: "bad_token" }, "req-ask-0001")).status, 400);
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

const v3 = JSON.parse(readFileSync(new URL('../../schema/vectors/engine-v3-derived.json',import.meta.url))).vectors[0].envelope;
const v3Stored = canonical(v3);
const v3Digest = createHash('sha256').update(v3Stored).digest('hex');
const v3Record = () => ({token_id:v3.token_id,seq:Number(v3.seq),method:v3.method_version,version_key:v3.engine_version_key,score:v3.score,band:v3.band,caps:v3.caps,holds:v3.holds,period:`${v3.period_start}/${v3.period_end}`,as_of:v3.valuation_time,receipt_sha256:v3Digest,public_sha256:v3Digest,receipt:v3Stored,block_height:100});
async function withRecord(record, fn) {
  let spent=0;
  const local=createServer({chain:{...chain,async view(c,m,a){if(m==='get_latest')return record;return chain.view(c,m,a);},async redeem(){spent++;return 0;}},receipts:'receipts.test',query:'query.test',fee:'10000000000000000000000',spendStore});
  await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
  try {await fn(`http://127.0.0.1:${local.address().port}`,()=>spent);} finally {await new Promise(resolve=>local.close(resolve));}
}
test('v3 score and report use public bands and rounded NAV, including lowercase vector ids',async()=>{
  for(const record of [v3Record()]) await withRecord(record,async url=>{
    const response=await fetch(`${url}/fund/${v3.token_id}/score`);assert.equal(response.status,200);
    const score=await response.json();assert.equal(score.receipt_version,'3');assert.equal(score.score,99);assert.equal(score.receipt_sha256,v3Digest);assert.equal(score.public_sha256,v3Digest);
    for(const key of ['trueval','truerange_low','truerange_high','reported_nav','parts_band','pledge_result','collection_rate_band'])assert.deepEqual(score[key],v3[key]);
    for(const key of ['uncapped_score','raw_score','score_x100','parts_x100','metrics'])assert.equal(Object.hasOwn(score,key),false);
    buy('v3-report-test','report',v3.token_id);
    const proof=buyerProof('v3-report-test','report',v3.token_id);const report=await fetch(`${url}/fund/${v3.token_id}/report`,{headers:{'x-truenav-entitlement':'v3-report-test','x-truenav-buyer':'agent.test','x-truenav-buyer-sig':proof.sig,'x-truenav-buyer-nonce':proof.nonce,'x-truenav-buyer-exp':proof.exp}});assert.equal(report.status,200);const shown=(await report.json()).receipt;assert.equal(shown.score,v3.score);assert.equal(shown.receipt_sha256,v3.receipt_sha256);assert.equal(shown.uncapped_score,undefined);
  });
});
test('corrupt v3 is an explicit 502 and never consumes an entitlement',async()=>{
  for(const record of [{receipt_version:'3',error:'v3_receipt_corrupt'},{...v3Record(),receipt:'{'}])await withRecord(record,async(url,spent)=>{
    for(const path of ['score','report']){const response=await fetch(`${url}/fund/${v3.token_id}/${path}`);assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'v3_receipt_corrupt'});}
    assert.equal(spent(),0);
  });
});
test('explicit v2 wrapper tag keeps score and report response bytes identical',async()=>{
  const bytes=[];
  for(const record of [stored('DEMO-CREDIT'),{...stored('DEMO-CREDIT'),receipt_version:'2'}])await withRecord(record,async url=>{
    buy('v2-byte-test','report','DEMO-CREDIT');
    const proof=buyerProof('v2-byte-test','report','DEMO-CREDIT');bytes.push([await (await fetch(url+'/fund/DEMO-CREDIT/score')).text(),await (await fetch(url+'/fund/DEMO-CREDIT/report',{headers:{'x-truenav-entitlement':'v2-byte-test','x-truenav-buyer':'agent.test','x-truenav-buyer-sig':proof.sig,'x-truenav-buyer-nonce':proof.nonce,'x-truenav-buyer-exp':proof.exp}})).text()]);
  });
  assert.deepEqual(bytes[1],bytes[0]);
  assert.equal(bytes[0][0].includes('uncapped_score'), false);
  assert.equal(bytes[0][0].includes('rate_bps'), false);
  assert.equal(bytes[0][1].includes('parts_x100'), false);
  assert.equal(bytes[0][1].includes('cash_received_cents'), false);
});
test('API token grammar matches case-sensitive contract kebab segments',async()=>{
 const {validToken}=await import('../receipt.mjs');
 for(const id of [v3.token_id,'DEMO-CREDIT','A1-b2'])assert.equal(validToken(id),true);
 for(const id of ['', '-fund','fund-','fund--id','bad_token','fund\n','fúnd','a'.repeat(65)])assert.equal(validToken(id),false);
});
test('v3 score rejects changed hash and wrong token',async()=>{
 const changed=v3Record();
 changed.receipt=canonical({...v3,score:98});
 await withRecord(changed,async url=>{
  const response=await fetch(`${url}/fund/${v3.token_id}/score`);
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/receipt_sha256_mismatch/);
 });
 await withRecord(v3Record(),async url=>{
  const response=await fetch(`${url}/fund/other-fund/score`);
  assert.equal(response.status,502);
  assert.match((await response.json()).error,/receipt_token_mismatch/);
 });
});
