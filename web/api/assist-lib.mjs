// Pure help-function logic. The Vercel handler is a thin wrapper.
// The API key is read only from process.env.NEARAI_API_KEY (or a test env object).
// It is never logged, never returned, and never sent to the client.
import { systemPrompt } from "./grounding.mjs";

export const ENV_KEY = "NEARAI_API_KEY";
export const NEAR_AI_ENDPOINT = "https://cloud-api.near.ai/v1/chat/completions";
// Kit skill near-ai-cloud model list: Private (TEE), cost-efficient, instruction following.
export const NEAR_AI_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507";

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_HISTORY = 8;
export const MAX_PAGE_CHARS = 200;
export const MAX_TOKENS = 400;
export const TIMEOUT_MS = 15000;
export const RATE_LIMIT_MAX = 8;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const GENERIC_UNAVAILABLE = "The help service is unavailable. Try the FAQ tab.";
const NOT_CONFIGURED = "The help service is not configured. Try the FAQ tab.";
const INVALID = "Invalid request.";
const FORBIDDEN = "This request is not allowed.";
const TOO_MANY = "Too many questions from this address. Try again later, or use the FAQ tab.";
const METHOD = "Method not allowed.";

const LOCAL_ORIGINS = Object.freeze([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

/** In-memory per-IP counts. Best effort across serverless instances. */
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

export function takeRateLimit(ip, now, store = defaultStore, max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  const t = now();
  const row = store.get(ip) || [];
  const fresh = row.filter((ts) => t - ts < windowMs);
  if (fresh.length >= max) {
    store.set(ip, fresh);
    return false;
  }
  fresh.push(t);
  store.set(ip, fresh);
  return true;
}

function asObject(body) {
  if (body == null || body === "") return {};
  if (typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return body;
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  if (text.length > 32_000) throw new Error("too large");
  return JSON.parse(text);
}

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

  const ip = clientIp(headers, socketIp);
  if (!takeRateLimit(ip, now, store)) {
    return json(429, { error: TOO_MANY });
  }

  let payload;
  try {
    payload = asObject(body);
  } catch {
    return json(400, { error: INVALID });
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
    if (!res || !res.ok) return json(503, { error: GENERIC_UNAVAILABLE });
    const data = await res.json();
    const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof answer !== "string" || !answer.trim()) return json(503, { error: GENERIC_UNAVAILABLE });
    return json(200, { answer: answer.trim(), sources: ["TrueNav FAQ"] });
  } catch {
    return json(503, { error: GENERIC_UNAVAILABLE });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
