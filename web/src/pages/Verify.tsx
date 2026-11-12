import { useCallback, useEffect, useState } from "react";
import { runWebChecks, TAMPERS } from "../../data/verify.mjs";
import { chainReader } from "../../verifier/index.mjs";
import { loadVerifierEvidence } from "../shell/evidence";
import { clock } from "../shell/fmt";
import { ErrorBox, Note, PageHead, Panel, Skel } from "../shell/kit";
import { A } from "../ui";

type Check = { id: string; label: string; state: "live" | "recorded" | "unchecked" | "fail"; detail: string; source?: string; evidenceDate?: string; pendingLibrary?: boolean; webCrypto?: boolean };
type Run = { checks: Check[]; summary: { counts: Record<string, number>; pending: string[]; runnableGreen: boolean }; tamper: string; at: number; ms: number };
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
  return (
    <>
      <PageHead title="Verifier" lead="Every claim TrueNav makes about the live registry, checked in your browser against the chain and the committed evidence. Nothing is sent." right={<button className="xb" onClick={() => go(tamper)} disabled={busy}>{busy ? "Checking..." : "Run again"}</button>} />
      <Panel title="Tamper test" sub="Change one piece of the committed evidence in memory, then run every check again. The matching rows must turn red.">
        <div className="hrow" style={{ gap: 6, flexWrap: "wrap" }}>
          {Object.entries(TAMPERS).map(([k, text]) => <button key={k} className={`chipbtn${tamper === k ? " on" : ""}`} onClick={() => setTamper(k)} title={text as string}>{k === "none" ? "No tamper" : k === "signer" ? "Change the TEE signer" : k === "reply" ? "Edit a signed reply" : "Shift the verdict expiry"}</button>)}
        </div>
        <p className="dim mt">{TAMPERS[tamper as keyof typeof TAMPERS]}</p>
      </Panel>
      {err ? <ErrorBox error={err} retry={() => go(tamper)} /> : null}
      {!run ? <Skel rows={8} /> : (
        <>
          <div className="mt">
            {c.fail ? <Note tone="bad">{c.fail} check{c.fail === 1 ? "" : "s"} failed{tamper !== "none" ? ": the tamper was caught." : "."}</Note>
              : run.summary.runnableGreen ? <Note tone="ok">Every check this browser can run passed against the live registry. {run.summary.pending.length} need the signature library (pending approval) and show as not checked.</Note>
              : <Note tone="warn">No check failed, but some could not run. See the rows below.</Note>}
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
      <Note tone="info">Not checked here: signature recovery and the Intel quote need a library that is pending approval. Run the full set with npm run judge, or see <A href="/features/attestation">Attestation</A> and <A href="/features/tee-underwriting">TEE underwriting</A>.</Note>
    </>
  );
}
