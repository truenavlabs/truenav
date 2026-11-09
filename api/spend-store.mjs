// Cross-process spend nonce and buyer rate limit.
// One directory, one machine. An O_EXCL lock file is the single writer. Two API processes on that
// machine share the directory and therefore the lock. Two machines, or two copies of the directory,
// do not. A corrupt or missing state file fails closed and is not replaced with an empty store.
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUYER_LIMIT = 8;
export const BUYER_WINDOW_MS = 60 * 1000;
export const PRE_IP_LIMIT = 60;
export const PRE_BUYER_LIMIT = 30;
export const PRE_WINDOW_MS = 10 * 1000;
const LOCK_WAIT_MS = 3000;
const STALE_LOCK_MS = 5000;

function fail(message) {
  const error = new Error(message);
  error.code = "spend_store_closed";
  throw error;
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* the lock hold is a few milliseconds; a short spin is enough */ }
}

function withLock(dir, fn) {
  const lockPath = join(dir, "LOCK");
  const started = Date.now();
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") fail(`spend store lock failed: ${error.code || error.message}`);
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) unlinkSync(lockPath);
      } catch { /* the holder released it, or it is still live */ }
      if (Date.now() - started > LOCK_WAIT_MS) fail("spend store lock unavailable");
      sleep(2);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* the fd is already closed */ }
    try { unlinkSync(lockPath); } catch { /* another recovery already removed a stale lock */ }
  }
}

function readState(dir) {
  const path = join(dir, "state.json");
  if (!existsSync(path)) fail("spend store missing");
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { fail(`spend store unreadable: ${error.code || error.message}`); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail("spend store corrupt"); }
  if (!parsed || parsed.v !== 1 || !parsed.nonces || !parsed.buyers || typeof parsed.nonces !== "object" || typeof parsed.buyers !== "object" || Array.isArray(parsed.nonces) || Array.isArray(parsed.buyers)) {
    fail("spend store corrupt");
  }
  return parsed;
}

function writeState(dir, state) {
  const tmp = join(dir, `state.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, join(dir, "state.json"));
}

export function initSpendStore(dir) {
  if (!dir || typeof dir !== "string") fail("spend store path is required");
  const path = join(dir, "state.json");
  const ready = join(dir, "READY");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(ready) && !existsSync(path)) {
    writeState(dir, { v: 1, nonces: {}, buyers: {} });
    writeFileSync(ready, "1\n", { mode: 0o600 });
    return dir;
  }
  if (!existsSync(path) || !existsSync(ready)) fail("spend store missing");
  readState(dir);
  return dir;
}

function prune(state, nowMs, windowMs) {
  for (const [nonce, until] of Object.entries(state.nonces)) {
    if (typeof until !== "number" || until < nowMs) delete state.nonces[nonce];
  }
  for (const [buyer, stamps] of Object.entries(state.buyers)) {
    const live = Array.isArray(stamps) ? stamps.filter((t) => typeof t === "number" && nowMs - t < windowMs) : [];
    if (live.length === 0) delete state.buyers[buyer];
    else state.buyers[buyer] = live;
  }
}

export function reserveSpend(dir, { buyer, nonce, nowMs, exp, limit = BUYER_LIMIT, windowMs = BUYER_WINDOW_MS }) {
  return withLock(dir, () => {
    const state = readState(dir);
    prune(state, nowMs, windowMs);
    if (state.nonces[nonce]) {
      writeState(dir, state);
      return { ok: false, error: "spend nonce reused" };
    }
    const stamps = state.buyers[buyer] || [];
    if (stamps.length >= limit) {
      writeState(dir, state);
      return { ok: false, error: "buyer rate limit" };
    }
    stamps.push(nowMs);
    state.buyers[buyer] = stamps;
    state.nonces[nonce] = exp;
    writeState(dir, state);
    return { ok: true };
  });
}

export function createCheapLimiter({ ipLimit = PRE_IP_LIMIT, buyerLimit = PRE_BUYER_LIMIT, windowMs = PRE_WINDOW_MS } = {}) {
  const hits = new Map();
  return function allow(kind, key, nowMs) {
    const cap = kind === "ip" ? ipLimit : buyerLimit;
    const id = `${kind}:${key}`;
    const prev = (hits.get(id) || []).filter((t) => nowMs - t < windowMs);
    if (prev.length >= cap) {
      hits.set(id, prev);
      return false;
    }
    prev.push(nowMs);
    hits.set(id, prev);
    return true;
  };
}
