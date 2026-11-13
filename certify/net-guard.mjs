// Outage behaviour for the chain-reading and attestation CLIs (G12). When an endpoint is unreachable the script prints
// one line that names the endpoint and says it is a network failure, exits 2 (the CLIs' "usage or network error"
// code), and prints no stack trace.
//
// Importing this file wraps globalThis.fetch once: a successful request (any HTTP status) is returned unchanged, and a
// request that never got a response (refused, DNS, reset, TLS, timeout) is rethrown as a NetworkError that carries the
// endpoint. Import it FIRST in a CLI entry file, before modules that keep their own reference to fetch at load time
// (@phala/dcap-qvl does). cliGuard(import.meta.url) then installs the one-line reporter, only when that file is the
// process entry point, so importing a CLI module from a test changes nothing else.
import { pathToFileURL } from "node:url";

export const NET_EXIT = 2;

// Known public endpoints, by host suffix. The first match names the service in the message.
const SERVICES = [
  [/^tx\.(test|main)\.fastnear\.com$/, "FastNEAR transactions API", "TRUENAV_TX_API"],
  [/fastnear\.com$/, "FastNEAR RPC", "TRUENAV_RPC"],
  [/drpc\.org$/, "dRPC NEAR RPC (backup)", "TRUENAV_RPC"],
  [/intea\.rs$/, "Intea NEAR RPC (backup)", "TRUENAV_RPC"],
  [/^rpc\.(testnet|mainnet)\.near\.org$/, "NEAR RPC", "TRUENAV_RPC"],
  [/nearblocks\.io$/, "NearBlocks API", null],
  [/trustedservices\.intel\.com$/, "Intel PCS", null],
  [/phala\.network$/, "Phala PCCS", "TRUENAV_PCCS_URL"],
  [/nras\.attestation\.nvidia\.com$/, "NVIDIA NRAS", "TRUENAV_NRAS_URL"],
  [/outlayer\.ai$/, "OutLayer API", null], // only tee/fingerprint.mjs reads TRUENAV_OUTLAYER_API; it names it itself
  [/near\.ai$/, "NEAR AI Cloud", null],
];
const named = new Map(); // origin -> { label, env }, registered by a CLI for its configured endpoints
const failures = []; // { label, origin, code, env }, in order, unique by origin
let reported = false;

export class NetworkError extends Error {
  constructor({ label, origin, code, env }, options) {
    super(`network failure: could not reach ${label} at ${origin} (${code})${env ? `; set ${env} to use another endpoint` : ""}`, options);
    this.name = "NetworkError";
    Object.assign(this, { label, origin, code, env });
  }
}

function originOf(input) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
}

/** Name an endpoint a CLI was configured with, e.g. nameEndpoint(rpcUrl, "NEAR RPC", "TRUENAV_RPC"). */
export function nameEndpoint(url, label, env = null) {
  const o = originOf(url);
  if (o && !named.has(o)) named.set(o, { label, env });
}

/** Label: a known public service by host, else the name a CLI registered, else "endpoint". The override hint is the
 * one the CLI registered for that endpoint, else the service default. */
export function describeEndpoint(origin) {
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch { /* keep empty */ }
  const hit = SERVICES.find(([re]) => re.test(host));
  const own = named.get(origin);
  if (hit) return { label: hit[1], env: own ? own.env : hit[2] };
  return own || { label: "endpoint", env: null };
}

/** The low-level reason for a failed fetch: ECONNREFUSED, ENOTFOUND, timeout, ... */
export function failureCode(err) {
  if (!err) return "unknown";
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  let deepest = err;
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    if (e.code && typeof e.code === "string") return e.code;
    if (Array.isArray(e.errors) && e.errors[0] && e.errors[0].code) return e.errors[0].code;
    deepest = e;
  }
  // No code: undici's own reason, e.g. "bad port" for a port fetch refuses to use (9 is one).
  return String(deepest.message || deepest).replace(/\s+/g, " ").slice(0, 60);
}

export function isNetworkError(e) {
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) if (x instanceof NetworkError || x.name === "NetworkError") return true;
  return false;
}

export function networkFailures() {
  return failures.slice();
}

/** One line for all endpoints that failed in this process (the default RPC tries its backups too). */
export function networkSummary(e) {
  const list = failures.length ? failures : e && e.origin ? [e] : [];
  if (!list.length) return e ? String(e.message || e) : "network failure";
  if (list.length === 1) return new NetworkError(list[0]).message;
  const envs = [...new Set(list.flatMap((f) => (f.env ? f.env.split(" or ") : [])))];
  return `network failure: could not reach ${list.map((f) => `${f.label} at ${f.origin} (${f.code})`).join(", ")}${envs.length ? `; set ${envs.join(" or ")} to use another endpoint` : ""}`;
}

/** The line a CLI's catch block prints, and marks the failure as reported. */
export function failLine(e, prefix = "error: ") {
  if (isNetworkError(e)) {
    reported = true;
    return networkSummary(e);
  }
  return `${prefix}${e && e.message ? e.message : e}`;
}

const realFetch = globalThis.fetch;
if (typeof realFetch === "function" && !realFetch.truenavNetGuard) {
  const guarded = async function guardedFetch(input, init) {
    try {
      return await realFetch.call(this, input, init);
    } catch (err) {
      const origin = originOf(input);
      if (!origin) throw err; // not a URL: a caller bug, not an outage
      const { label, env } = describeEndpoint(origin);
      const f = { label, origin, code: failureCode(err), env };
      if (!failures.some((x) => x.origin === origin)) failures.push(f);
      throw new NetworkError(f, { cause: err });
    }
  };
  guarded.truenavNetGuard = true;
  globalThis.fetch = guarded;
}

/** Install the one-line reporter when metaUrl is the process entry point. Returns true if installed. */
export function cliGuard(metaUrl) {
  if (!process.argv[1] || metaUrl !== pathToFileURL(process.argv[1]).href) return false;
  const onError = (e) => {
    if (isNetworkError(e)) {
      if (!reported) console.error(networkSummary(e));
      reported = true;
      process.exit(NET_EXIT);
    }
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  };
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
  return true;
}

/** For CLIs that print a PASS/FAIL report and then fail: add the network line and the network exit code. */
export function reportNetworkAtExit() {
  if (!failures.length || reported) return false;
  reported = true;
  console.error(networkSummary());
  process.exitCode = NET_EXIT;
  return true;
}
