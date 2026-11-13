// Read one transaction from NEAR RPC (`tx`, read-only) and decode what a judge needs: who called what, with which
// arguments, and what came back (a return value or a panic message).
import { makeRpc } from "./registry.mjs";
import { ARCHIVAL_RPCS, DEFAULT_RPC } from "../chain.mjs";

const b64 = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return null; } };
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** Pull the first human message out of a NEAR failure object. */
export function failureMessage(f) {
  const ee = f?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (typeof ee === "string") return ee;
  return f ? JSON.stringify(f).slice(0, 300) : null;
}

/** Decode a `tx` RPC result. Pure, so it is tested on recorded results. */
export function decodeTx(r) {
  const t = r.transaction || {};
  const fc = (t.actions || []).map((a) => a.FunctionCall).find(Boolean) || null;
  const argsText = fc ? b64(fc.args) : null;
  const status = r.status || {};
  const ok = Object.prototype.hasOwnProperty.call(status, "SuccessValue");
  const retText = ok && status.SuccessValue ? b64(status.SuccessValue) : null;
  return {
    hash: t.hash, signer: t.signer_id, receiver: t.receiver_id, method: fc ? fc.method_name : null,
    deposit: fc ? fc.deposit : null, args: json(argsText) ?? argsText,
    ok, returnValue: json(retText) ?? retText, failure: ok ? null : failureMessage(status.Failure),
    blockHash: r.transaction_outcome?.block_hash ?? null, finality: r.final_execution_status ?? null,
  };
}

function isPrunedTx(e) {
  return /UNKNOWN_TRANSACTION|UNKNOWN_BLOCK|doesn't exist|DB Not Found Error: BLOCK/i.test(String((e && (e.rpcCause || e.message)) || e));
}

/** Live read: the transaction and its block time. */
export async function loadTx(hash, sender, { url = DEFAULT_RPC, fetchImpl } = {}) {
  const urls = [url, ...ARCHIVAL_RPCS.filter((u) => u !== url)];
  let rpc, r, last;
  for (const u of urls) {
    rpc = makeRpc({ url: u, fetchImpl });
    try {
      r = await rpc.call("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
      last = null;
      break;
    } catch (e) {
      last = e;
      if (!isPrunedTx(e)) throw e;
    }
  }
  if (!r) throw last || new Error("transaction not available");
  const d = decodeTx(r);
  let blockTimeMs = null, blockHeight = null;
  if (d.blockHash) {
    try {
      const b = await rpc.call("block", { block_id: d.blockHash });
      blockTimeMs = Math.floor(Number(b.header.timestamp_nanosec || b.header.timestamp) / 1e6);
      blockHeight = b.header.height;
    } catch { /* time is optional */ }
  }
  return { ...d, blockTimeMs, blockHeight, endpoint: rpc.seen.endpoint, readAt: Date.now() };
}

export const KNOWN_TXS = Object.freeze({
  refusedPledge: { hash: "8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs", sender: "meridian.tnlab-368aa2.testnet" },
  refusedCertificate: { hash: "Gbu7tKHuE2WVfSMduS1MNyuMRf6TQSQyou2gr9ozXrnQ", sender: "tnlab-368aa2.testnet" },
});
