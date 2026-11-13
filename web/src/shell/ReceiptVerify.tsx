// Minimal view for the read-only "verify this receipt yourself" panel. Logic is in
// lib/useReceiptVerify.ts and lib/receipt-verify.mjs. Unstyled on purpose: the final UI pass restyles it.
import { useReceiptVerify, type Check, type VerifyResult } from "../lib/useReceiptVerify";
import { Ext, Note, Panel } from "./kit";

const STATE_LABEL: Record<Check["state"], string> = { live: "Checked now", fail: "Failed", unchecked: "Not checked" };

export function ReceiptVerify({ initialQuery = "" }: { initialQuery?: string }) {
  const { query, setQuery, state, run } = useReceiptVerify({ initialQuery, auto: true });
  const loading = state.phase === "loading";
  return (
    <Panel title="Verify this receipt yourself" sub="Read-only views on the receipts contract and, for a transaction hash, tx status RPC. Nothing is signed or sent.">
      <p className="dim">Paste a request id, a token and sequence (TOKEN:1), or a testnet transaction hash. This browser re-reads the stored run and checks the fields and hashes it can, and labels the rest as not checkable.</p>
      <p className="mt">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          aria-label="Receipt, run id, or transaction hash"
          placeholder="1, DEMO-CREDIT:1, or a tx hash"
          size={44}
        />{" "}
        <button type="button" className="xb sm" onClick={() => void run()} disabled={loading}>
          {loading ? "Checking..." : "Verify"}
        </button>
      </p>
      {state.phase === "error" ? <Note tone="bad">{state.message}</Note> : null}
      {state.phase === "done" ? <Result r={state.result} /> : null}
    </Panel>
  );
}

function Result({ r }: { r: VerifyResult }) {
  const c = r.summary.counts;
  const tone = c.fail ? "bad" : r.kind === "empty" || r.kind === "pending" || r.kind === "not_issued" ? "info" : r.summary.ok ? "ok" : "warn";
  const rec = r.receipt;
  const href = r.explorerUrl || (r.tx && r.tx.explorerUrl);
  const hash = r.tx && r.tx.hash;
  return (
    <div className="mt">
      <Note tone={tone}>{r.detail}</Note>
      {rec ? (
        <p className="mono dim mt">{rec.tokenId} seq {rec.seq}{rec.requestId ? ` request ${rec.requestId}` : ""}{rec.band ? ` ${rec.band}` : ""}{rec.wrapperSha ? ` sha256 ${rec.wrapperSha}` : ""}</p>
      ) : null}
      {hash && href ? <p className="mono mt">Tx <Ext href={href}>{hash}</Ext></p> : null}
      <div className="mt">
        {r.checks.map((x) => (
          <div className="checkrow" key={x.id} style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}>
            <span className={`st st-${x.state}`}>{STATE_LABEL[x.state]}</span>
            <div>
              <div className="cl">{x.label}</div>
              <div className="cd">{x.detail}</div>
              {x.source ? <div className="cd mono" style={{ fontSize: 11, color: "var(--dim)" }}>{x.source}</div> : null}
            </div>
          </div>
        ))}
      </div>
      <p className="dim mt">{c.live ?? 0} checked now, {c.unchecked ?? 0} not checked, {c.fail ?? 0} failed.</p>
    </div>
  );
}
