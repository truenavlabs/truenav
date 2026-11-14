import { useCallback, useEffect, useState } from "react";
import { runWebChecks, TAMPERS } from "../../data/verify.mjs";
import { chainReader, deploymentStatus } from "../../verifier/index.mjs";
import { loadVerifierEvidence } from "../shell/evidence";
import { clock } from "../shell/fmt";
import { ErrorBox, Note, PageHead, Panel, Skel } from "../shell/kit";
import { ReceiptVerify } from "../shell/ReceiptVerify";
import { A } from "../ui";

type Check = { id: string; label: string; state: "live" | "recorded" | "unchecked" | "fail"; detail: string; source?: string; evidenceDate?: string; pendingLibrary?: boolean; webCrypto?: boolean };
type Run = { checks: Check[]; summary: { counts: Record<string, number>; pending: string[]; runnableGreen: boolean; certificateSignatures: string; chainLive: boolean }; tamper: string; at: number; ms: number };
const STATE_LABEL: Record<string, string> = { live: "Checked now", recorded: "Recorded", unchecked: "Not checked", fail: "Failed" };

export default function Verify({ q }: { q?: URLSearchParams }) {
  const [tamper, setTamper] = useState<string>(q?.get("tamper") && q.get("tamper")! in TAMPERS ? q.get("tamper")! : "none");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = useCallback(async (t: string) => {
    setBusy(true); setErr(null);
    const t0 = performance.now();
    try {
      const evidence = await loadVerifierEvidence();
      const r = await (runWebChecks as (p: object) => Promise<unknown>)({ evidence, chain: chainReader({}), now: Date.now(), tamper: t });
      setRun({ ...(r as unknown as Run), at: Date.now(), ms: Math.round(performance.now() - t0) });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void go(tamper); }, [go, tamper]);
  const c = run?.summary.counts ?? {};
  const dep = run ? (deploymentStatus as (checks: Check[]) => { line: string; pendingRedeploy: boolean })(run.checks) : null;
  return (
    <>
      <PageHead title="Verifier" lead="Every claim TrueNav makes about the live registry, checked in your browser against the chain and the committed evidence. Nothing is sent." right={<button className="xb" onClick={() => go(tamper)} disabled={busy}>{busy ? "Checking..." : "Run again"}</button>} />
      <ReceiptVerify initialQuery={q?.get("tx") || q?.get("receipt") || q?.get("run") || ""} />
      <Panel id="t-tamper" title="Tamper test" sub="Change one piece of the committed evidence in memory, then run every check again. The matching rows must turn red.">
        <div className="hrow" style={{ gap: 6, flexWrap: "wrap" }}>
          {Object.entries(TAMPERS).map(([k, text]) => <button key={k} className={`chipbtn${tamper === k ? " on" : ""}`} onClick={() => setTamper(k)} title={text as string}>{k === "none" ? "No tamper" : k === "signer" ? "Change the TEE signer" : k === "reply" ? "Edit a signed reply" : k === "cert" ? "Corrupt a certificate signature" : "Shift the verdict expiry"}</button>)}
        </div>
        <p className="dim mt">{TAMPERS[tamper as keyof typeof TAMPERS]}</p>
      </Panel>
      {err ? <ErrorBox error={err} retry={() => go(tamper)} /> : null}
      {!run ? <Skel rows={8} /> : (
        <>
          <div className="mt">
            {c.fail ? <Note tone="bad">{c.fail} check{c.fail === 1 ? "" : "s"} failed{tamper !== "none" ? ": the tamper was caught." : "."}{dep ? ` ${dep.line}` : ""}</Note>
              : run.summary.runnableGreen ? <Note tone="ok">Every check this browser can run passed against the live registry and the receipts contract, including signature recovery.{run.summary.pending.length ? ` ${run.summary.pending.length} could not run here.` : ""}{dep ? ` ${dep.line}` : ""}</Note>
              : run.summary.chainLive && run.summary.certificateSignatures !== "live" ? <Note tone="warn">No check failed, but the certificate signature check did not run, so this is not a pass. The certificate transactions could not be read just now. Run again, or see the last row.{dep ? ` ${dep.line}` : ""}</Note>
              : <Note tone="warn">No check failed, but some could not run. See the rows below.{dep ? ` ${dep.line}` : ""}</Note>}
          </div>
          <Panel className="mt" title={`${run.checks.length} checks`} sub={`Run at ${clock(run.at)} Bangkok in ${run.ms} ms. ${c.live ?? 0} checked now, ${c.recorded ?? 0} recorded, ${c.unchecked ?? 0} not checked, ${c.fail ?? 0} failed.`} pad={false}>
            {run.checks.map((x) => (
              <div className="checkrow" key={x.id} style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}>
                <span className={`st st-${x.state}`}>{STATE_LABEL[x.state]}</span>
                <div>
                  <div className="cl">{x.label}{x.webCrypto ? <span className="tp" style={{ marginLeft: 6 }}>WebCrypto</span> : null}</div>
                  <div className="cd">{x.detail}</div>
                  {x.source ? <div className="cd mono" style={{ fontSize: 11, color: "var(--dim)" }}>{x.source}</div> : null}
                </div>
              </div>
            ))}
          </Panel>
        </>
      )}
      <Note tone="info">Signatures are recovered in this browser with secp256k1, the same way the contract does. Not re-checked here: the Intel TDX quote and NVIDIA evidence (recorded; run npm run verify:attestation). See <A href="/features/attestation">Attestation</A> and <A href="/features/tee-underwriting">TEE underwriting</A>.</Note>
    </>
  );
}
