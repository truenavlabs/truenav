// Mock bank-data API: read-only, token bound to one account, frozen bytes with their sha256, synthetic label.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "../mockbank/server.mjs";
import { FUNDS, fundDocs } from "../mockbank/funds.mjs";
import { datasets } from "../demo/data.mjs";
import { settledFromFeed } from "../adapters/bank.mjs";

const feeds = Object.fromEntries(datasets().map((d) => [d.bank_feed.account_id, d.bank_feed]));
const tokens = { "tok-credit-test-0001": "DEMO-CREDIT-operating", "tok-rental-test-0002": "DEMO-RENTAL-operating", "tok-tee-rental-0003": "DEMO-RENTAL" };
const docs = Object.fromEntries(datasets().map((d) => [d.id, { "bank-feed": d.bank_feed, "manager-export": d.kind === "credit" ? d.servicer_tape : d.manager_export, "issuer-claims": d.issuer }]));
let server;
let base;
before(async () => {
  server = createServer({ feeds, docs, tokens });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const get = (path, token, method = "GET") => fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

test("health answers and says synthetic", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).synthetic, true);
});

test("no token, wrong token: 401; token for another account: 403; unknown account: 404", async () => {
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions")).status, 401);
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions", "tok-wrong")).status, 401);
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions", "tok-rental-test-0002")).status, 403);
  assert.equal((await get("/v1/accounts/NOPE/transactions", "tok-credit-test-0001")).status, 404);
});

test("read only: any method other than GET is refused", async () => {
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions", "tok-credit-test-0001", "POST")).status, 405);
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions", "tok-credit-test-0001", "DELETE")).status, 405);
});

test("frozen snapshot: same bytes every time, sha256 in the header matches the body, labeled synthetic", async () => {
  const a = await get("/v1/accounts/DEMO-RENTAL-operating/transactions", "tok-rental-test-0002");
  const b = await get("/v1/accounts/DEMO-RENTAL-operating/transactions", "tok-rental-test-0002");
  const [ba, bb] = [Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())];
  assert.ok(ba.equals(bb));
  assert.equal(a.headers.get("x-snapshot-sha256"), createHash("sha256").update(ba).digest("hex"));
  assert.equal(a.headers.get("x-synthetic-data"), "true");
  const body = JSON.parse(ba);
  assert.equal(body.synthetic, true);
  assert.ok(settledFromFeed(body, "test-pseudonym-key-0123456789").length > 0, "the bank adapter reads the API response directly");
});

test("TEE document routes: bytes are exactly JSON.stringify of each source document, token bound to one token id", async () => {
  const ds = datasets().find((d) => d.id === "DEMO-RENTAL");
  for (const [doc, want] of [["bank-feed", ds.bank_feed], ["manager-export", ds.manager_export], ["issuer-claims", ds.issuer]]) {
    const r = await get(`/v1/tokens/DEMO-RENTAL/${doc}`, "tok-tee-rental-0003");
    assert.equal(r.status, 200, doc);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.toString(), JSON.stringify(want), doc);
    assert.equal(r.headers.get("x-snapshot-sha256"), createHash("sha256").update(body).digest("hex"));
    assert.equal(r.headers.get("x-synthetic-data"), "true");
  }
  assert.equal((await get("/v1/tokens/DEMO-RENTAL/bank-feed")).status, 401);
  assert.equal((await get("/v1/tokens/DEMO-CREDIT/bank-feed", "tok-tee-rental-0003")).status, 403);
  assert.equal((await get("/v1/tokens/DEMO-RENTAL/ledger-dump", "tok-tee-rental-0003")).status, 404);
  assert.equal((await get("/v1/tokens/DEMO-RENTAL/bank-feed", "tok-tee-rental-0003", "PUT")).status, 405);
});

test("all-funds option: one token reads the 3 documents of all 4 funds; per-token map stays the default", async () => {
  const ALL = "tok-all-funds-test-0004";
  const s2 = createServer({ feeds, docs: fundDocs(), tokens, allFundsTokens: [ALL] });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const g = (path, token) => fetch(b2 + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  try {
    for (const f of FUNDS) {
      for (const d of ["bank-feed", "manager-export", "issuer-claims"]) {
        const r = await g(`/v1/tokens/${f}/${d}`, ALL);
        assert.equal(r.status, 200, `${f} ${d}`);
        assert.equal(r.headers.get("x-synthetic-data"), "true");
        assert.equal(Buffer.from(await r.arrayBuffer()).toString(), JSON.stringify(fundDocs()[f][d]));
      }
    }
    assert.equal((await g("/v1/tokens/DEMO-CREDIT/bank-feed")).status, 401);
    assert.equal((await g("/v1/tokens/DEMO-CREDIT/bank-feed", "tok-all-funds-test-0005")).status, 401);
    assert.equal((await g("/v1/tokens/NO-SUCH/bank-feed", ALL)).status, 404);
    assert.equal((await g("/v1/accounts/DEMO-CREDIT-operating/transactions", ALL)).status, 403, "fund documents only, not account feeds");
    // the per-token tokens keep their single scope next to an all-funds token
    assert.equal((await g("/v1/tokens/DEMO-RENTAL/bank-feed", "tok-tee-rental-0003")).status, 200);
    assert.equal((await g("/v1/tokens/DEMO-CREDIT/bank-feed", "tok-tee-rental-0003")).status, 403);
    assert.equal((await g("/health")).status, 200);
    for (const [path, t] of [["/health"], ["/v1/tokens/DEMO-CREDIT/bank-feed", ALL], ["/v1/tokens/DEMO-CREDIT/bank-feed"], ["/v1/tokens/NO-SUCH/bank-feed", ALL], ["/nope", ALL]]) {
      assert.equal((await g(path, t)).headers.get("x-content-type-options"), "nosniff", path);
    }
  } finally {
    s2.close();
  }
  // and without the option nothing reads all funds
  assert.equal((await get("/v1/tokens/DEMO-CREDIT/bank-feed", ALL)).status, 401);
  assert.throws(() => createServer({ docs: fundDocs(), allFundsTokens: [""] }), /non-empty/);
});
