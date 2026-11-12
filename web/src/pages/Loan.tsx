import { useEffect, useState } from "react";
import { loadLoan } from "../../data/registry.mjs";
import { verdictState } from "../../data/derive.mjs";
import { fixtureLoan, loanIdOf, useRecompute } from "../shell/engine";
import { recordFor, VERDICTS } from "../shell/evidence";
import { assetLabel, countdown, fundName, short, usdWhole, when, whenFull } from "../shell/fmt";
import { ErrorBox, Hash, Note, PageHead, Panel, Q, Skel, SrcTag } from "../shell/kit";
import { useAsync, useRegistry } from "../shell/store";
import { sha256Hex } from "../lib/webhash";
import { A } from "../ui";

export default function Loan({ hash }: { hash: string }) {
  const { view, tag, now } = useRegistry();
  const { data, error, loading, retry } = useAsync(() => loadLoan(hash), [hash]);
  const known = view.loans.find((l) => l.loan_hash === hash);
  const loanId = loanIdOf(hash);
  const fx = fixtureLoan(loanId);
  const rc = useRecompute(view).find((x) => x.r.fundId === (known?.fund_id || fx?.fund));
  const rec = recordFor(hash);
  const [respMatch, setRespMatch] = useState<null | boolean>(null);
  const latest = data?.verdicts?.length ? data.verdicts[data.verdicts.length - 1] : known?.latest ?? null;
  useEffect(() => {
    if (!rec?.onchain || !latest) return;
    void sha256Hex(rec.onchain.response_body).then((h) => setRespMatch(h === latest.response_sha256));
  }, [rec, latest]);
  const excluded = rc?.r.unverified?.reasons?.find((u: { id: string; reason: string }) => u.id === loanId);
  const verdict = latest?.verdict;
  return (
    <>
      <PageHead crumbs={[["Loans", "/loans"], ...(known?.fund_id ? [[fundName(known.fund_id), `/funds/${known.fund_id}`] as [string, string]] : []), [short(hash, 6, 4)]]}
        title={<span className="mono" style={{ fontSize: 20 }}>{short(hash, 12, 8)}</span>}
        chips={<><Hash h={hash} a={64} z={0} /></>}
        lead={known ? `${assetLabel(known.asset_type)} loan pledged by ${fundName(known.fund_id)} on ${whenFull(known.issued_at_ms)}.` : undefined} />
      {loading && !data ? <Skel rows={4} /> : null}
      {error ? <ErrorBox error={error} retry={retry} /> : null}
      {data && !data.token ? <Note tone="warn">No pledge token with this hash on the registry. It was never pledged, or it was repaid and released.</Note> : null}

      {data?.token || known ? (
        <>
          <Panel title="Two separate checks on this loan" sub="The enclave checks the document. The engine checks the servicer's loan tape. They can disagree, and this page shows both." tags={<><SrcTag tag={data ? "live" : tag} source="get_latest_verdict" /><SrcTag tag="recorded" source="spec/nav/fixtures.json (engine input)" /><SrcTag tag="computed" source="engine/src/score.mjs" /></>}>
            <div className="twocol">
              <div>
                <h3>Documents (enclave)</h3>
                <div className="big" style={{ color: verdict === "pass" ? "var(--green)" : verdict ? "var(--red)" : "var(--muted)" }}>{verdict ?? "no verdict"}</div>
                <p className="dim">Signed inside the NEAR AI Cloud TEE by {short(latest?.signer, 6, 4)}, model {latest?.model_id ?? "n/a"}. Anomaly codes: {latest?.anomalies?.length ? latest.anomalies.join(", ") : "none"}.</p>
              </div>
              <div>
                <h3>Servicer data (engine input) and TrueVal</h3>
                {fx ? (
                  <>
                    <div className="big" style={{ color: excluded ? "var(--yellow)" : "var(--green)" }}>{excluded ? "excluded from TrueVal" : "counted in TrueVal"}</div>
                    <p className="dim">
                      Bucket {fx.loan.bucket.replace(/_/g, " ")}{fx.loan.anomaly ? ", servicer anomaly flag set" : ", no anomaly flag"}.
                      {excluded ? ` The engine treats it as unverified (${excluded.reason}) and leaves it out of TrueVal.` : ""}
                      {fx.loan.note ? ` Tape note: "${fx.loan.note}".` : ""}
                    </p>
                  </>
                ) : <p className="dim">This loan is not in the committed engine input.</p>}
              </div>
            </div>
            {fx && verdict === "pass" && excluded ? (
              <Note tone="warn">documents: pass (enclave). servicer data: anomaly flag, excluded from TrueVal. The on-chain verdict covers the document only; the exclusion comes from the servicer's tape, which the engine reads separately. This is a different loan from the refused double pledge.</Note>
            ) : null}
          </Panel>

          <div className="grid2">
            <Panel title="Lock and token" tags={<SrcTag tag={data ? "live" : tag} source="get_lock, nft_token" />}>
              <table className="kvt"><tbody>
                <tr><th>Holder fund</th><td>{fundName(data?.lock?.fund_id ?? known?.fund_id)}</td></tr>
                <tr><th>Locked at</th><td>{whenFull(data?.lock?.locked_at_ms ?? known?.lock?.locked_at_ms)}</td></tr>
                <tr><th>Owner account</th><td>{data?.token?.owner_id ?? known?.owner_id}</td></tr>
                <tr><th><Q id="pledge-token">Token</Q></th><td>non-transferable NEP-171</td></tr>
                <tr><th>Asset type</th><td>{assetLabel(known?.asset_type)}</td></tr>
                <tr><th>Past flags</th><td>{data?.flagCount ?? known?.flagCount ?? 0}</td></tr>
                {loanId ? <tr><th>Demo loan id</th><td>{loanId} <SrcTag tag="recorded" source="tee/loans.json" /></td></tr> : null}
              </tbody></table>
            </Panel>
            <Panel title="Latest verdict" tags={<SrcTag tag={data ? "live" : tag} source="get_latest_verdict" />}>
              {latest ? (
                <table className="kvt"><tbody>
                  <tr><th>Verdict</th><td>{latest.verdict}</td></tr>
                  <tr><th>Stored</th><td>{whenFull(Number(latest.at_ms))}</td></tr>
                  <tr><th>Valid until</th><td>{whenFull(Number(latest.expires_at_ms))} ({verdictState(latest, now) === "current" ? countdown(Number(latest.expires_at_ms) - now) : "expired"})</td></tr>
                  <tr><th>Submitted by</th><td>{latest.submitted_by}</td></tr>
                  <tr><th>Request sha256</th><td>{short(latest.request_sha256, 10, 8)}</td></tr>
                  <tr><th>Response sha256</th><td>{short(latest.response_sha256, 10, 8)}</td></tr>
                  <tr><th>Attestation sha256</th><td>{short(latest.attestation_sha256, 10, 8)}</td></tr>
                  <tr><th>Recorded reply hash</th><td>{respMatch === null ? "checking..." : respMatch ? <span className="ok">sha256 of the recorded signed reply equals the on-chain hash</span> : <span className="bad">differs</span>}</td></tr>
                </tbody></table>
              ) : <p className="dim">No verdict on chain.</p>}
            </Panel>
          </div>

          {rec ? (
            <Panel className="mt" title="What the enclave checked" sub="The signed reply holds only the loan hash, the binding, the verdict and anomaly codes. No document text. The checks below were run by the verifier when the reply was recorded." tags={<SrcTag tag="recorded" source={`tee/fixtures/verdicts-368aa2.json, signed ${when(VERDICTS.signed_at_ms)}`} />}>
              <p>Verdict <b>{rec.verdict.verdict}</b>, anomaly codes {rec.verdict.anomalies.length ? rec.verdict.anomalies.join(", ") : "none"}. Bound to <span className="mono">{String(rec.verdict.binding ?? "")}</span>.</p>
              <table className="dt"><thead><tr><th>Verifier check on the signed reply</th><th>Result</th></tr></thead>
                <tbody>{Object.entries(rec.checks).map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, " ")}</td><td>{v ? <span className="ok">pass</span> : <span className="bad">fail</span>}</td></tr>)}</tbody></table>
              <p className="mt"><A href={`/features/tee-underwriting?loan=${hash}`} className="xb sm ghost">See the signed reply</A> <A href={`/features/verdicts?loan=${hash}`} className="xb sm ghost">Verdict history</A></p>
            </Panel>
          ) : null}

          {data?.verdicts?.length ? (
            <Panel className="mt" title={`Verdict history (${data.verdictCount})`} pad={false} tags={<SrcTag tag="live" source="get_verdicts_page" />}>
              <table className="dt"><thead><tr><th>#</th><th>Verdict</th><th>Anomalies</th><th>Stored</th><th>Expires</th><th>Submitted by</th></tr></thead>
                <tbody>{data.verdicts.map((v: { verdict: string; anomalies: string[]; at_ms: number; expires_at_ms: number; submitted_by: string }, i: number) => (
                  <tr key={i}><td>{i + 1}</td><td>{v.verdict}</td><td>{v.anomalies.join(", ") || "none"}</td><td>{whenFull(Number(v.at_ms))}</td><td>{whenFull(Number(v.expires_at_ms))}</td><td className="mono">{v.submitted_by}</td></tr>
                ))}</tbody></table>
            </Panel>
          ) : null}

          <Panel className="mt" title="Privacy">
            <p>On chain: the loan hash, the holder, the verdict, anomaly codes, the request and response hashes. Not on chain: the document or the borrower. Someone who already holds the document can recompute the request hash and so link it to this loan and fund.</p>
            {fx ? <p className="dim">Engine input for this loan (fictional, from the committed fixtures): principal {usdWhole(fx.loan.principal)}, accrued {usdWhole(fx.loan.accrued)}, repaid {usdWhole(fx.loan.repaid)}. <SrcTag tag="recorded" source="spec/nav/fixtures.json" /></p> : null}
          </Panel>
        </>
      ) : null}
    </>
  );
}
