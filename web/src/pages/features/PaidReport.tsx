import { useMemo, useState } from "react";
import { createSim, FEE_YOCTO } from "../../../data/api-sim.mjs";
import dash from "../../../data/recorded/judge-dashboard.json";
import { FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";

type Res = { status: number; body: unknown };
type Step = { call: string; res: Res };
const BUYER = "agent.demo.testnet";
type Sim = { score: (t: string) => Promise<Res>; report: (t: string, o: { entitlement?: string; buyer?: string }) => Promise<Res>; buy: (t: string, b: string) => Promise<{ request_id: string }>; spent: () => bigint };

export default function PaidReport() {
  const sim = useMemo(() => createSim() as unknown as Sim, []);
  const [log, setLog] = useState<Step[]>([]);
  const [ent, setEnt] = useState<string | null>(null);
  const push = (call: string, res: Res) => setLog((l) => [...l, { call, res }]);
  const steps: [string, () => Promise<void>][] = [
    ["GET /fund/HONEST-CREDIT/score", async () => push("GET /fund/HONEST-CREDIT/score", await sim.score("HONEST-CREDIT"))],
    ["GET /fund/HONEST-CREDIT/report (no entitlement)", async () => push("GET /fund/HONEST-CREDIT/report", await sim.report("HONEST-CREDIT", {}))],
    ["Buy a one-use entitlement (0.01 NEAR)", async () => { const e = await sim.buy("HONEST-CREDIT", BUYER); setEnt(e.request_id); push(`buy_query (attach ${FEE_YOCTO} yocto)`, { status: 200, body: e }); }],
    ["GET /fund/HONEST-CREDIT/report with the entitlement", async () => push(`GET /fund/HONEST-CREDIT/report  x-truenav-entitlement: ${ent ?? "none"}`, await sim.report("HONEST-CREDIT", { entitlement: ent ?? undefined, buyer: BUYER }))],
    ["Same call again", async () => push(`GET /fund/HONEST-CREDIT/report  x-truenav-entitlement: ${ent ?? "none"}`, await sim.report("HONEST-CREDIT", { entitlement: ent ?? undefined, buyer: BUYER }))],
    ["GET /fund/DEMO-CREDIT/report (failed run)", async () => push("GET /fund/DEMO-CREDIT/report", await sim.report("DEMO-CREDIT", { entitlement: ent ?? undefined, buyer: BUYER }))],
  ];
  const next = log.length < steps.length ? steps[log.length] : null;
  const tryIt = (
    <>
      <Note tone="demo">Simulation of the tested API in your browser. No NEAR moves and nothing is sent. Query is live on its pin; receipts is live v2, and v3 is pinned not deployed.</Note>
      <div className="hrow mt" style={{ gap: 8 }}>
        {next ? <button className="xb" data-tour="paid-step" onClick={() => void next[1]()}>Step {log.length + 1}: {next[0]}</button> : <span className="ok">All six steps done.</span>}
        <button className="xb ghost" onClick={() => location.reload()} disabled={!log.length}>Start over</button>
        <span className="dim">Simulated spend so far: {(Number(sim.spent()) / 1e24).toFixed(2)} NEAR</span>
      </div>
      <div className="stack mt" data-tour="paid-log">
        {log.map((s, i) => (
          <div key={i} className="panel" style={{ padding: 10 }}>
            <div className="hrow" style={{ gap: 8 }}><span className={`http ${s.res.status < 300 ? "h2xx" : ""}`} style={{ fontWeight: 700, color: s.res.status < 300 ? "var(--green)" : s.res.status === 402 ? "var(--yellow)" : "var(--red)" }}>{s.res.status}</span><code>{s.call}</code></div>
            <pre className="raw" style={{ marginTop: 6 }}>{JSON.stringify(s.res.body, null, 1)}</pre>
          </div>
        ))}
      </div>
      <Panel className="mt" title="The same rules, run by the judge" tags={<SrcTag tag="recorded" source={`out/judge-dashboard.json, commit ${dash.commit.slice(0, 7)}`} />}>
        <ul className="plain">
          <li>S6 paid report: /score free {dash.paid_report.score_free ? "yes" : "no"}; no entitlement {dash.paid_report.missing_entitlement}; uses per entitlement {dash.paid_report.entitlement_uses}.</li>
          {dash.tokens.map((t) => <li key={t.token}>S5 {t.token}: head {t.head}, /score {t.api.score}, /report {t.api.report} {t.api.error}; agent bought {String(t.agent.bought)}, spent {t.agent.spent_yocto} yocto.</li>)}
        </ul>
      </Panel>
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F8 Paid report API"]]} title="Paid report API" lead="An agent can read a fund's score for free and buy a one-use report for 0.01 testnet NEAR. A purchase never changes the score." />
      <FeatureFrame
        what="The API serves the free score from the receipts contract and the paid report only against a one-use entitlement bought on the query contract. Without one it answers 402 with exactly what to buy. A failed run is refused before anything is spent."
        status={<><StatusChip kind="built" /><p className="dim mt">Query is live on its pin. Receipts is live v2; v3 is pinned, not deployed. This page simulates the tested rules.</p></>}
        tryIt={tryIt}
        proves={["The status codes and messages the tested server returns, in order.", "One entitlement works once; the second use is refused.", "A failed run answers 409 run_failed and spends nothing."]}
        notProves={["That this page sends a real payment. It is a browser simulation.", "Anything about the score. The paid report carries the same public score."]}
        run={["node --test api/test/api.test.mjs api/test/failed-head.test.mjs", "npm run judge -- --replay"]}
        sources={["api/server.mjs", "api/test/api.test.mjs", "web/data/api-sim.mjs"]}
      />
    </>
  );
}
