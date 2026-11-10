// Cross-process spend nonce and buyer rate limit.
// One directory, one machine, mode 0700. Several API processes on that machine share the directory.
// Two machines, or two copies of the directory, do not. A missing store is not created unless init
// is explicit (TRUENAV_SPEND_STORE_INIT=1 or node api/spend-init.mjs). A corrupt state file fails closed.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, constants, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BUYER_LIMIT = 8;
export const BUYER_WINDOW_MS = 60 * 1000;
export const PRE_IP_LIMIT = 60;
export const PRE_BUYER_LIMIT = 30;
export const PRE_WINDOW_MS = 10 * 1000;
export const MAX_LIMIT_KEYS = 1024;
export const MAX_LIMIT_KEY_LEN = 128;
const LOCK_WAIT_MS = 3000;
const STALE_LOCK_MS = 5000;
const INIT_HINT = "spend store is not initialized. Run: node api/spend-init.mjs <dir>. Refusing to create an empty store.";
const FLOCK = "/usr/bin/flock";
const NODE = process.execPath;

function fail(message) {
  const error = new Error(message);
  error.code = "spend_store_closed";
  throw error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function assertStoreDir(dir) {
  let st;
  try { st = await lstat(dir); }
  catch (error) {
    if (error.code === "ENOENT") fail(INIT_HINT);
    fail(`spend store path is unreadable: ${error.code || error.message}`);
  }
  if (st.isSymbolicLink()) fail("spend store path is a symlink. Point TRUENAV_SPEND_STORE at a real directory, chmod 700, and start again.");
  if (!st.isDirectory()) fail("spend store path is not a directory.");
  const mode = st.mode & 0o777;
  if (mode & 0o022) fail(`spend store directory is group or world writable (mode ${mode.toString(8)}). chmod 700 the directory and start again.`);
}

async function readState(dir) {
  const path = join(dir, "state.json");
  let st;
  try { st = await lstat(path); }
  catch (error) {
    if (error.code === "ENOENT") fail("spend store missing");
    fail(`spend store unreadable: ${error.code || error.message}`);
  }
  if (st.isSymbolicLink()) fail("state.json is a symlink. Restore the real state.json from backup. Do not start an empty store.");
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { fail(`spend store unreadable: ${error.code || error.message}`); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail("spend store corrupt. Stop the API, restore state.json from backup, and start again. Do not delete it to force a fresh store."); }
  if (!parsed || parsed.v !== 1 || !parsed.nonces || !parsed.buyers || typeof parsed.nonces !== "object" || typeof parsed.buyers !== "object" || Array.isArray(parsed.nonces) || Array.isArray(parsed.buyers)) {
    fail("spend store corrupt. Stop the API, restore state.json from backup, and start again. Do not delete it to force a fresh store.");
  }
  return parsed;
}

async function cleanTmp(dir) {
  let names;
  try { names = await readdir(dir); }
  catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".tmp") && !name.startsWith("LOCK.dead.")) continue;
    const path = join(dir, name);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || now - st.mtimeMs > 60_000) await unlink(path);
    } catch { /* another process removed it */ }
  }
}

async function writeState(dir, state) {
  await cleanTmp(dir);
  const tmp = join(dir, `state.${process.pid}.${Date.now()}.tmp`);
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, "state.json"));
  const dirHandle = await open(dir, "r");
  try { await dirHandle.sync(); }
  finally { await dirHandle.close(); }
}

export function probeFlock() {
  if (process.platform === "win32") fail("util-linux flock is required. This platform has no /usr/bin/flock.");
  const probe = spawnSync(FLOCK, ["-x", "-w", "1", "/tmp/truenav-flock-probe", NODE, "-e", "process.exit(0)"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    fail("util-linux flock is required (flock -x -w 1). Busybox flock is not enough. Install util-linux and retry.");
  }
}

export async function initSpendStore(dir, { create = false } = {}) {
  probeFlock();
  if (!dir || typeof dir !== "string") fail("spend store path is required");
  if (!existsSync(dir)) {
    if (!create) fail(INIT_HINT);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  await assertStoreDir(dir);
  const path = join(dir, "state.json");
  const ready = join(dir, "READY");
  const hasState = existsSync(path);
  const hasReady = existsSync(ready);
  if (!hasState && !hasReady) {
    if (!create) fail(INIT_HINT);
    await writeState(dir, { v: 1, nonces: {}, buyers: {} });
    await writeFile(ready, "1\n", { mode: 0o600 });
    const dirHandle = await open(dir, "r");
    try { await dirHandle.sync(); }
    finally { await dirHandle.close(); }
    return dir;
  }
  if (!hasState || !hasReady) fail("spend store missing. Restore state.json and READY from backup. Refusing to recreate them.");
  await readState(dir);
  return dir;
}

async function pruneUsed(dir, state) {
  const live = new Set(Object.keys(state.nonces).map((nonce) => createHash("sha256").update(nonce).digest("hex")));
  let names = [];
  try { names = await readdir(join(dir, "used")); } catch { return; }
  for (const name of names) {
    if (!live.has(name)) await unlink(join(dir, "used", name)).catch(() => {});
  }
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

async function readLock(lockPath) {
  let st;
  try { st = await lstat(lockPath); }
  catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    fail(`spend store lock failed: ${error.code || error.message}`);
  }
  if (st.isSymbolicLink()) {
    fail(`LOCK is a symlink. Stop the API, remove ${lockPath} only, and start again. Leave state.json and READY in place.`);
  }
  if (st.isDirectory()) {
    fail(`LOCK is a directory. Stop the API, remove that directory only, and start again. Leave state.json and READY in place.`);
  }
  if (!st.isFile()) fail(`LOCK is not a regular file. Remove ${lockPath} and start again. Leave state.json and READY in place.`);
  let text;
  try { text = await readFile(lockPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    fail(`spend store lock unreadable: ${error.code || error.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = null; }
  const age = Date.now() - st.mtimeMs;
  const owner = parsed && Number.isInteger(parsed.pid) ? parsed.pid : 0;
  return { missing: false, token: parsed?.token, pid: owner, age, stale: !pidAlive(owner) && age > STALE_LOCK_MS };
}

async function confirmLock(lockPath, token) {
  const seen = await readLock(lockPath);
  return !seen.missing && seen.token === token && seen.pid === process.pid;
}

async function ownLock(dir, token) {
  return confirmLock(join(dir, "LOCK"), token);
}

function flockHeld(lockPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(FLOCK, ["-x", "-w", "3", lockPath, NODE, "-e", "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("spend store lock unavailable"), { code: "spend_store_closed" }));
    }, LOCK_WAIT_MS + 500);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("ready")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      if (!buf.includes("ready")) {
        clearTimeout(timer);
        reject(Object.assign(new Error(`spend store lock unavailable (${code})`), { code: "spend_store_closed" }));
      }
    });
  });
}

async function releaseFlock(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.stdin.end(); } catch { /* already closed */ }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

async function withLock(dir, fn) {
  const lockPath = join(dir, "LOCK");
  await readLock(lockPath).catch((error) => { if (error.code === "spend_store_closed") throw error; });
  const token = randomBytes(16).toString("hex");
  const child = await flockHeld(lockPath);
  try {
    const body = JSON.stringify({ pid: process.pid, token, at: Date.now() });
    const fh = await open(lockPath, "w", 0o600);
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (!(await confirmLock(lockPath, token))) fail("spend store lock lost");
    return await fn(token);
  } finally {
    await releaseFlock(child);
  }
}

function nonceFile(dir, nonce) {
  return join(dir, "used", createHash("sha256").update(nonce).digest("hex"));
}

async function claimNonce(dir, nonce, exp, nowMs) {
  const path = nonceFile(dir, nonce);
  await mkdir(join(dir, "used"), { recursive: true, mode: 0o700 });
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) fail("spend nonce path is not a regular file");
    const until = Number(await readFile(path, "utf8"));
    if (Number.isFinite(until) && until >= nowMs) return false;
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") fail(`spend nonce unreadable: ${error.code || error.message}`);
  }
  let fh;
  try { fh = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (error) {
    if (error.code === "EEXIST") return false;
    fail(`spend nonce create failed: ${error.code || error.message}`);
  }
  try {
    await fh.writeFile(String(exp));
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

export async function reserveSpend(dir, { buyer, nonce, nowMs, exp, limit = BUYER_LIMIT, windowMs = BUYER_WINDOW_MS }) {
  await assertStoreDir(dir);
  if (!existsSync(join(dir, "state.json")) || !existsSync(join(dir, "READY"))) fail(INIT_HINT);
  return withLock(dir, async (token) => {
    if (!(await ownLock(dir, token))) return { ok: false, error: "spend store lock lost" };
    const state = await readState(dir);
    prune(state, nowMs, windowMs);
    await pruneUsed(dir, state);
    if (state.nonces[nonce]) {
      await writeState(dir, state);
      return { ok: false, error: "spend nonce reused" };
    }
    const stamps = state.buyers[buyer] || [];
    if (stamps.length >= limit) {
      await writeState(dir, state);
      return { ok: false, error: "buyer rate limit" };
    }
    if (!(await ownLock(dir, token))) return { ok: false, error: "spend store lock lost" };
    const claimed = await claimNonce(dir, nonce, exp, nowMs);
    if (!claimed) return { ok: false, error: "spend nonce reused" };
    stamps.push(nowMs);
    state.buyers[buyer] = stamps;
    state.nonces[nonce] = exp;
    if (await ownLock(dir, token)) await writeState(dir, state);
    return { ok: true };
  });
}

export function createCheapLimiter({ ipLimit = PRE_IP_LIMIT, buyerLimit = PRE_BUYER_LIMIT, windowMs = PRE_WINDOW_MS, maxKeys = MAX_LIMIT_KEYS } = {}) {
  const hits = new Map();
  function sweep(nowMs) {
    for (const [id, stamps] of hits) {
      const live = stamps.filter((t) => nowMs - t < windowMs);
      if (live.length === 0) hits.delete(id);
      else if (live.length !== stamps.length) hits.set(id, live);
    }
  }
  function allow(kind, key, nowMs) {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_LIMIT_KEY_LEN) {
      const error = new Error("rate limit key rejected");
      error.code = "rate_key_rejected";
      throw error;
    }
    sweep(nowMs);
    const cap = kind === "ip" ? ipLimit : buyerLimit;
    const id = `${kind}:${key}`;
    const prev = hits.get(id) || [];
    if (prev.length >= cap) {
      hits.delete(id);
      hits.set(id, prev);
      return false;
    }
    prev.push(nowMs);
    hits.delete(id);
    hits.set(id, prev);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    return true;
  }
  const timer = setInterval(() => sweep(Date.now()), windowMs);
  timer.unref?.();
  return { allow, sweep, size: () => hits.size, stop: () => clearInterval(timer) };
}
