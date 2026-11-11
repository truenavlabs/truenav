// Loaded with --import into every Node process the replay judge starts. Replay must need no network, so any
// connection to a host that is not loopback is refused and written to TRUENAV_JUDGE_NET_LOG. The judge fails the
// stage that tried, even if the calling script caught the error. Loopback stays open for the local API test servers.
import net from "node:net";
import { appendFileSync } from "node:fs";

const LOG = process.env.TRUENAV_JUDGE_NET_LOG;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function refuse(host) {
  if (LOG) {
    try { appendFileSync(LOG, `${String(host).slice(0, 200)}\n`); } catch { /* the judge also fails on the thrown error */ }
  }
  const e = new Error(`truenav judge replay: network refused (${host})`);
  e.code = "TRUENAV_REPLAY_OFFLINE";
  return e;
}

const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = async function guardedFetch(input, init) {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    let host;
    try { host = new URL(href).hostname; } catch { throw refuse("unparsed url"); }
    if (!LOOPBACK.has(host)) throw refuse(host);
    return realFetch.call(this, input, init);
  };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let host;
  if (first && typeof first === "object") {
    if (first.path) return realConnect.apply(this, args); // unix socket or pipe, never the network
    host = first.host ?? "localhost";
  } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    host = typeof args[1] === "string" ? args[1] : "localhost";
  } else if (typeof first === "string") {
    return realConnect.apply(this, args); // a pipe path
  }
  if (!LOOPBACK.has(host)) throw refuse(host);
  return realConnect.apply(this, args);
};
