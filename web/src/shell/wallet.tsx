// React glue over src/lib/wallet.ts: one provider, one hook, and the top-bar button.
// Pages get connect, disconnect, the account id and one write function, sendReceiptsCall, which runs
// the allowlist guard in lib/near.mjs (receipts contract only, listed methods, capped gas and deposit)
// before the wallet shows the call. The raw wallet and connector are not exposed.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventMap } from "@hot-labs/near-connect";
import { A } from "../ui";
import { short } from "./fmt";
import { SLOTS } from "./slots";
import { accountIdOf, clearUnsafeHash, getWalletConnector, WALLET_NETWORK, type NearConnector, type NearWalletBase, type WalletNetwork } from "../lib/wallet";
import { buildSignAndSendTransaction, RECEIPTS_CONTRACT } from "../lib/near.mjs";

/** gas in gas units and depositYocto in yoctoNEAR, both decimal digit strings. */
export type ReceiptsCallOpts = { gas?: string; depositYocto?: string };

export type WalletCtx = {
  network: WalletNetwork;
  loading: boolean;
  busy: boolean;
  signedAccountId: string;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Sign and send one function call to the receipts contract. Throws before the wallet on a guard failure. */
  sendReceiptsCall: (method: string, args?: Record<string, unknown>, opts?: ReceiptsCallOpts) => Promise<unknown>;
};

const WalletContext = createContext<WalletCtx | null>(null);

function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && (e as Error).message) return String((e as Error).message);
  return "Wallet request did not complete";
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [connector, setConnector] = useState<NearConnector | null>(null);
  const [wallet, setWallet] = useState<NearWalletBase | null>(null);
  const [signedAccountId, setSignedAccountId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const c = getWalletConnector();
    setConnector(c);

    const onIn = (payload: EventMap["wallet:signIn"]) => {
      if (cancelled) return;
      const id = accountIdOf(payload.accounts);
      setWallet(id ? payload.wallet : null);
      setSignedAccountId(id);
      setError(null);
    };
    const onOut = () => {
      if (cancelled) return;
      setWallet(null);
      setSignedAccountId("");
    };
    c.on("wallet:signIn", onIn);
    c.on("wallet:signOut", onOut);

    void (async () => {
      try {
        await c.whenManifestLoaded;
        if (cancelled) return;
        const current = await c.getConnectedWallet();
        if (cancelled) return;
        const id = accountIdOf(current.accounts);
        if (id) {
          setWallet(current.wallet);
          setSignedAccountId(id);
        }
      } catch {
        // No existing session.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      c.off("wallet:signIn", onIn);
      c.off("wallet:signOut", onOut);
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!connector) return;
    setBusy(true);
    setError(null);
    try {
      clearUnsafeHash();
      const connected = await connector.connect();
      const accounts = await connected.getAccounts();
      const id = accountIdOf(accounts);
      setWallet(id ? connected : null);
      setSignedAccountId(id);
      if (!id) setError("That wallet did not return a NEAR testnet account");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [connector]);

  const signOut = useCallback(async () => {
    if (!connector) return;
    setBusy(true);
    setError(null);
    try {
      await connector.disconnect(wallet ?? undefined);
      setWallet(null);
      setSignedAccountId("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [connector, wallet]);

  const sendReceiptsCall = useCallback(
    async (method: string, args: Record<string, unknown> = {}, opts: ReceiptsCallOpts = {}) => {
      if (!wallet || !signedAccountId) throw new Error("Connect a testnet wallet first");
      const payload = buildSignAndSendTransaction({ receiverId: RECEIPTS_CONTRACT, methodName: method, args, gas: opts.gas, depositYocto: opts.depositYocto });
      return wallet.signAndSendTransaction({ network: WALLET_NETWORK, signerId: signedAccountId, receiverId: RECEIPTS_CONTRACT, actions: payload.actions as never });
    },
    [wallet, signedAccountId],
  );

  const value = useMemo<WalletCtx>(
    () => ({ network: WALLET_NETWORK, loading, busy, signedAccountId, error, signIn, signOut, sendReceiptsCall }),
    [loading, busy, signedAccountId, error, signIn, signOut, sendReceiptsCall],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletCtx {
  const c = useContext(WalletContext);
  if (!c) throw new Error("WalletProvider missing");
  return c;
}

function WalletButton() {
  const { signedAccountId, loading, busy, error, signIn, signOut } = useWallet();
  if (signedAccountId) {
    return (
      <div className="walletslot">
        <A href={`/account/${encodeURIComponent(signedAccountId)}`} className="xb sm ghost mono" title={signedAccountId}>
          {short(signedAccountId, 10, 8)}
        </A>
        <button type="button" className="xb sm ghost" onClick={() => void signOut()} disabled={busy} title={error ?? "Disconnect this testnet wallet"}>
          Disconnect
        </button>
      </div>
    );
  }
  return (
    <div className="walletslot">
      <button type="button" className="xb sm" onClick={() => void signIn()} disabled={loading || busy} title={error ?? "Connect a NEAR testnet wallet"}>
        {loading ? "Wallet..." : busy ? "Connecting..." : "Connect wallet"}
      </button>
      <A href="/account" className="xb sm ghost">View as account</A>
    </div>
  );
}

SLOTS.Wallet = WalletButton;
