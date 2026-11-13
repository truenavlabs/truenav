import { useEffect, useMemo, useState } from "react";
import { replyProblem } from "../../../../tee/reply.mjs";
import mainMetrics from "../../../../tee/eval/metrics.json";
import holdMetrics from "../../../../tee/eval/holdout/metrics.json";
import { VERDICTS, type VerdictRecord } from "../../shell/evidence";
import { fundName, short, whenFull } from "../../shell/fmt";
import { FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";
import { useRegistry } from "../../shell/store";
import { sha256Hex } from "../../lib/webhash";
import { recoverVerdict } from "../../../data/sigs.mjs";

const DOCS = import.meta.glob("../../../../tee/docs/**/*.txt", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
const docPath = (r: VerdictRecord) => `../../../../tee/docs/${r.tampered ? `tampered/${r.tampered.id}` : r.loan_id}.txt`;
const caseId = (r: VerdictRecord) => (r.tampered ? r.tampered.id : r.loan_id);
const replyOf = (body: string) => { try { return JSON.parse(JSON.parse(body).choices[0].message.content) as Record<string, unknown>; } catch { return null; } };

function useText(path: string | null) {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => { setT(null); if (path && DOCS[path]) void DOCS[path]().then(setT); }, [path]);
  return t;
}

function Metrics() {
  const sets = [["Main set", mainMetrics], ["Hold-out set", holdMetrics]] as const;
  return (
    <Panel className="mt" title="How good is it? The eval" sub="126 fictional documents, signed replies, temperature 0, no retries. A perfect score means no failure was found on this small synthetic set, not that it cannot fail." tags={<SrcTag tag="recorded" source="tee/eval/metrics.json, tee/eval/holdout/metrics.json, tee/eval/REPORT.md" />} pad={false}>
      <div className="tscroll"><table className="dt">
        <thead><tr><th>Set</th><th className="r">Cases</th><th className="r">Signatures verified</th><th className="r">Recall</th><th className="r">Precision</th><th className="r">False positive rate</th>{Object.keys(mainMetrics.raw.categories).map((k) => <th key={k} className="r">{k}</th>)}</tr></thead>
        <tbody>{sets.map(([name, m]) => (
          <tr key={name}><td>{name}</td><td className="r num">{m.cases}</td><td className="r num">{m.signatures_verified} of {m.cases}</td><td className="r num">{m.raw.recall_flag_pct}%</td><td className="r num">{m.raw.precision_flag_pct}%</td><td className="r num">{m.raw.false_positive_rate_pct}%</td>
            {Object.entries(m.raw.categories).map(([k, c]) => <td key={k} className="r num">{(c as { flagged: number }).flagged} of {(c as { cases: number }).cases}</td>)}</tr>
        ))}</tbody>
      </table></div>
      <p className="dim" style={{ padding: "8px 12px" }}>Cells per category: documents flagged of documents in the category. Honest documents should never be flagged; every other category should be.</p>
    </Panel>
  );
}

export default function TeeUnderwriting({ q }: { q?: URLSearchParams }) {
  const { view, tag } = useRegistry();
  const results = VERDICTS.results;
  const initial = Math.max(0, results.findIndex((r) => r.loan_hash === q?.get("loan") && !r.tampered));
  const [i, setI] = useState(q?.get("case") === "t1" ? results.findIndex((r) => r.tampered) : initial);
  const [flip, setFlip] = useState(false);
  const r = results[i];
  const doc = useText(docPath(r));
  const honest = useText(r.tampered ? `../../../../tee/docs/${r.loan_id}.txt` : null);
  const body = r.onchain?.response_body ?? "";
  const shown = useMemo(() => (flip && body ? body.replace('\\"verdict\\":\\"', '\\"verdict\\":\\"X') : body), [flip, body]);
  const reply = replyOf(shown);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => { setHash(null); void sha256Hex(shown).then(setHash); }, [shown]);
  const recorded = r.tries?.[r.tries.length - 1] as { response_sha256: string } | undefined;
  const chainLoan = view.loans.find((l) => l.loan_hash === r.loan_hash);
  const onChainHash = !r.tampered ? chainLoan?.latest?.response_sha256 : null;
  const problem = replyProblem(shown);
  const rec = useMemo(() => (r.onchain ? recoverVerdict(VERDICTS.model, { ...r.onchain, response_body: shown }) : { address: null, error: "no signed reply" }), [r, shown]);
  const liveSigner = (view.teeSigners as { address?: string }[] | undefined)?.[0]?.address ?? (view.teeSigners as unknown as string[] | undefined)?.[0];
  const docLines = (doc ?? "").split("\n");
  const honestLines = new Set((honest ?? "").split("\n"));

  const tryIt = (
    <>
      <div className="hrow" style={{ gap: 6, flexWrap: "wrap" }}>
        {results.map((x, k) => (
          <button key={k} className={`chipbtn${k === i ? " on" : ""}`} onClick={() => { setI(k); setFlip(false); }}>
            {caseId(x)}{x.tampered ? ` (${x.verdict.anomalies.join(", ")})` : ""}
          </button>
        ))}
      </div>
      <div className="twocol mt">
        <div>
          <h3>The document {r.tampered ? <span className="tp r">tampered copy of {r.loan_id}</span> : <span className="tp">honest</span>} <SrcTag tag="recorded" source={docPath(r).replace("../../../../", "")} /></h3>
          <p className="dim" style={{ fontSize: 12 }}>Fictional and watermarked. Only the enclave reads it; it never goes on chain.{r.tampered ? " Highlighted lines differ from the honest document." : ""}</p>
          <pre className="raw" style={{ maxHeight: 360 }}>{doc === null ? "loading..." : docLines.map((l, k) => <div key={k} style={r.tampered && honest !== null && !honestLines.has(l) ? { background: "var(--red-t)", color: "var(--red)" } : undefined}>{l || " "}</div>)}</pre>
        </div>
        <div>
          <h3>The signed reply <SrcTag tag="recorded" source="tee/fixtures/verdicts-368aa2.json" /></h3>
          <p className="dim" style={{ fontSize: 12 }}>Verdict only: check results, the verdict and anomaly codes, bound to this loan, this registry and an expiry. No document text.</p>
          <pre className="raw" style={{ maxHeight: 220 }}>{reply ? JSON.stringify(reply, null, 1) : "reply does not parse"}</pre>
          <div className={`note ${reply?.verdict === "pass" ? "n-ok" : "n-bad"}`}>Verdict <b>{String(reply?.verdict ?? "n/a")}</b>{Array.isArray(reply?.anomalies) && (reply!.anomalies as string[]).length ? `: ${(reply!.anomalies as string[]).join(", ")}` : ""}</div>
        </div>
      </div>
      <Panel className="mt" title="Check it in your browser" right={<button className={`xb sm ${flip ? "" : "ghost"}`} onClick={() => setFlip((f) => !f)}>{flip ? "Undo the flipped byte" : "Flip one byte of the reply"}</button>}>
        <div className="crow"><span className="cl">Reply follows the reply rule (allowed keys, consistent verdict)</span><span className="cd">{problem ? <span className="bad">{problem}</span> : <span className="ok">pass</span>} <SrcTag tag="computed" source="tee/reply.mjs replyProblem" /></span></div>
        <div className="crow"><span className="cl">sha256 of the reply equals the hash recorded when it was signed</span><span className="cd">{hash === null ? "hashing..." : hash === recorded?.response_sha256 ? <span className="ok">match {short(hash, 8, 6)}</span> : <span className="bad">differs: {short(hash, 8, 6)} vs {short(recorded?.response_sha256, 8, 6)}</span>} <SrcTag tag="computed" source="WebCrypto sha256" /></span></div>
        {!r.tampered ? <div className="crow"><span className="cl">and equals the response hash stored on chain</span><span className="cd">{!onChainHash ? "no verdict read" : hash === onChainHash ? <span className="ok">match</span> : <span className="bad">differs</span>} <SrcTag tag={tag} source="get_latest_verdict" /></span></div> : <div className="crow"><span className="cl">On chain</span><span className="cd dim">Tampered cases were signed by the enclave but not submitted; the registry holds the honest pass.</span></div>}
        <div className="crow"><span className="cl">Signer recovered now from the signature equals the TEE signer on chain ({short(liveSigner ?? VERDICTS.attestation.signers[0]?.signing_address, 6, 4)})</span><span className="cd">{rec.address && rec.address === String(liveSigner ?? "").toLowerCase() ? <span className="ok">pass: {short(rec.address, 6, 4)}</span> : <span className="bad">fail: recovers to {rec.address ? short(rec.address, 6, 4) : rec.error}</span>} <SrcTag tag="computed" source="secp256k1 recover over EIP-191(model:request_sha256:sha256(reply)), as lib.rs recover_address" /></span></div>
        {Object.entries(r.checks).filter(([k]) => k !== "recovered_equals_signing_address").map(([k, v]) => (
          <div className="crow" key={k}><span className="cl">{k.replace(/_/g, " ")}</span><span className="cd">{v ? <span className="ok">pass</span> : <span className="bad">fail</span>} <SrcTag tag="recorded" source="npm run verify (verifier checks, recorded)" /></span></div>
        ))}
        {flip ? <Note tone="bad">One byte changed in the reply. Its hash no longer matches and the signature now recovers to a different key, so the contract would refuse it.</Note> : null}
      </Panel>
      <Metrics />
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F1 TEE underwriting"]]} title="TEE underwriting" lead={`A model in an attested enclave reads each private loan document and signs a verdict-only reply. Pick any of the ${results.length} recorded cases.`} />
      <FeatureFrame
        what={`The enclave model (${VERDICTS.model}) compares each document with the fund's claim and returns pass or flag with anomaly codes, signed by its attested key. The registry stores a verdict only if the signature recovers to a registered TEE signer.`}
        status={<><StatusChip kind="recorded" /><p className="dim mt">Replies recorded {whenFull(VERDICTS.signed_at_ms)}. Hashes re-checked in your browser; on-chain hashes read live. {fundName(r.fund_id)} case shown.</p></>}
        tryIt={tryIt}
        proves={[
          "The 16 honest documents passed and the three tampered copies were flagged with the expected codes: altered amount, hidden prompt injection, re-used document.",
          "The reply holds no document text; it is the exact byte string whose hash is on chain.",
          "Changing one byte of a reply breaks its hash, so a forged or edited verdict cannot be stored.",
        ]}
        notProves={[
          "That the model's judgment is right in general. A TEE proves which code ran, not that the answer is correct.",
          "The eval set is small, synthetic and written by the same team.",
          "Which prompt the servicer sent: the signature covers the request hash, not the prompt text.",
        ]}
        run={["npm run demo", "npm run eval", "npm run check:fixtures"]}
        sources={["tee/underwrite.mjs", "tee/reply.mjs", "tee/fixtures/verdicts-368aa2.json", "tee/docs/", "tee/eval/REPORT.md"]}
      />
    </>
  );
}
