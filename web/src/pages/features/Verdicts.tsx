import { useEffect, useState } from "react";
import { loadLoan } from "../../../data/registry.mjs";
import { verdictState } from "../../../data/derive.mjs";
import { LOAN_MAP } from "../../shell/engine";
import { recordFor } from "../../shell/evidence";
import { countdown, fundName, short, whenFull } from "../../shell/fmt";
import { ErrorBox, FeatureFrame, Hash, Note, PageHead, Panel, Skel, SrcTag, StatusChip } from "../../shell/kit";
import { useAsync, useRegistry } from "../../shell/store";
import { sha256Hex } from "../../lib/webhash";

type V = { verdict: string; anomalies: string[]; signer: string; model_id: string; request_sha256: string; response_sha256: string; attestation_sha256: string; expires_at_ms: number; submitted_by: string; at_ms: number };

function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const st = verdictState({ expires_at_ms: to }, now);
  return <span className={st === "current" ? "ok" : "bad"}>{st === "current" ? `current, ${countdown(to - now)} left` : "expired"}</span>;
}

export default function Verdicts({ q }: { q?: URLSearchParams }) {
  const { now } = useRegistry();
  const first = q?.get("loan") || LOAN_MAP.find((l) => l.loan_id === "M-IN-03")!.loan_hash;
  const [input, setInput] = useState(first);
  const [hash, setHash] = useState(first);
  const valid = /^[0-9a-f]{64}$/.test(hash);
  const { data, error, loading, retry } = useAsync(() => (valid ? loadLoan(hash) : Promise.resolve(null)), [hash]);
  const latest = (data?.latest ?? null) as V | null;
  const rec = recordFor(hash);
  const [match, setMatch] = useState<boolean | null>(null);
  useEffect(() => { setMatch(null); if (rec?.onchain && latest) void sha256Hex(rec.onchain.response_body).then((h) => setMatch(h === latest.response_sha256)); }, [rec, latest]);
  const id = LOAN_MAP.find((l) => l.loan_hash === hash);

  const tryIt = (
    <>
      <form className="hrow" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); setHash(input.trim().toLowerCase()); }}>
        <select value={LOAN_MAP.some((l) => l.loan_hash === input) ? input : ""} onChange={(e) => { setInput(e.target.value); setHash(e.target.value); }}>
          <option value="">paste a hash</option>
          {LOAN_MAP.map((l) => <option key={l.loan_hash} value={l.loan_hash}>{l.loan_id} ({fundName(l.fund_id)})</option>)}
        </select>
        <input className="mono" style={{ flex: 1, minWidth: 260 }} value={input} onChange={(e) => setInput(e.target.value)} aria-label="Loan hash" />
        <button className="xb sm">Read</button>
      </form>
      <div className="mt">
        {!valid ? <Note tone="warn">A loan hash is 64 lowercase hex characters.</Note> : loading ? <Skel rows={4} /> : error ? <ErrorBox error={error} retry={retry} /> : data && !latest ? (
          <Note tone="info">No verdict on chain for this hash.</Note>
        ) : latest ? (
          <div className="grid2" style={{ marginTop: 0 }}>
            <Panel title={id ? `${id.loan_id}, latest verdict` : "Latest verdict"} tags={<SrcTag tag="live" source="get_latest_verdict, get_verdict_count" />}>
              <table className="kvt"><tbody>
                <tr><th>Verdict</th><td><b className={latest.verdict === "pass" ? "ok" : "bad"}>{latest.verdict}</b>{latest.anomalies.length ? `: ${latest.anomalies.join(", ")}` : ""}</td></tr>
                <tr><th>Expiry</th><td>{whenFull(Number(latest.expires_at_ms))}, <Countdown to={Number(latest.expires_at_ms)} /></td></tr>
                <tr><th>Stored</th><td>{whenFull(Number(latest.at_ms))} by {latest.submitted_by}</td></tr>
                <tr><th>Signer</th><td>{short(latest.signer, 8, 6)}</td></tr>
                <tr><th>Model</th><td>{latest.model_id}</td></tr>
                <tr><th>Verdicts stored</th><td>{data!.verdictCount}, of which flags: {data!.flagCount}</td></tr>
              </tbody></table>
            </Panel>
            <Panel title="Does the recorded reply match?" tags={<><SrcTag tag="recorded" source="tee/fixtures/verdicts-368aa2.json" /><SrcTag tag="computed" source="WebCrypto sha256" /></>}>
              {rec ? (
                <>
                  <p>sha256 of the recorded signed reply: {match === null ? "hashing..." : match ? <span className="ok">equals the response hash on chain</span> : <span className="bad">differs from the hash on chain</span>}</p>
                  <p className="dim">On chain: <Hash h={latest.response_sha256} a={10} z={8} /></p>
                </>
              ) : <p className="dim">No recorded reply for this hash.</p>}
              <p className="dim mt">A verdict counts while now is at or before its expiry, exactly as the contract compares it.</p>
            </Panel>
          </div>
        ) : null}
      </div>
      {data?.verdicts?.length ? (
        <Panel className="mt" title="History" pad={false} tags={<SrcTag tag="live" source="get_verdicts_page" />}>
          <table className="dt"><thead><tr><th>#</th><th>Verdict</th><th>Anomalies</th><th>Stored</th><th>Expires</th><th>State now</th></tr></thead>
            <tbody>{(data.verdicts as V[]).map((v, k) => <tr key={k}><td>{k + 1}</td><td>{v.verdict}</td><td>{v.anomalies.join(", ") || "none"}</td><td>{whenFull(Number(v.at_ms))}</td><td>{whenFull(Number(v.expires_at_ms))}</td><td>{verdictState(v, now)}</td></tr>)}</tbody></table>
        </Panel>
      ) : null}
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F2 On-chain verdicts"]]} title="On-chain verdicts" lead="Read any loan's enclave verdict and its full history straight from the registry." />
      <FeatureFrame
        what="Every verdict the enclave signs is stored on the registry with its expiry, signer and the hashes of the request and the reply. The latest one counts; older ones stay as history."
        status={<StatusChip kind="live" />}
        tryIt={tryIt}
        proves={["Which verdict the registry holds for a loan right now, and since when.", "That the recorded signed reply is byte for byte the one whose hash is on chain.", "That an expired verdict stops counting at its expiry time."]}
        notProves={["What the document says. Only its verdict and hashes are public.", "That the verdict is right. See F1 for the eval and its limits."]}
        run={["npm run check:chain-replies", "npm run chain:read"]}
        sources={["contract/src/lib.rs", "certify/check-chain-replies.mjs", "web/data/registry.mjs"]}
      />
    </>
  );
}
