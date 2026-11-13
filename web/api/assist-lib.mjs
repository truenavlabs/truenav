// Pure help-function logic. The Vercel handler is a thin wrapper.
// The API key is read only from process.env.NEARAI_API_KEY (or a test env object).
// It is never logged, never returned, and never sent to the client.
import { systemPrompt } from "./grounding.mjs";

export const ENV_KEY = "NEARAI_API_KEY";
export const NEAR_AI_ENDPOINT = "https://cloud-api.near.ai/v1/chat/completions";
// Live GET /v1/models on 13 Nov 2026: Qwen/Qwen3-30B-A3B-Instruct-2507 is an alias of
// Qwen/Qwen3.6-35B-A3B-FP8, a reasoning model. With max_tokens 400 it fills
// reasoning_content and leaves message.content null, which this function treated as 503.
// Qwen/Qwen3-VL-30B-A3B-Instruct is on the current list, Private (TEE), and returns content.
export const NEAR_AI_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";

// Abuse limits. /api/assist is public and spends NEAR AI credit, so every input is capped
// before the model call and the output is capped by max_tokens.
export const MAX_MESSAGE_CHARS = 1000; // the current question
export const MAX_HISTORY = 8; // prior turns the client may send (4 question and answer pairs)
export const MAX_HISTORY_ITEM_CHARS = 2000; // one prior turn; a 400 token answer fits
export const MAX_HISTORY_TOTAL_CHARS = 8000; // all prior turns together
export const MAX_PAGE_CHARS = 200;
export const MAX_BODY_BYTES = 16 * 1024; // raw request body
export const MAX_TOKENS = 400; // hard cap on the model output per request
export const TIMEOUT_MS = 15000;
// Rate limits live in this function instance's memory only. They are per instance and best
// effort: a cold start or a second instance starts from zero, and there is no shared store.
// They bound a single abuser on a warm instance, not a distributed attack.
export const RATE_LIMIT_MAX = 10; // per client IP
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const GLOBAL_RATE_LIMIT_MAX = 60; // all IPs together, per instance
export const GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_IPS = 5000;
const GLOBAL_KEY = "*global*";

const GENERIC_UNAVAILABLE = "The help service is unavailable. Try the FAQ tab.";
const NOT_CONFIGURED = "The help service is not configured. Try the FAQ tab.";
const INVALID = "Invalid request.";
const FORBIDDEN = "This request is not allowed.";
const TOO_MANY = "Too many questions from this address. Try again later, or use the FAQ tab.";
const BUSY = "The help service is busy. Try again in a minute, or use the FAQ tab.";
const TOO_LARGE = "Request too large. Keep questions under 1000 characters.";
const INTERNAL = "Something went wrong. Try the FAQ tab.";
const METHOD = "Method not allowed.";

const LOCAL_ORIGINS = Object.freeze([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

/** Marker the Vercel wrapper sets when the platform body parser rejects the JSON. */
export const BAD_JSON = Symbol("bad_json");

/** Generic 500 for the wrapper. No error text, no stack. */
export function internalError() {
  return json(500, { error: INTERNAL });
}

/** In-memory per-IP counts. Per instance and best effort across serverless instances. */
const defaultStore = new Map();

export function resetRateLimit(store = defaultStore) {
  store.clear();
}

function header(headers, name) {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) {
      if (Array.isArray(v)) return String(v[0] || "");
      return v == null ? "" : String(v);
    }
  }
  return "";
}

export function clientIp(headers, socketIp = "") {
  const fwd = header(headers, "x-forwarded-for");
  if (fwd.trim()) return fwd.split(",")[0].trim().slice(0, 128);
  const real = header(headers, "x-real-ip").trim();
  if (real) return real.slice(0, 128);
  return String(socketIp || "unknown").slice(0, 128);
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function allowedOrigins(headers, env = {}) {
  const set = new Set(LOCAL_ORIGINS);
  const host = header(headers, "x-forwarded-host") || header(headers, "host");
  const proto = header(headers, "x-forwarded-proto") || (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  if (host) set.add(`${proto}://${host.split(",")[0].trim()}`);
  if (env.VERCEL_URL) set.add(`https://${env.VERCEL_URL}`);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) set.add(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return set;
}

export function isSameOrigin(headers, env = {}) {
  const allowed = allowedOrigins(headers, env);
  const origin = header(headers, "origin").trim();
  if (origin) return allowed.has(origin);
  const referer = header(headers, "referer") || header(headers, "referrer");
  const fromRef = originOf(referer);
  return fromRef ? allowed.has(fromRef) : false;
}

/**
 * Sliding-window limiter over timestamps kept in `store` (a Map in function memory).
 * Returns 0 when the request is allowed, or the seconds to wait (at least 1) when it is not.
 * Per instance and best effort, see RATE_LIMIT_MAX.
 */
export function rateLimitWait(key, now, store = defaultStore, max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  const t = now();
  const row = store.get(key) || [];
  const fresh = row.filter((ts) => t - ts < windowMs);
  if (fresh.length >= max) {
    store.set(key, fresh);
    return Math.max(1, Math.ceil((fresh[0] + windowMs - t) / 1000));
  }
  if (!store.has(key) && store.size >= MAX_TRACKED_IPS) pruneStore(store, t, windowMs);
  fresh.push(t);
  store.set(key, fresh);
  return 0;
}

/** Keep memory bounded: drop expired rows, then the oldest rows if still too many. */
function pruneStore(store, t, windowMs) {
  for (const [k, row] of store) {
    if (k === GLOBAL_KEY) continue;
    if (!row.length || t - row[row.length - 1] >= windowMs) store.delete(k);
  }
  while (store.size >= MAX_TRACKED_IPS) {
    const first = store.keys().next().value;
    if (first === GLOBAL_KEY) {
      const v = store.get(first);
      store.delete(first);
      store.set(first, v);
      continue;
    }
    store.delete(first);
  }
}

/** Back-compat boolean form. */
export function takeRateLimit(ip, now, store = defaultStore, max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  return rateLimitWait(ip, now, store, max, windowMs) === 0;
}

/**
 * Size checks on the parsed body. Returns "" when within limits, or a reason code.
 * Over-limit input is rejected with 413, not silently cut, so the cost per request is bounded
 * and the client sees why.
 */
export function sizeProblem(payload) {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (message.length > MAX_MESSAGE_CHARS) return "message_too_long";
  const history = payload.history;
  if (history == null) return "";
  if (!Array.isArray(history)) return "history_not_array";
  if (history.length > MAX_HISTORY) return "history_too_many";
  let total = 0;
  for (const item of history) {
    const content = item && typeof item.content === "string" ? item.content : "";
    if (content.length > MAX_HISTORY_ITEM_CHARS) return "history_item_too_long";
    total += content.length;
  }
  if (total > MAX_HISTORY_TOTAL_CHARS) return "history_too_large";
  return "";
}

function asObject(body) {
  if (body == null || body === "") return {};
  if (typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return body;
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new TooLarge();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  return parsed;
}

class TooLarge extends Error {}

export function sanitizePage(page) {
  if (typeof page !== "string") return "";
  const trimmed = page.trim().slice(0, MAX_PAGE_CHARS);
  if (!trimmed) return "";
  // Path only: no scheme, no newlines, no spaces.
  if (!/^\/[A-Za-z0-9_./-]*$/.test(trimmed)) return "";
  return trimmed;
}

export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    if (!role) continue; // drop system and any other role
    const content = typeof item.content === "string" ? item.content.slice(0, MAX_MESSAGE_CHARS) : "";
    if (!content) continue;
    out.push({ role, content });
    if (out.length >= MAX_HISTORY) break;
  }
  return out;
}

export function buildMessages({ message, history = [], page = "" }) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw new Error("empty");
  if (text.length > MAX_MESSAGE_CHARS) throw new Error("too long");
  const messages = [{ role: "system", content: systemPrompt(sanitizePage(page)) }];
  for (const turn of sanitizeHistory(history)) messages.push(turn);
  messages.push({ role: "user", content: text });
  return messages;
}

function json(status, body, extraHeaders = {}) {
  return {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
    body,
  };
}

/** Read the assistant text from an OpenAI-shaped chat response. Ignores reasoning_content. */
export function extractAnswer(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("").trim();
  }
  return "";
}

/** Server log of status and error type only. Never the key, never the prompt, never the answer. */
export function logAssist(fields) {
  try {
    console.log(JSON.stringify({ src: "assist", ...fields }));
  } catch {
    // ignore
  }
}

/**
 * Handle one assist request. `env` and `fetchImpl` are injectable for tests.
 * The API key never appears in the returned body or headers.
 */
export async function handleAssist({
  method,
  headers = {},
  body,
  socketIp = "",
  env = process.env,
  fetchImpl = globalThis.fetch,
  store = defaultStore,
  now = Date.now,
} = {}) {
  if (String(method || "GET").toUpperCase() !== "POST") {
    return json(405, { error: METHOD }, { Allow: "POST" });
  }
  if (!isSameOrigin(headers, env)) {
    return json(403, { error: FORBIDDEN });
  }

  const declared = Number(header(headers, "content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    logAssist({ type: "too_large", status: 413 });
    return json(413, { error: TOO_LARGE });
  }

  const ip = clientIp(headers, socketIp);
  const ipWait = rateLimitWait(ip, now, store, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (ipWait) {
    logAssist({ type: "rate_limited_ip", status: 429 });
    return json(429, { error: TOO_MANY }, { "Retry-After": String(ipWait) });
  }
  const globalWait = rateLimitWait(GLOBAL_KEY, now, store, GLOBAL_RATE_LIMIT_MAX, GLOBAL_RATE_LIMIT_WINDOW_MS);
  if (globalWait) {
    logAssist({ type: "rate_limited_global", status: 429 });
    return json(429, { error: BUSY }, { "Retry-After": String(globalWait) });
  }

  let payload;
  try {
    if (body && typeof body === "object" && body[BAD_JSON]) throw new Error("bad json");
    payload = asObject(body);
  } catch (err) {
    if (err instanceof TooLarge) {
      logAssist({ type: "too_large", status: 413 });
      return json(413, { error: TOO_LARGE });
    }
    logAssist({ type: "bad_json", status: 400 });
    return json(400, { error: INVALID });
  }
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) {
    return json(400, { error: INVALID });
  }

  const tooBig = sizeProblem(payload);
  if (tooBig) {
    logAssist({ type: tooBig, status: 413 });
    return json(413, { error: TOO_LARGE });
  }

  const message = typeof payload.message === "string" ? payload.message : "";
  let messages;
  try {
    messages = buildMessages({
      message,
      history: payload.history,
      page: payload.page,
    });
  } catch {
    return json(400, { error: INVALID });
  }

  const key = env && typeof env[ENV_KEY] === "string" ? env[ENV_KEY] : "";
  if (!key) {
    return json(503, { error: NOT_CONFIGURED, code: "not_configured" });
  }

  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(NEAR_AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: NEAR_AI_MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        stream: false,
      }),
      signal: ctl ? ctl.signal : undefined,
    });
    const upstreamStatus = res && typeof res.status === "number" ? res.status : 0;
    if (!res || !res.ok) {
      logAssist({ type: "upstream_http", upstreamStatus });
      return json(503, { error: GENERIC_UNAVAILABLE });
    }
    let data;
    try {
      data = await res.json();
    } catch {
      logAssist({ type: "parse_error", upstreamStatus });
      return json(503, { error: GENERIC_UNAVAILABLE });
    }
    const answer = extractAnswer(data);
    if (!answer) {
      const choice = data && data.choices && data.choices[0];
      const finishReason = choice && choice.finish_reason ? String(choice.finish_reason).slice(0, 32) : "";
      const hasReasoning = Boolean(choice && choice.message && choice.message.reasoning_content);
      logAssist({ type: "empty_content", upstreamStatus, finishReason, hasReasoning });
      return json(503, { error: GENERIC_UNAVAILABLE });
    }
    return json(200, { answer, sources: ["TrueNav FAQ"] });
  } catch (err) {
    const errorName = err && err.name ? String(err.name).slice(0, 40) : "Error";
    const type = errorName === "AbortError" ? "timeout" : "fetch_error";
    logAssist({ type, errorName });
    return json(503, { error: GENERIC_UNAVAILABLE });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
