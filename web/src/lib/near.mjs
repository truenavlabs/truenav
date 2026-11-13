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

export function isRegistryWriteBlocked(contractId) {
  return contractId === REGISTRY_CONTRACT;
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
 * gas and deposit are decimal strings, as the official wallet-login example uses.
 */
export function functionCallAction(methodName, args = {}, { gas, deposit } = {}) {
  if (!methodName || typeof methodName !== "string") throw new Error("functionCallAction requires a method name");
  return {
    type: "FunctionCall",
    params: {
      methodName,
      args,
      gas: gas != null ? String(gas) : defaultGas(),
      deposit: deposit != null ? String(deposit) : yoctoDeposit("0"),
    },
  };
}

/**
 * Build the payload for wallet.signAndSendTransaction.
 * Refuses to target the live registry, which is read-only for writes.
 * Does not sign or send.
 */
export function buildSignAndSendTransaction({ receiverId, methodName, args = {}, gas, deposit } = {}) {
  if (!receiverId || typeof receiverId !== "string") throw new Error("receiverId is required");
  if (isRegistryWriteBlocked(receiverId)) {
    throw new Error("The live registry is read-only for writes");
  }
  return {
    receiverId,
    actions: [functionCallAction(methodName, args, { gas, deposit })],
  };
}
