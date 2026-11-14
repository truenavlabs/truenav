import { useEffect, useState } from "react";
import { STATUS, VERDICTS } from "../../shell/evidence";
import { short, whenFull } from "../../shell/fmt";
import { FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";
import { useRegistry } from "../../shell/store";
import { b64ToBytes, sha256Hex } from "../../lib/webhash";
import { bindingResult, reportSigningAddress } from "../../lib/attestation-binding.mjs";

const MUTATIONS: [string, string][] = [
  ["Wrong nonce", "Echoed nonce matches; quote binds the request nonce"],
  ["Edited app_compose", "Measured config (MRCONFIGID) matches app_compose"],
  ["Edited RTMR3 event", "Event log replays to RTMR3"],
  ["Swapped signing address", "Quote binds the signing address"],
  ["One quote byte flipped", "Intel TDX quote signature and collateral"],
  ["GPU evidence removed", "NVIDIA GPU attestation (NRAS) with our nonce"],
];

export default function Attestation() {
  const { view, tag } = useRegistry();
  const onChain = (view.teeSigners as { attestation_sha256?: string; address?: string }[] | undefined)?.[0];
  const [st, setSt] = useState<{ sha: string | null; bytes: number; ms: number; addr: string | null } | null>(null);
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    let live = true;
    setSt(null);
    const t0 = performance.now();
    void import("../../../../tee/fixtures/attestation-report-368aa2.json.b64?raw").then(async (m) => {
      const bytes = b64ToBytes(m.default as string);
      if (flip) bytes[bytes.length >> 1] ^= 1;
      const sha = await sha256Hex(bytes);
      if (live) setSt({ sha, bytes: bytes.length, ms: Math.round(performance.now() - t0), addr: reportSigningAddress(bytes) });
    });
    return () => { live = false; };
  }, [flip]);
  const bind = st ? bindingResult({ computedSha: st.sha ?? undefined, storedSha: onChain?.attestation_sha256, registryAddress: onChain?.address, reportAddress: st.addr }) : null;
  const att = VERDICTS.attestation;
  const checks = att.sections.flatMap((s) => s.checks.map((c) => ({ ...c, section: s.name })));
  const tryIt = (
    <>
      <Panel title="(a) Live: the published report is the one the registry points to" tags={<><SrcTag tag="computed" source="WebCrypto sha256 of tee/fixtures/attestation-report-368aa2.json.b64 (decoded)" /><SrcTag tag={tag} source="get_tee_signers attestation_sha256" /></>}
        right={<button className={`xb sm ${flip ? "" : "ghost"}`} onClick={() => setFlip((f) => !f)}>{flip ? "Undo the flipped bit" : "Flip one bit of the report"}</button>}>
        <table className="kvt"><tbody>
          <tr><th>sha256 computed in your browser</th><td className="mono">{st ? `${short(st.sha, 16, 12)} (${st.bytes.toLocaleString("en-US")} bytes, ${st.ms} ms)` : "hashing..."}</td></tr>
          <tr><th>Hash stored with the TEE signer on chain</th><td className="mono">{short(onChain?.attestation_sha256, 16, 12)}</td></tr>
          <tr><th>Result</th><td>{!st ? "" : <span className={bind?.state === "match" ? "ok" : "bad"}>{bind?.text}</span>}</td></tr>
        </tbody></table>
      </Panel>
      <Panel className="mt" title={`(b) Recorded: the ${checks.length} hardware and key-binding checks`} sub={`Run ${whenFull(Date.parse(att.checked_at))} with nonce ${short(att.nonce, 8, 6)}. The Intel quote check needs Intel collateral and the GPU check calls NVIDIA, so they are shown as recorded.`} tags={<SrcTag tag="recorded" source="tee/fixtures/verdicts-368aa2.json attestation" />} pad={false}>
        <table className="dt"><thead><tr><th>Component</th><th>Check</th><th>Result</th></tr></thead>
          <tbody>{checks.map((c, k) => <tr key={k}><td>{c.section}</td><td>{c.check}</td><td>{c.pass ? <span className="ok">pass</span> : <span className="bad">fail</span>}</td></tr>)}</tbody></table>
      </Panel>
      <Panel className="mt" title="(c) Tamper lab: six edits to the report, each caught" sub="Each edit was applied in memory to the recorded report and run through the same verifier. Recorded on 12 Nov against main 9fe5985." tags={<SrcTag tag="recorded" source="tee/attest.mjs verifyReport, review run 12 Nov" />} pad={false}>
        <table className="dt"><thead><tr><th>Edit</th><th>Check that catches it</th><th>Result</th></tr></thead>
          <tbody>{MUTATIONS.map(([m, c]) => <tr key={m}><td>{m}</td><td>{c}</td><td><span className="bad">fails closed</span></td></tr>)}</tbody></table>
      </Panel>
      <Note tone="info">Rerun all of it yourself: npm run verify:attestation (needs network for Intel collateral and NVIDIA). In-browser Intel quote checking needs a further library and is pending approval.</Note>
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F3 Attestation"]]} title="Attestation" lead="Why the key that signs verdicts can be trusted to live inside a genuine TEE, and how to check it." />
      <FeatureFrame
        what={`NEAR AI Cloud returns an attestation report for the model's signing key: an Intel TDX quote and NVIDIA GPU evidence bound to our nonce. The registrar checked it off chain and registered the signer ${short(String(STATUS.tee_signer), 6, 4)} with the report's hash.`}
        status={<><StatusChip kind="live" /><p className="dim mt">Report hash checked live; hardware checks recorded.</p></>}
        tryIt={tryIt}
        proves={["The report hashes to the value the registry stores, and its signing address is the registry's TEE signer (hash and address match, live).", "On the recorded run, the quote was genuine, TCB up to date, debug off, and the key and our nonce were bound in the quote.", "Edits to the report are caught."]}
        notProves={["That the model image is a specific pinned build: MRTD and RTMR0 to RTMR2 are not compared with pinned values (known limit).", "The NVIDIA token signature is not fully verified (known limit).", "The contract does not check the quote itself; the registrar does, off chain, and anyone can repeat it."]}
        run={["npm run verify:attestation"]}
        sources={["tee/attest.mjs", "tee/verify-attestation.mjs", "tee/fixtures/attestation-report-368aa2.json.b64", "tee/status.json"]}
      />
    </>
  );
}
