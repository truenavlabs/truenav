// Data-layer helpers for testnet view calls and for building function-call actions.
// Views use near-api-js JsonRpcProvider (docs.near.org wallet-login: NEAR Connect has no built-in view).
// Actions use the FunctionCall object format that near-connect's wallet.signAndSendTransaction accepts.
// This module does not sign or send a transaction.
import { FailoverRpcProvider, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";
import { BACKUP_RPCS, DEFAULT_CONTRACT, DEFAULT_RPC } from "../../chain.mjs";

export const NETWORK = "testnet";
export const RPC_URL = DEFAULT_RPC;
export const BACKUP_RPC_URLS = BACKUP_RPCS;

/** Live registry. Read-only for writes (standing rule). */
export const REGISTRY_CONTRACT = DEFAULT_CONTRACT;
/** Receipts account pinned in receipts v3 and the recorded loan fingerprints. */
export const RECEIPTS_CONTRACT = "receipts.tnlab-718ca9.testnet";

export const CONTRACTS = Object.freeze({
  registry: REGISTRY_CONTRACT,
  receipts: RECEIPTS_CONTRACT,
});

/** 30 TGas, the default in docs.near.org wallet-login examples. */
export function defaultGas() {
  return teraToGas("30").toString();
}

export function yoctoDeposit(nearAmount = "0") {
  return nearToYocto(String(nearAmount)).toString();
}

/** True for the registry, by exact id. Kept for views and tests; the write guard is the allowlist below. */
export function isRegistryWriteBlocked(contractId) {
  return contractId === REGISTRY_CONTRACT;
}

// Write guard: an allowlist, not a denylist. The only receiver is the receipts contract, by exact id,
// and the only methods are listed here with their own caps. Everything else throws before a wallet sees it.
/** 300 TGas, the protocol maximum per function call. */
export const MAX_GAS = 300_000_000_000_000n;
/** 0.1 NEAR in yocto: the default deposit cap for any write method. */
export const MAX_DEPOSIT_YOCTO = 10n ** 23n;
/**
 * Receipts change methods the web app may call, with per-method deposit caps in yocto.
 * request_run (receipts/src/lib.rs) is runner only and requires outlayer_deposit + storage_deposit
 * attached (0.26 to 0.36 NEAR in the deploy and sandbox configs), so its cap is 0.5 NEAR.
 * Admin, pauser and mirror methods are deliberately absent.
 */
export const WRITE_METHODS = Object.freeze({
  request_run: Object.freeze({ maxDepositYocto: 5n * 10n ** 23n }),
});
const DIGITS = /^(0|[1-9][0-9]{0,39})$/;

function digitString(value, name) {
  const s = typeof value === "bigint" ? value.toString() : value;
  if (typeof s !== "string" || !DIGITS.test(s)) throw new Error(`${name} must be a decimal digit string`);
  return BigInt(s);
}

/** Throws unless the receiver is exactly the receipts contract. */
export function assertWriteReceiver(receiverId) {
  if (receiverId !== RECEIPTS_CONTRACT) throw new Error("Writes go to the receipts contract only");
  return receiverId;
}

/** Throws unless the method is on the allowlist. Returns its caps. */
export function assertWriteMethod(methodName) {
  if (typeof methodName !== "string" || !Object.prototype.hasOwnProperty.call(WRITE_METHODS, methodName)) {
    throw new Error("Method not allowed for writes");
  }
  return WRITE_METHODS[methodName];
}

let provider = null;

/** One shared testnet provider with the same failover list as chain.mjs. */
export function getTestnetProvider() {
  if (!provider) {
    const urls = [RPC_URL, ...BACKUP_RPC_URLS];
    provider = new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url })));
  }
  return provider;
}

/** Test helper. Does not touch the network. */
export function resetTestnetProvider() {
  provider = null;
}

/**
 * Read-only contract view on testnet.
 * Pass `provider` in tests (an object with callFunction) so this never hits a live RPC.
 */
export async function viewFunction({ contractId = REGISTRY_CONTRACT, method, args = {}, provider: custom } = {}) {
  if (!method || typeof method !== "string") throw new Error("viewFunction requires a method name");
  const p = custom || getTestnetProvider();
  return p.callFunction({ contractId, method, args });
}

/**
 * Build a FunctionCall action for near-connect's wallet.signAndSendTransaction.
 * gas and depositYocto are decimal digit strings. depositYocto is in yoctoNEAR (1 NEAR = 10^24),
 * never in NEAR: convert with yoctoDeposit("0.3") first.
 */
export function functionCallAction(methodName, args = {}, { gas, depositYocto } = {}) {
  if (!methodName || typeof methodName !== "string") throw new Error("functionCallAction requires a method name");
  return {
    type: "FunctionCall",
    params: {
      methodName,
      args,
      gas: gas != null ? String(gas) : defaultGas(),
      deposit: depositYocto != null ? String(depositYocto) : "0",
    },
  };
}

/**
 * Build the payload for wallet.signAndSendTransaction, after the write guard:
 * receiver exactly receipts, method on WRITE_METHODS, gas at most 300 TGas, deposit (yocto) at most the
 * method cap, args a plain object. Does not sign or send.
 * @param {{ receiverId?: unknown, methodName?: unknown, args?: object, gas?: string | bigint, depositYocto?: string | bigint, deposit?: unknown }} [input]
 */
export function buildSignAndSendTransaction({ receiverId, methodName, args = {}, gas, depositYocto, deposit } = {}) {
  if (deposit !== undefined) throw new Error("Pass depositYocto (yoctoNEAR), not deposit");
  assertWriteReceiver(receiverId);
  const caps = assertWriteMethod(methodName);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be a plain object");
  const gasN = digitString(gas != null ? gas : defaultGas(), "gas");
  const depN = digitString(depositYocto != null ? depositYocto : "0", "depositYocto");
  if (gasN <= 0n || gasN > MAX_GAS) throw new Error("gas must be above 0 and at most 300 TGas");
  const cap = caps.maxDepositYocto != null ? caps.maxDepositYocto : MAX_DEPOSIT_YOCTO;
  if (depN > cap) throw new Error("deposit is above the cap for this method");
  return {
    receiverId,
    actions: [functionCallAction(methodName, args, { gas: gasN.toString(), depositYocto: depN.toString() })],
  };
}
