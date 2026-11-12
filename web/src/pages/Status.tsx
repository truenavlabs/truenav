import replay from "../../data/recorded/judge-replay.json";
import counts from "../../data/recorded/test-counts.json";
import recordedRegistry from "../../data/recorded/registry-368aa2.json";
import { STATUS, VERDICTS } from "../shell/evidence";
import { Ext, PageHead, Panel, SrcTag } from "../shell/kit";
import { when } from "../shell/fmt";
import { useRegistry } from "../shell/store";

type Row = { name: string; tag: "live" | "recorded" | "external" | "demo"; what: string; at: string; href?: string };

export default function Status() {
  const { reg, state, tag, refresh, loading } = useRegistry();
  const r = reg as unknown as { rpc?: string; readAt?: string; block?: { height: number } | null; errors?: unknown[]; attempted?: number; durationMs?: number } | null;
  const rec = recordedRegistry as unknown as { readAt: string; block?: { height: number } };
  const rows: Row[] = [
    { name: "NEAR testnet RPC", tag: "live", what: "Registry views: funds, loans, verdicts, certificates, roles. FastNEAR first, then two public backups.", at: r?.readAt ? `${when(r.readAt)}, block ${r.block?.height.toLocaleString("en-US") ?? "n/a"}${r.rpc ? `, via ${new URL(r.rpc).host}` : ""}` : "not read yet", href: "https://test.rpc.fastnear.com" },
    { name: "Recorded registry read", tag: "recorded", what: "Shown when the live read fails. Labeled Recorded wherever it is used.", at: `${when(rec.readAt)}${rec.block ? `, block ${rec.block.height.toLocaleString("en-US")}` : ""}` },
    { name: "Enclave replies and signatures", tag: "recorded", what: "16 honest replies and 3 tampered cases, re-checked against the chain in your browser.", at: when(VERDICTS.signed_at_ms) },
    { name: "Attestation report", tag: "recorded", what: "The published report; its hash is checked live against the chain.", at: `hash ${String(STATUS.report_sha256).slice(0, 12)}, see F3` },
    { name: "Judge replay", tag: "recorded", what: `${(replay as { stages: unknown[] }).stages.length} stages, offline.`, at: when((replay as unknown as { ephemeral: { generated_at: string } }).ephemeral.generated_at) },
    { name: "Test counts", tag: "recorded", what: `${counts.tests} tests on commit ${counts.commit}.`, at: when(counts.measured_at) },
    { name: "Market data", tag: "external", what: "Context only, never a score input: CoinGecko and DefiLlama prices, NY Fed SOFR and EFFR, US Treasury rates, Frankfurter FX, NearBlocks stats. A dated snapshot is used when a provider does not answer.", at: "see the ticker chips" },
    { name: "Demo funds and depth data", tag: "demo", what: "Exposure, cash flows, stress and data room views use fictional data from a committed generator, labeled Demo data.", at: "committed" },
  ];
  return (
    <>
      <PageHead title="Data status" lead="Every source this site reads, how it is labeled and when it was last read. Times are Bangkok time." right={<button className="xb" onClick={refresh} disabled={loading}>{loading ? "Reading" : "Read the chain again"}</button>} />
      <div className="kpirow">
        <div className="kpi"><div className="kl">Registry read</div><div className={`kval ${state === "live" ? "ok" : ""}`} style={{ fontSize: 20 }}>{state}</div><div className="ks">showing {tag} data</div></div>
        <div className="kpi"><div className="kl">View calls</div><div className="kval" style={{ fontSize: 20 }}>{r?.attempted ?? "n/a"}</div><div className="ks">{r?.errors?.length ?? 0} failed</div></div>
        <div className="kpi"><div className="kl">Read took</div><div className="kval" style={{ fontSize: 20 }}>{r?.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)} s` : "n/a"}</div><div className="ks">registry.tnlab-368aa2.testnet</div></div>
      </div>
      <Panel className="mt" title="Sources" pad={false}>
        <div className="tscroll">
          <table className="dt"><thead><tr><th>Source</th><th>Label</th><th>What it feeds</th><th>Last read</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.name}><td>{x.href ? <Ext href={x.href}>{x.name}</Ext> : x.name}</td><td><SrcTag tag={x.tag} /></td><td style={{ whiteSpace: "normal" }}>{x.what}</td><td>{x.at}</td></tr>
            ))}</tbody></table>
        </div>
      </Panel>
    </>
  );
}
