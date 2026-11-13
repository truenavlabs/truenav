// Help function abuse limits: size caps, rate limits, bad JSON, wrapper errors. Mocked fetch only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ENV_KEY,
  GLOBAL_RATE_LIMIT_MAX,
  MAX_BODY_BYTES,
  MAX_HISTORY,
  MAX_HISTORY_ITEM_CHARS,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_TOKENS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  handleAssist,
  rateLimitWait,
  resetRateLimit,
} from "../api/assist-lib.mjs";
import handler from "../api/assist.mjs";

const FAKE_KEY = "test-key-not-real";
const ORIGIN = "http://127.0.0.1:5173";

beforeEach(() => resetRateLimit());

function countingFetch(box) {
  return async (_url, init) => {
    box.calls = (box.calls || 0) + 1;
    box.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
}

function call(body, { ip = "203.0.113.20", headers = {}, store = new Map(), now = () => 1_000_000, box = {} } = {}) {
  return handleAssist({
    method: "POST",
    headers: { origin: ORIGIN, "x-forwarded-for": ip, ...headers },
    body,
    env: { [ENV_KEY]: FAKE_KEY },
    fetchImpl: countingFetch(box),
    store,
    now,
  });
}

function noLeak(result) {
  const blob = JSON.stringify(result);
  assert.equal(blob.includes(FAKE_KEY), false);
  assert.equal(/at .*\.mjs:\d+/.test(blob), false, "no stack trace");
}

test("the limits are the documented small values", () => {
  assert.equal(MAX_MESSAGE_CHARS, 1000);
  assert.equal(MAX_HISTORY, 8);
  assert.equal(MAX_HISTORY_ITEM_CHARS, 2000);
  assert.equal(MAX_HISTORY_TOTAL_CHARS, 8000);
  assert.equal(MAX_BODY_BYTES, 16 * 1024);
  assert.equal(MAX_TOKENS, 400);
  assert.equal(RATE_LIMIT_MAX, 10);
  assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
  assert.equal(GLOBAL_RATE_LIMIT_MAX, 60);
});

test("a question at the limit passes and max_tokens is sent as the hard cap", async () => {
  const box = {};
  const r = await call({ message: "q".repeat(MAX_MESSAGE_CHARS) }, { box });
  assert.equal(r.status, 200);
  assert.equal(box.body.max_tokens, MAX_TOKENS);
});

test("over-limit question, history count, history item and history total are 413 and never reach the model", async () => {
  const cases = [
    { message: "q".repeat(MAX_MESSAGE_CHARS + 1) },
    { message: "hi", history: Array.from({ length: MAX_HISTORY + 1 }, () => ({ role: "user", content: "x" })) },
    { message: "hi", history: [{ role: "assistant", content: "x".repeat(MAX_HISTORY_ITEM_CHARS + 1) }] },
    { message: "hi", history: Array.from({ length: 5 }, () => ({ role: "user", content: "x".repeat(1700) })) },
  ];
  for (const body of cases) {
    const box = {};
    const r = await call(body, { box });
    assert.equal(r.status, 413);
    assert.match(r.body.error, /too large/i);
    assert.equal(box.calls || 0, 0);
    noLeak(r);
  }
});

test("a raw body over 16 KB and a large content-length are 413", async () => {
  const big = JSON.stringify({ message: "hi", pad: "x".repeat(MAX_BODY_BYTES) });
  const r1 = await call(big);
  assert.equal(r1.status, 413);
  const r2 = await call({ message: "hi" }, { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
  assert.equal(r2.status, 413);
});

test("bad JSON, a JSON array and a non-array history are 400 or 413 with a short message", async () => {
  const bad = await call("{not json");
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "Invalid request." });
  const arr = await call("[1,2]");
  assert.equal(arr.status, 400);
  const hist = await call({ message: "hi", history: "nope" });
  assert.equal(hist.status, 413);
  noLeak(bad);
});

test("per-IP limit is 10 per minute, returns Retry-After, and frees up after the window", async () => {
  const store = new Map();
  let t = 1_000_000;
  const now = () => t;
  for (let i = 0; i < RATE_LIMIT_MAX; i++) assert.equal((await call({ message: "hi" }, { store, now })).status, 200);
  const blocked = await call({ message: "hi" }, { store, now });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers["Retry-After"], "60");
  t += 30_000;
  const later = await call({ message: "hi" }, { store, now });
  assert.equal(later.status, 429);
  assert.equal(later.headers["Retry-After"], "30");
  const other = await call({ message: "hi" }, { store, now, ip: "198.51.100.7" });
  assert.equal(other.status, 200, "another IP is not blocked");
  t += 30_001;
  assert.equal((await call({ message: "hi" }, { store, now })).status, 200);
});

test("the per-instance global cap stops IP rotation", async () => {
  const store = new Map();
  const now = () => 2_000_000;
  for (let i = 0; i < GLOBAL_RATE_LIMIT_MAX; i++) {
    assert.equal((await call({ message: "hi" }, { store, now, ip: `198.51.100.${i}` })).status, 200);
  }
  const r = await call({ message: "hi" }, { store, now, ip: "192.0.2.99" });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /busy/);
  assert.ok(Number(r.headers["Retry-After"]) >= 1);
});

test("rate-limit memory stays bounded", () => {
  const store = new Map();
  let t = 0;
  for (let i = 0; i < 6000; i++) rateLimitWait(`ip-${i}`, () => t++, store);
  assert.ok(store.size <= 5000);
});

test("non-POST methods are 405 with Allow and no model call", async () => {
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
    const box = {};
    const r = await handleAssist({ method, headers: { origin: ORIGIN }, body: {}, env: { [ENV_KEY]: FAKE_KEY }, fetchImpl: countingFetch(box) });
    assert.equal(r.status, 405);
    assert.equal(r.headers.Allow, "POST");
    assert.equal(box.calls || 0, 0);
  }
});

test("missing Origin and Referer is 403", async () => {
  const r = await handleAssist({ method: "POST", headers: { "x-forwarded-for": "203.0.113.1" }, body: { message: "hi" }, env: { [ENV_KEY]: FAKE_KEY }, fetchImpl: countingFetch({}) });
  assert.equal(r.status, 403);
});

function fakeRes() {
  const res = { headers: {}, statusCode: 0, payload: undefined };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.payload = b; return res; };
  return res;
}

test("the Vercel wrapper turns a throwing body parser into 400 and never returns a stack", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const req = {
      method: "POST",
      headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.30" },
      get body() { throw new SyntaxError("Unexpected token secret-prompt-text"); },
      socket: {},
    };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.payload, { error: "Invalid request." });
    assert.equal(JSON.stringify(res).includes("Unexpected token"), false);
  } finally {
    console.log = orig;
  }
  assert.equal(lines.join("\n").includes("secret-prompt-text"), false);
  assert.match(lines.join("\n"), /"type":"bad_json"/);
});

test("the Vercel wrapper answers 413 on a large content-length without reading the body", async () => {
  let read = 0;
  const req = {
    method: "POST",
    headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.31", "content-length": String(MAX_BODY_BYTES * 4) },
    get body() { read++; return {}; },
    socket: {},
  };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 413);
  assert.equal(read, 0);
});

test("the Vercel wrapper turns an unexpected throw into a generic 500", async () => {
  const req = { method: "POST", get headers() { throw new TypeError("boom at /x.mjs:1"); } };
  const res = fakeRes();
  const orig = console.log;
  console.log = () => {};
  try {
    await handler(req, res);
  } finally {
    console.log = orig;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.stringify(res.payload).includes("boom"), false);
});
