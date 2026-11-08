// The Vercel adapter for the mock bank host: one all-funds token from env TRUENAV_DATA_TOKEN, fail-closed without it.
// Run as a plain Node http server here; no network beyond 127.0.0.1, no Vercel.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { makeHandler, restorePath, isPlainPath, MIN_TOKEN_LENGTH } from "../api/mockbank.mjs";
import vercelHandler from "../api/mockbank.mjs";
import { FUNDS, fundDocs } from "../../../cashflow/mockbank/funds.mjs";

const TOKEN = "t".repeat(MIN_TOKEN_LENGTH) + "-synthetic-test";
const servers = [];
async function serve(h) {
  const s = createServer(h);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  const base = `http://127.0.0.1:${s.address().port}`;
  return (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
after(() => servers.forEach((s) => s.close()));
const DOCS = ["bank-feed", "manager-export", "issuer-claims"];

test("the all-funds token reads all 3 documents of all 4 funds, exact bytes, sha256 and synthetic headers", async () => {
  const get = await serve(makeHandler({ TRUENAV_DATA_TOKEN: TOKEN }));
  const docs = fundDocs();
  for (const f of FUNDS) {
    for (const d of DOCS) {
      const r = await get(`/v1/tokens/${f}/${d}`, TOKEN);
      assert.equal(r.status, 200, `${f} ${d}`);
      const body = Buffer.from(await r.arrayBuffer());
      assert.equal(body.toString(), JSON.stringify(docs[f][d]), `${f} ${d}`);
      assert.equal(r.headers.get("x-snapshot-sha256"), createHash("sha256").update(body).digest("hex"));
      assert.equal(r.headers.get("x-synthetic-data"), "true");
    }
  }
});

test("no token, a wrong token, or a wrong token of the right length: 401, with the synthetic header; unknown: 404", async () => {
  const get = await serve(makeHandler({ TRUENAV_DATA_TOKEN: TOKEN }));
  for (const t of [undefined, "wrong", TOKEN.slice(0, -1) + "X", TOKEN + "x"]) {
    const r = await get("/v1/tokens/DEMO-CREDIT/bank-feed", t);
    assert.equal(r.status, 401, String(t && t.length));
    assert.equal(r.headers.get("x-synthetic-data"), "true");
    assert.doesNotMatch(await r.text(), new RegExp(TOKEN));
  }
  assert.equal((await get("/v1/tokens/NO-SUCH-FUND/bank-feed", TOKEN)).status, 404);
  assert.equal((await get("/v1/tokens/DEMO-CREDIT/payroll", TOKEN)).status, 404);
  assert.equal((await get("/v2/anything", TOKEN)).status, 404);
  // the host serves the fund documents only: no account feeds are hosted
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions", TOKEN)).status, 404);
  assert.equal((await get("/v1/accounts/DEMO-CREDIT-operating/transactions")).status, 401);
});

test("TRUENAV_DATA_TOKEN unset, empty or too short: every data route fails closed (503, nothing served); /health stays up", async () => {
  for (const env of [{}, { TRUENAV_DATA_TOKEN: "" }, { TRUENAV_DATA_TOKEN: "x".repeat(MIN_TOKEN_LENGTH - 1) }]) {
    const get = await serve(makeHandler(env));
    for (const f of FUNDS) {
      for (const d of DOCS) {
        for (const t of [undefined, TOKEN, env.TRUENAV_DATA_TOKEN]) {
          const r = await get(`/v1/tokens/${f}/${d}`, t);
          assert.equal(r.status, 503);
          assert.equal(r.headers.get("x-synthetic-data"), "true");
          assert.deepEqual(await r.json(), { error: "data token not configured" });
        }
      }
    }
    const h = await get("/health");
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true, synthetic: true, configured: false });
  }
});

test("/health is public and synthetic when configured; writes are refused", async () => {
  const get = await serve(makeHandler({ TRUENAV_DATA_TOKEN: TOKEN }));
  const h = await get("/health");
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("x-synthetic-data"), "true");
  assert.deepEqual(await h.json(), { ok: true, synthetic: true });
  const base = `http://127.0.0.1:${servers.at(-1).address().port}`;
  assert.equal((await fetch(`${base}/v1/tokens/DEMO-CREDIT/bank-feed`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
});

test("the default export reads the env once and restores the rewritten path", async () => {
  assert.equal(restorePath("/api/mockbank?__path=/v1/tokens/DEMO-RENTAL/issuer-claims"), "/v1/tokens/DEMO-RENTAL/issuer-claims");
  assert.equal(restorePath("/api/mockbank?__path=/health&x=1"), "/health?x=1");
  assert.equal(restorePath("/v1/tokens/DEMO-RENTAL/bank-feed"), "/v1/tokens/DEMO-RENTAL/bank-feed");
  const saved = process.env.TRUENAV_DATA_TOKEN;
  process.env.TRUENAV_DATA_TOKEN = TOKEN;
  try {
    const get = await serve(vercelHandler);
    const r = await get("/api/mockbank?__path=/v1/tokens/HONEST-RENTAL/manager-export", TOKEN);
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), JSON.stringify(fundDocs()["HONEST-RENTAL"]["manager-export"]));
    assert.equal((await get("/api/mockbank?__path=/v1/tokens/HONEST-RENTAL/manager-export")).status, 401);
  } finally {
    if (saved === undefined) delete process.env.TRUENAV_DATA_TOKEN;
    else process.env.TRUENAV_DATA_TOKEN = saved;
  }
});

test("the adapter never logs: no console call in its source or the server it wraps", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../api/mockbank.mjs", "../../../cashflow/mockbank/server.mjs", "../../../cashflow/mockbank/funds.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /console\.|process\.stdout|process\.stderr/, f);
  }
});

test("X-Content-Type-Options: nosniff on every answer: 200, 401, 404, 405, 503 and /health, configured or not", async () => {
  const get = await serve(makeHandler({ TRUENAV_DATA_TOKEN: TOKEN }));
  const off = await serve(makeHandler({}));
  const port = servers.at(-2).address().port;
  const answers = [
    await get("/v1/tokens/DEMO-CREDIT/bank-feed", TOKEN), // 200
    await get("/v1/tokens/DEMO-CREDIT/bank-feed"), // 401
    await get("/v1/tokens/NO-SUCH/bank-feed", TOKEN), // 404
    await get("/health"),
    await fetch(`http://127.0.0.1:${port}/v1/tokens/DEMO-CREDIT/bank-feed`, { method: "POST" }), // 405
    await off("/v1/tokens/DEMO-CREDIT/bank-feed", TOKEN), // 503
    await off("/health"),
  ];
  assert.deepEqual(answers.map((r) => r.status), [200, 401, 404, 200, 405, 503, 200]);
  for (const r of answers) {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", String(r.status));
    assert.equal(r.headers.get("x-synthetic-data"), "true", String(r.status));
  }
  // and on the adapter's own 404 for a rejected __path
  const saved = process.env.TRUENAV_DATA_TOKEN;
  process.env.TRUENAV_DATA_TOKEN = TOKEN;
  try {
    const v = await serve(vercelHandler);
    const r = await v("/api/mockbank?__path=//evil.example/x", TOKEN);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  } finally {
    if (saved === undefined) delete process.env.TRUENAV_DATA_TOKEN;
    else process.env.TRUENAV_DATA_TOKEN = saved;
  }
});

test("a __path that is not a plain local path is 404 and serves nothing, even with the right token", async () => {
  const bad = [
    "//evil.example/v1/tokens/DEMO-CREDIT/bank-feed", // protocol-relative
    "http://evil.example/v1/tokens/DEMO-CREDIT/bank-feed", // scheme
    "https:/v1/tokens/DEMO-CREDIT/bank-feed",
    "v1/tokens/DEMO-CREDIT/bank-feed", // no leading slash
    "/v1/tokens/DEMO-CREDIT/bank-feed\u0000", // NUL, as %00 decodes
    "/v1/tokens/DEMO-CREDIT/bank-feed%00", // a literal %00 (double-encoded on the wire)
    "/v1//tokens/DEMO-CREDIT/bank-feed",
    "/v1/tokens/../tokens/DEMO-CREDIT/bank-feed",
    "/v1/tokens/./DEMO-CREDIT/bank-feed",
    "/\\evil.example/x",
    "/v1/tokens/DEMO-CREDIT/bank-feed?x=1",
    "/v1/tokens/DEMO-CREDIT/bank-feed#x",
    "",
  ];
  for (const p of bad) assert.equal(isPlainPath(p), false, JSON.stringify(p));
  for (const p of ["/health", "/v1/tokens/DEMO-CREDIT/bank-feed", "/"]) assert.equal(isPlainPath(p), true, p);
  assert.equal(restorePath("/api/mockbank?__path=/health&__path=/v1/tokens/DEMO-CREDIT/bank-feed"), null, "two __path values");
  assert.equal(restorePath("//evil.example/x"), null, "the request's own path is checked too");
  const saved = process.env.TRUENAV_DATA_TOKEN;
  process.env.TRUENAV_DATA_TOKEN = TOKEN;
  try {
    const get = await serve(vercelHandler);
    for (const p of bad) {
      const r = await get(`/api/mockbank?__path=${encodeURIComponent(p)}`, TOKEN);
      const body = await r.text();
      assert.equal(r.status, 404, JSON.stringify(p));
      assert.deepEqual(JSON.parse(body), { error: "not found" });
      assert.equal(r.headers.get("x-snapshot-sha256"), null);
    }
    // the plain form still works through the same handler
    assert.equal((await get(`/api/mockbank?__path=${encodeURIComponent("/v1/tokens/DEMO-CREDIT/bank-feed")}`, TOKEN)).status, 200);
  } finally {
    if (saved === undefined) delete process.env.TRUENAV_DATA_TOKEN;
    else process.env.TRUENAV_DATA_TOKEN = saved;
  }
});
