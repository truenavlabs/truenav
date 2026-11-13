// Minimal view for the one testnet write the app makes: request_run on the receipts contract. Logic is in
// lib/useReceiptsRun.ts and lib/receipts-write.mjs. Unstyled on purpose: the final UI pass restyles it.
import { useWallet } from "./wallet";
import { useReceiptsRun, type RunOutcome } from "../lib/useReceiptsRun";
import { Ext, Note, Panel } from "./kit";

/** Role actions that would write somewhere other than receipts request_run. Shown read-only, never wired. */
export const NOT_WIRED: Record<"investor" | "manager", { label: string; why: string }[]> = {
  investor: [
    { label: "Buy a paid report (query contract buy_query)", why: "Writes to the query contract, not receipts. Read-only here." },
  ],
  manager: [
    { label: "Pledge a loan (registry pledge_loan)", why: "Writes to the registry, which this app never writes to. Read-only here." },
    { label: "Become a runner (receipts set_runner)", why: "An admin call on receipts that is not on the write allowlist. Read-only here." },
  ],
};

export function ReceiptRunAction({ role }: { role: "investor" | "manager" }) {
  const { signedAccountId, sendReceiptsCall, signIn, busy } = useWallet();
  const { tokens, tokenId, setTokenId, state, review, confirm, cancel } = useReceiptsRun({ accountId: signedAccountId, sendReceiptsCall });
  const working = state.phase === "checking" || state.phase === "signing";
  return (
    <Panel title="Testnet action: request a fresh receipt run" sub="receipts request_run, signed by your connected testnet wallet">
      <p className="dim">Asks the receipts contract to run the pinned engine for one token. The contract allows this for runner accounts only.</p>
      {!signedAccountId ? (
        <p className="mt"><button type="button" className="xb sm" onClick={() => void signIn()} disabled={busy}>Connect a testnet wallet</button></p>
      ) : (
        <p className="mt">
          <select value={tokenId} onChange={(e) => setTokenId(e.target.value)} disabled={working || !tokens.length} aria-label="Token">
            {tokens.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>{" "}
          <button type="button" className="xb sm" onClick={() => void review()} disabled={working || !tokenId || state.phase === "confirm"}>
            {state.phase === "checking" ? "Checking..." : "Review request_run"}
          </button>
        </p>
      )}
      {state.phase === "blocked" ? <Note tone="warn"><b>Not sent.</b><ul className="plain">{state.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Note> : null}
      {state.phase === "confirm" || state.phase === "signing" ? (
        <div className="mt">
          <p><b>Confirm before your wallet signs:</b></p>
          <table><tbody>{state.rows.map(([k, v]) => <tr key={k}><th>{k}</th><td className="mono">{v}</td></tr>)}</tbody></table>
          {state.phase === "signing" ? <p className="mt">Waiting for your wallet...</p> : (
            <p className="mt">
              <button type="button" className="xb sm" onClick={() => void confirm()}>Sign and send</button>{" "}
              <button type="button" className="xb sm ghost" onClick={cancel}>Cancel</button>
            </p>
          )}
        </div>
      ) : null}
      {state.phase === "done" ? <Outcome o={state.outcome} account={signedAccountId} onReset={cancel} /> : null}
      <p className="dim mt">Not wired here, read-only:</p>
      <ul className="plain dim">{NOT_WIRED[role].map((n) => <li key={n.label}>{n.label}: {n.why}</li>)}</ul>
    </Panel>
  );
}

function Outcome({ o, account, onReset }: { o: RunOutcome; account: string; onReset: () => void }) {
  const tone = o.kind === "stored" || o.kind === "submitted" ? "ok" : o.kind === "rejected" ? "info" : "bad";
  return (
    <Note tone={tone}>
      {"message" in o ? <p>{o.message}</p> : (
        <>
          <p>{o.detail}</p>
          {o.hash && o.explorerUrl ? <p className="mono">Tx <Ext href={o.explorerUrl}>{o.hash}</Ext></p> : null}
        </>
      )}
      {o.kind === "timeout" ? <p><Ext href={`https://testnet.nearblocks.io/address/${encodeURIComponent(account)}`}>Your account on nearblocks testnet</Ext></p> : null}
      <p className="mt"><button type="button" className="xb sm ghost" onClick={onReset}>Done</button></p>
    </Note>
  );
}
