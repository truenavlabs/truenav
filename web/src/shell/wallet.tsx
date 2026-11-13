// React glue over src/lib/wallet.ts: one provider, one hook, and the top-bar button.
// Pages such as Investor and Fund manager can call useWallet() later for function calls.
// This build does not sign or send a transaction.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventMap } from "@hot-labs/near-connect";
import { A } from "../ui";
import { short } from "./fmt";
import { SLOTS } from "./slots";
import { accountIdOf, getWalletConnector, WALLET_NETWORK, type NearConnector, type NearWalletBase, type WalletNetwork } from "../lib/wallet";

export type WalletCtx = {
  network: WalletNetwork;
  loading: boolean;
  busy: boolean;
  signedAccountId: string;
  wallet: NearWalletBase | null;
  connector: NearConnector | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
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
      setWallet(payload.wallet);
      setSignedAccountId(accountIdOf(payload.accounts));
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
      const connected = await connector.connect();
      const accounts = await connected.getAccounts();
      setWallet(connected);
      setSignedAccountId(accountIdOf(accounts));
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

  const value = useMemo<WalletCtx>(
    () => ({ network: WALLET_NETWORK, loading, busy, signedAccountId, wallet, connector, error, signIn, signOut }),
    [loading, busy, signedAccountId, wallet, connector, error, signIn, signOut],
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
