// The mirror and derived MPC addresses come from the receipts contract, never from the command line alone:
// get_mirror_config gives the mirror address and the derived public key the admin configured, and derive.mjs checks
// that key against the MPC signer's own derivation for the receipts account. Command-line addresses are accepted only
// as an assertion: if one is given and differs, the script stops.
import { JsonRpcProvider } from "near-api-js";
import { deriveLive } from "./derive.mjs";
import { guard } from "./safe.mjs";

export const SIGNER = "v1.signer-prod.testnet";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export async function mirrorAddresses({ view, receipts, signer = SIGNER, mirror: argMirror, mpc: argMpc }) {
  if (!receipts?.endsWith(".testnet")) throw Error("TRUENAV_RECEIPTS_ACCOUNT must be a testnet account");
  const safeView = (contract, method, args = {}) => guard("near", () => view(contract, method, args));
  const state = await safeView(receipts, "get_mirror_config");
  const config = state?.config;
  const mirrorHex = String(config?.mirror_address ?? "").toLowerCase();
  const keyHex = String(config?.public_key ?? "").toLowerCase();
  if (!HEX40.test(mirrorHex) || !HEX128.test(keyHex)) throw Error("the receipts contract has no valid mirror config");
  const derived = await deriveLive(receipts, (method, args) => safeView(signer, method, args));
  if (derived.public_key !== keyHex) throw Error("the mirror config's public_key is not the MPC key derived for the receipts account");
  const out = { mirrorAddress: `0x${mirrorHex}`, mpcAddress: derived.address.toLowerCase(), pending: state.pending ?? null };
  if (argMirror !== undefined && argMirror.toLowerCase() !== out.mirrorAddress) throw Error("--mirror differs from the receipts contract's mirror_address");
  if (argMpc !== undefined && argMpc.toLowerCase() !== out.mpcAddress) throw Error("--mpc differs from the address derived for the receipts account");
  return out;
}

/** A read-only NEAR view function on testnet (chain id checked once), every call guarded. */
export async function nearView(url) {
  const provider = new JsonRpcProvider({ url });
  const status = await guard("near", () => provider.viewNodeStatus());
  if (status.chain_id !== "testnet") throw Error("NEAR testnet required");
  return { provider, view: (contractId, method, args = {}) => guard("near", () => provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } })) };
}

/** <logs.json> [--mirror 0x..] [--mpc 0x..] [--execute]. Any other argument (an RPC URL, say) is refused unechoed. */
export function parseArgs(argv) {
  const out = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") out.execute = true;
    else if (a === "--mirror" || a === "--mpc") {
      const v = argv[++i];
      if (!/^0x[0-9a-fA-F]{40}$/.test(v ?? "")) throw Error(`${a} needs a 0x-prefixed 20-byte address`);
      out[a.slice(2)] = v;
    } else if (out.file === undefined && !a.startsWith("-") && !a.includes("://")) out.file = a;
    else throw Error("unexpected argument; the Base RPC is read from BASE_RPC_URL, never from the command line");
  }
  if (!out.file) throw Error("usage: <logs.json> [--mirror 0x..] [--mpc 0x..] [--execute]");
  return out;
}

/** The Base RPC from BASE_RPC_URL only. */
export function baseRpcUrl(env = process.env) {
  const url = env.BASE_RPC_URL;
  if (!url) throw Error("BASE_RPC_URL is not set");
  return url;
}
export const baseTimeoutMs = (env = process.env) => {
  const t = Number(env.BASE_RPC_TIMEOUT_MS);
  return Number.isSafeInteger(t) && t > 0 ? t : 10_000;
};
