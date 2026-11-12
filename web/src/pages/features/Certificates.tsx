import { KNOWN_TXS, loadTx } from "../../../data/tx.mjs";
import { fundName, short, txUrl, whenFull } from "../../shell/fmt";
import { A } from "../../ui";
import { ErrorBox, Ext, FeatureFrame, Hash, Note, PageHead, Panel, Skel, SrcTag, StatusChip } from "../../shell/kit";
import { useAsync, useRegistry } from "../../shell/store";

function RefusedCert() {
  const { hash, sender } = KNOWN_TXS.refusedCertificate;
  const { data, error, loading, retry } = useAsync(() => loadTx(hash, sender), [hash]);
  return (
    <Panel className="mt" title="A certificate the registry refused" sub="Read live from NEAR RPC (tx) in your browser." tags={<SrcTag tag="live" source={`tx ${short(hash, 4, 4)}`} />} right={<Ext href={txUrl(hash)}>Explorer</Ext>}>
      {loading ? <Skel rows={3} /> : error ? <ErrorBox error={error} retry={retry} /> : data ? (
        <>
          <table className="kvt"><tbody>
            <tr><th>Transaction</th><td><Hash h={hash} a={10} z={6} /></td></tr>
            <tr><th>Sent by</th><td>{data.signer}</td></tr>
            <tr><th>Called</th><td>{data.receiver} . {data.method}</td></tr>
            <tr><th>Block time</th><td>{whenFull(data.blockTimeMs)}</td></tr>
            <tr><th>Result</th><td>{data.ok ? <span className="ok">success</span> : <span className="bad">{data.failure}</span>}</td></tr>
          </tbody></table>
          <p className="dim mt">The certificate was signed by a key that is not on the registry's signer list, so the contract refused it and stored nothing. Anyone can send a certificate; only a registered signer's is kept.</p>
        </>
      ) : null}
    </Panel>
  );
}

export default function Certificates() {
  const { view, tag } = useRegistry();
  const signer = (view.signers as string[] | undefined)?.[0];
  const tryIt = (
    <>
      <Note tone="warn">Signed by a test key held by TrueNav Labs ({short(signer, 6, 4)}), not a TEE key. Anyone can recompute the numbers: <A href="/features/engine">recompute a score</A>.</Note>
      <div className="grid2">
        {view.funds.map((f) => {
          const c = f.certificate?.certificate;
          return (
            <Panel key={f.fund_id} title={fundName(f.fund_id)} tags={<SrcTag tag={tag} source="get_latest_certificate, get_certificate_count, get_certificate_history_page" />}>
              {c ? (
                <table className="kvt"><tbody>
                  <tr><th>Score</th><td>{c.score} {c.band}</td></tr>
                  <tr><th>Signed</th><td>{whenFull(c.signed_at_ms)}</td></tr>
                  <tr><th>Stored</th><td>{whenFull(f.certificate?.stored_at_ms)}</td></tr>
                  <tr><th>Signer</th><td>{short(f.certificate?.signer, 8, 6)}</td></tr>
                  <tr><th>Engine commit</th><td>{c.engine_commit}</td></tr>
                  <tr><th>Certificates stored</th><td>{f.certCount}</td></tr>
                  <tr><th>History (signed at)</th><td>{(f.certHistory || []).map((t: number) => whenFull(t)).join("; ")}</td></tr>
                </tbody></table>
              ) : <p className="dim">No certificate.</p>}
              <details className="mt"><summary>Raw certificate</summary><pre className="raw">{JSON.stringify(f.certificate, null, 2)}</pre></details>
            </Panel>
          );
        })}
      </div>
      <RefusedCert />
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F6 Certificates"]]} title="Certificates" lead="The score, TrueVal and TrueRange for each fund, signed and stored on the registry. Read them live, with their history." />
      <FeatureFrame
        what="The engine's output is signed off chain over a message naming this registry. The contract recovers the signer, checks it is registered and that the signing time moves forward, then stores the certificate."
        status={<StatusChip kind="live" />}
        tryIt={tryIt}
        proves={["The certificate on chain for each fund and when it was signed and stored.", "A certificate from an unregistered key is refused: the real refusal is shown above.", "The numbers match the public engine (see F5)."]}
        notProves={["That the signer is independent. It is a test key held by TrueNav Labs, and the same address is the servicer pledge key (known limit N-07).", "That the inputs are true. The certificate signs what the engine computed."]}
        run={["npm run chain:read", "npm run verify:live-signer"]}
        sources={["contract/src/lib.rs", "certify/run.mjs", "certify/chain-read.mjs", "certify/live-registry.json"]}
      />
    </>
  );
}
