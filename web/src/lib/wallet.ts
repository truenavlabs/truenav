// Wallet connector data layer. No layout. Network is testnet only.
// Connect and disconnect only; this module does not sign or send a transaction.
import { NearConnector } from "@hot-labs/near-connect";
import type { Account, NearWalletBase } from "@hot-labs/near-connect";

export const WALLET_NETWORK = "testnet" as const;
export type WalletNetwork = typeof WALLET_NETWORK;

/** Options passed to NearConnector. features.testnet hides wallets that do not support testnet. */
export const WALLET_CONNECTOR_OPTIONS = {
  network: WALLET_NETWORK,
  features: { testnet: true as const },
};

let instance: NearConnector | null = null;

/** One shared connector for the app. Create it in the browser, not at module load. */
export function getWalletConnector(): NearConnector {
  if (!instance) instance = new NearConnector({ ...WALLET_CONNECTOR_OPTIONS });
  return instance;
}

/** Test helper. Does not touch a live wallet. */
export function resetWalletConnector(): void {
  instance = null;
}

export function accountIdOf(accounts: Account[] | undefined): string {
  return accounts?.[0]?.accountId ?? "";
}

export type { Account, NearConnector, NearWalletBase };
