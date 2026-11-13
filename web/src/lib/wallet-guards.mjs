// Wallet guards with no dependencies, so Node tests can import them. Used by lib/wallet.ts.

/** Storage key near-connect 0.12.0 uses for manifests pasted into its debug box. */
export const DEBUG_WALLETS_KEY = "debug-wallets";

const browserStorage = {
  async get(key) {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  },
  async set(key, value) {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  },
  async remove(key) {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  },
};

/**
 * A near-connect DataStorage over localStorage, except pasted debug manifests are never saved or
 * reloaded. near-connect 0.12.0 has no option to turn the debug box off; app.css also hides its button.
 */
export function noDebugWalletStorage(inner = browserStorage) {
  return {
    get: async (key) => (key === DEBUG_WALLETS_KEY ? null : inner.get(key)),
    set: async (key, value) => {
      if (key !== DEBUG_WALLETS_KEY) await inner.set(key, value);
    },
    remove: async (key) => inner.remove(key),
  };
}

/** A named .testnet account, or a 64 hex implicit account. Anything else is not shown as connected. */
export function isTestnetAccountId(id) {
  if (typeof id !== "string" || id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  return /^(([a-z0-9]+[-_])*[a-z0-9]+\.)+testnet$/.test(id);
}

/** First account id from a near-connect accounts list, or "" when it is not a testnet account. */
export function accountIdOf(accounts) {
  const id = Array.isArray(accounts) && accounts[0] ? accounts[0].accountId : "";
  return isTestnetAccountId(id) ? id : "";
}

/**
 * near-connect 0.12.0 writes location.href into the wallet iframe's script without escaping, so a
 * backslash in the fragment breaks the iframe. Drop such a fragment before connecting.
 */
export function clearUnsafeHash(loc = globalThis.location, hist = globalThis.history) {
  if (!loc || !hist || !loc.hash || !/[\\`"'<>]/.test(loc.hash)) return false;
  hist.replaceState(null, "", loc.pathname + loc.search);
  return true;
}
