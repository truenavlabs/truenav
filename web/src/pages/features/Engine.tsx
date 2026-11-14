import { useMemo, useState } from "react";
import { isWhatIf, runWhatIf, T1_PRESET } from "../../../data/whatif.mjs";
import { teeStoreFrom } from "../../../data/recompute.mjs";
import { FIXTURES, LOAN_MAP } from "../../shell/engine";
import { assetLabel, fundName, usdM, usdWhole } from "../../shell/fmt";
import { Band, FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";
import { useRegistry } from "../../shell/store";

type Fx = typeof FIXTURES;
type TeeEdit = { verdict: "pass" | "flag"; anomalies: string[] };
const BUCKETS = ["current", "dpd_1_30", "dpd_31_60", "dpd_61_90", "dpd_over_90"] as const;
const BUCKET_LABEL: Record<string, string> = { current: "Current", dpd_1_30: "1 to 30 days late", dpd_31_60: "31 to 60 days late", dpd_61_90: "61 to 90 days late", dpd_over_90: "Over 90 days late" };
const clone = (x: Fx): Fx => JSON.parse(JSON.stringify(x));
const pctIn = (v: number) => Math.round(v * 10000) / 100;

function Ctl({ label, hint, changed, children }: { label: string; hint: string; changed?: boolean; children: React.ReactNode }) {
  return <label className={`ctl${changed ? " changed" : ""}`}><span>{label}</span>{children}<small>{hint}</small></label>;
}
function Num({ value, onChange, step = 0.1, min = 0, max }: { value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  return <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onChange(n); }} />;
}
function Bar({ label, v, max, neg }: { label: string; v: number; max: number; neg?: boolean }) {
  return <div className={`pill-bar${neg ? " neg" : ""}`}><span>{label}</span><span className="tr"><i style={{ width: `${Math.min(100, (Math.abs(v) / max) * 100)}%` }} /></span><span className="num" style={{ textAlign: "right" }}>{neg && v > 0.005 ? "-" : ""}{Math.abs(v).toFixed(2)}</span></div>;
}

export default function Engine({ q }: { q?: URLSearchParams }) {
  const { view, tag } = useRegistry();
  const certified = FIXTURES;
  const [fx, setFx] = useState<Fx>(() => clone(certified));
  const [tee, setTee] = useState<Record<string, TeeEdit>>((): Record<string, TeeEdit> => (q?.get("preset") === "t1" ? { [T1_PRESET.loanId]: { verdict: "flag", anomalies: [...T1_PRESET.anomalies] } } : {}));
  const live = useMemo(() => teeStoreFrom(view) as Record<string, { latest?: { verdict: string } | null }>, [view]);
  const base = useMemo(() => runWhatIf({ fixtures: certified, loanMap: LOAN_MAP, teeStore: live, teeEdits: {} }), [certified, live]);
  const res = useMemo(() => runWhatIf({ fixtures: fx, loanMap: LOAN_MAP, teeStore: live, teeEdits: tee }), [fx, live, tee]);
  const whatIf = isWhatIf(certified, fx, tee);
  const edit = (f: (d: Fx) => void) => setFx((p) => { const d = clone(p); f(d); return d; });
  const reset = () => { setFx(clone(certified)); setTee({}); };
  const applyT1 = () => { setFx(clone(certified)); setTee({ [T1_PRESET.loanId]: { verdict: "flag", anomalies: [...T1_PRESET.anomalies] } }); };
  const liveVerdict = (loanId: string) => { const h = LOAN_MAP.find((m) => m.loan_id === loanId)?.loan_hash; return h ? live[h]?.latest?.verdict ?? "none" : "none"; };

  const tryIt = (
    <>
      <div className="hrow" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="xb" data-tour="apply-t1" onClick={applyT1}>Apply the T1 flag</button>
        <button className="xb ghost" onClick={reset} disabled={!whatIf}>Reset to certified inputs</button>
        {whatIf ? <span className="status" style={{ background: "var(--yellow-t)", color: "var(--yellow)" }}>What-if, not certified</span> : <span className="status s-live">Certified inputs</span>}
      </div>
      <p className="dim mt">Apply the T1 flag sets the latest enclave verdict of Harbor loan H-RE-01 to flag, amount_mismatch: the verdict the enclave actually returned for the altered document (T1 in tee/fixtures/verdicts-368aa2.json). Nothing is sent to the chain.</p>
      <div className="grid2">
        {res.map((r) => {
          const b = base.find((x) => x.fundId === r.fundId)!;
          const cert = view.funds.find((f) => f.fund_id === r.fundId)?.certificate?.certificate;
          const p = r.pillars || { gap: 0, coverage: 0, freshness: 0, penalty: 0 };
          return (
            <Panel key={r.fundId} title={fundName(r.fundId)} className={whatIf ? "wi" : undefined} tags={<SrcTag tag="computed" source="engine/src/score.mjs scorePortfolio" />} right={<Band band={r.band} score={r.score} />}>
              <div className="kpirow" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
                <div className="kpi"><div className="kl">Raw score</div><div className="kval">{(r.rawX100 / 100).toFixed(2)}</div>{r.rawX100 !== b.rawX100 ? <div className="ks">certified {(b.rawX100 / 100).toFixed(2)}</div> : null}</div>
                <div className="kpi"><div className="kl">TrueVal</div><div className="kval">{usdWhole(r.trueVal)}</div></div>
                <div className="kpi"><div className="kl">TrueRange</div><div className="kval kval-wrap" title={`${usdWhole(r.trueRangeLow)} to ${usdWhole(r.trueRangeHigh)}`}>{usdM(r.trueRangeLow * 100)} to<br />{usdM(r.trueRangeHigh * 100)}</div></div>
                <div className="kpi"><div className="kl">Reported NAV</div><div className="kval">{usdWhole(r.headline)}</div></div>
              </div>
              <div className="mt">
                <Bar label="Gap" v={p.gap} max={40} />
                <Bar label="Coverage" v={p.coverage} max={40} />
                <Bar label="Freshness" v={p.freshness} max={20} />
                <Bar label="Penalty" v={p.penalty} max={40} neg />
              </div>
              <p className="dim" style={{ fontSize: 12 }}>Score = gap (up to 40) + coverage (up to 40) + freshness (up to 20) minus penalties, rounded half up. {r.unverified?.ids?.length ? `Left out of TrueVal: ${r.unverified.reasons.map((u: { id: string; reason: string }) => `${u.id} (${u.reason})`).join(", ")}.` : "Every loan counted."}</p>
              {!whatIf && cert ? (
                <Note tone={r.rawX100 === cert.raw_x100 && r.score === cert.score ? "ok" : "bad"}>
                  {r.rawX100 === cert.raw_x100 && r.score === cert.score ? "Matches the signed certificate on chain: raw, score and band." : "Differs from the signed certificate on chain."} <SrcTag tag={tag} source="get_latest_certificate" />
                </Note>
              ) : null}
              {whatIf ? <Note tone="warn">What-if result, not certified. The certificate on chain still says {(b.rawX100 / 100).toFixed(2)}.</Note> : null}
            </Panel>
          );
        })}
      </div>

      <Panel className="mt" title="Model tables" sub="Shared by every fund. Changing one turns the result into a what-if.">
        <div className="ctlgrid">
          {BUCKETS.map((k) => (
            <Ctl key={k} label={`PD, ${BUCKET_LABEL[k]} (%)`} hint="Chance a loan in this bucket defaults. Demo table, not calibrated." changed={fx.pd[k] !== certified.pd[k]}>
              <Num value={pctIn(fx.pd[k])} max={100} onChange={(n) => edit((d) => { d.pd[k] = Math.min(1, n / 100); })} />
            </Ctl>
          ))}
          {Object.keys(certified.lgd).map((k) => (
            <Ctl key={k} label={`LGD, ${assetLabel(k)} (%)`} hint={k === "real_estate" ? "Share lost if it defaults. First-lien real estate." : "Share lost if it defaults. Invoices are treated as unsecured."} changed={fx.lgd[k] !== certified.lgd[k]}>
              <Num value={pctIn(fx.lgd[k])} max={100} onChange={(n) => edit((d) => { d.lgd[k] = Math.min(1, n / 100); })} />
            </Ctl>
          ))}
          <Ctl label="z (TrueRange width)" hint="1.96, so TrueRange is about a 95% band. An engine constant, not an input; shown for reference.">
            <input value="1.96" disabled />
          </Ctl>
        </div>
      </Panel>

      <div className="grid2">
        {fx.funds.map((f, fi) => {
          const c = certified.funds[fi];
          return (
            <Panel key={f.fund_id} title={`${f.name}: fund inputs`}>
              <div className="ctlgrid">
                <Ctl label="Reported NAV ($)" hint="The NAV the fund publishes. The score measures how far the loans support it." changed={f.headline_nav !== c.headline_nav}>
                  <Num value={f.headline_nav} step={50000} onChange={(n) => edit((d) => { d.funds[fi].headline_nav = n; })} />
                </Ctl>
                {BUCKETS.filter((k) => k !== "current").map((k) => (
                  <Ctl key={k} label={`Policy markdown, ${BUCKET_LABEL[k]} (%)`} hint="The fund's own write-down for this bucket; it sets policy NAV." changed={(f.policy_markdown[k] ?? 0) !== (c.policy_markdown[k] ?? 0)}>
                    <Num value={pctIn(f.policy_markdown[k] ?? 0)} max={100} onChange={(n) => edit((d) => { d.funds[fi].policy_markdown[k] = Math.min(1, n / 100); })} />
                  </Ctl>
                ))}
                {f.blocked_attempts.map((a, ai) => (
                  <Ctl key={a.action_id} label={`Refused double pledge, age (days)`} hint="Each refused pledge costs up to 15 points, halving every 30 days. Older costs less." changed={a.age_days !== c.blocked_attempts[ai]?.age_days}>
                    <Num value={a.age_days} step={1} onChange={(n) => edit((d) => { d.funds[fi].blocked_attempts[ai].age_days = n; })} />
                  </Ctl>
                ))}
                {f.blocked_attempts.length === 0 ? <div className="ctl"><span>Refused double pledges</span><small>None on record for this fund.</small></div> : null}
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel className="mt" title="Per loan inputs" sub="Bucket and anomaly flag come from the servicer's tape. The enclave verdict comes from the chain." pad={false}
        tags={<><SrcTag tag="recorded" source="spec/nav/fixtures.json" /><SrcTag tag={tag} source="get_latest_verdict" /></>}>
        <div className="tscroll">
          <table className="dt">
            <thead><tr><th>Fund</th><th>Loan</th><th>Asset</th><th className="r">Principal</th><th>Bucket</th><th>Servicer anomaly flag</th><th>Enclave verdict</th></tr></thead>
            <tbody>
              {fx.funds.flatMap((f, fi) => f.loans.map((l, li) => {
                const c = certified.funds[fi].loans[li];
                const t = tee[l.id];
                const v = t ? t.verdict : liveVerdict(l.id);
                return (
                  <tr key={l.id}>
                    <td>{f.name}</td><td className="mono">{l.id}</td><td>{assetLabel(l.asset)}</td><td className="r num">{usdWhole(l.principal)}</td>
                    <td><select value={l.bucket} style={l.bucket !== c.bucket ? { borderColor: "var(--yellow)" } : undefined} onChange={(e) => edit((d) => { d.funds[fi].loans[li].bucket = e.target.value; })}>{BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}</select></td>
                    <td><input type="checkbox" checked={l.anomaly} onChange={(e) => edit((d) => { d.funds[fi].loans[li].anomaly = e.target.checked; })} /> {l.anomaly !== c.anomaly ? <span className="tp y">changed</span> : null}</td>
                    <td>
                      <select value={v === "flag" ? "flag" : v === "pass" ? "pass" : "none"} style={t ? { borderColor: "var(--yellow)" } : undefined} disabled={v === "none"}
                        onChange={(e) => setTee((p) => { const n = { ...p }; const live0 = liveVerdict(l.id); if (e.target.value === live0) delete n[l.id]; else n[l.id] = { verdict: e.target.value as "pass" | "flag", anomalies: ["amount_mismatch"] }; return n; })}>
                        <option value="pass">pass</option><option value="flag">flag (amount_mismatch)</option>{v === "none" ? <option value="none">no verdict</option> : null}
                      </select>
                    </td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );

  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F5 Scoring engine"]]} title="Scoring engine" lead="Recompute both funds' scores in your browser with the public engine, check them against the signed certificates, then change any input and watch the score move." />
      <FeatureFrame
        what="The engine turns the servicer's loan tape and the enclave verdicts into TrueVal, TrueRange and a 0 to 100 score. It is public and deterministic, so the same inputs always give the same numbers."
        status={<><StatusChip kind="live" /><p className="dim mt">Computed in your browser from the committed engine input and the live verdicts.</p></>}
        tryIt={tryIt}
        proves={[
          "The signed certificates on chain are exactly what the public engine gives on the committed inputs plus the live verdicts.",
          "One enclave flag on one Harbor loan (H-RE-01) removes it from TrueVal and drops Harbor from green to red.",
          "Every input's effect is visible: nothing in the score is hand-set.",
        ]}
        notProves={[
          "That the servicer's tape is true. The engine scores what it is given; the enclave checks the documents separately.",
          "That the PD and LGD tables are right. They are demo tables, not calibrated.",
          "That TrueVal is a fair value. It is a model estimate after expected losses.",
        ]}
        run={["npm run chain:read", "node spec/nav/check.mjs", "npm run demo"]}
        sources={["engine/src/score.mjs", "spec/nav/fixtures.json", "spec/nav/NAV_SPEC.md", "certify/chain-read.mjs", "web/data/whatif.mjs"]}
      />
    </>
  );
}
