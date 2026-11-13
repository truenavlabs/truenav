// Wallet connector data layer. No layout. Network is testnet only.
// Connect and disconnect only; this module does not sign or send a transaction.
import { NearConnector } from "@hot-labs/near-connect";
import type { Account, NearWalletBase } from "@hot-labs/near-connect";
import { accountIdOf, clearUnsafeHash, isTestnetAccountId, noDebugWalletStorage } from "./wallet-guards.mjs";
import PINNED_MANIFEST from "./wallet-manifest.json";

export const WALLET_NETWORK = "testnet" as const;
export type WalletNetwork = typeof WALLET_NETWORK;

/**
 * Options passed to NearConnector.
 * - manifest: the pinned copy in wallet-manifest.json, so an upstream manifest change cannot add wallets
 *   or permissions. Executor code is still fetched live, bounded by these permissions.
 * - features.testnet hides wallets that do not support testnet.
 * - autoConnect false: a wallet announced over postMessage is listed but never connected on its own.
 */
export const WALLET_CONNECTOR_OPTIONS = {
  network: WALLET_NETWORK,
  features: { testnet: true as const },
  autoConnect: false,
  manifest: { version: PINNED_MANIFEST.version, wallets: PINNED_MANIFEST.wallets as never[] },
};

/**
 * Static CSP nonce for near-connect's srcdoc wallet iframe, which inherits the page CSP. It must equal
 * the 'nonce-...' in web/vercel.json script-src (web/test/headers.test.mjs checks). It is public, so it
 * does not stop an attacker who can write a whole <script nonce> tag; it does block inline event
 * handlers and javascript: URLs, which 'unsafe-inline' would allow.
 */
export const WALLET_CSP_NONCE = "WYgy5ANloUrvzOMszqAbW4a0";

let instance: NearConnector | null = null;

/** One shared connector for the app. Create it in the browser, not at module load. */
export function getWalletConnector(): NearConnector {
  if (!instance) instance = new NearConnector({ ...WALLET_CONNECTOR_OPTIONS, storage: noDebugWalletStorage(), cspNonce: WALLET_CSP_NONCE });
  return instance;
}

/** Test helper. Does not touch a live wallet. */
export function resetWalletConnector(): void {
  instance = null;
}

export { accountIdOf, clearUnsafeHash, isTestnetAccountId };
export type { Account, NearConnector, NearWalletBase };
