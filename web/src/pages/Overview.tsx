import { activity, assetSplit, fundSummaries, overviewKpis } from "../../data/derive.mjs";
import { tourStart } from "../shell/Tour";
import { ActivityChart, KIND_LABEL, NavRangeChart, ScoreBars, StackBars } from "../shell/charts";
import { fundName, int, usdM, when, whenFull } from "../shell/fmt";
import { Band, Kpi, Note, PageHead, Panel, SrcTag } from "../shell/kit";
import { SLOTS } from "../shell/slots";
import { useRegistry } from "../shell/store";
import type { FundSummary } from "../shell/types";
import { A } from "../ui";

export default function Overview() {
  const { view, tag, state, now } = useRegistry();
  const k = overviewKpis(view, now);
  const funds = fundSummaries(view, now) as FundSummary[];
  const ev = activity(view);
  const split = assetSplit(view);
  const loading = state === "loading";
  const Extra = SLOTS.OverviewExtra;
  const blocked = view.funds.flatMap((f) => (f.attempts?.attempts || []).map((a: { attempt_id: string; at_ms: number }) => ({ ...a, fund_id: f.fund_id })));
  return (
    <>
      <PageHead
        title="Private credit NAV, checked on NEAR"
        lead="TrueNav reads each fund's loans inside a sealed enclave, posts only a signed verdict on NEAR, and scores how far the reported NAV can be trusted. Every number below is read from the testnet registry in your browser, or recomputed from it."
        chips={<><SrcTag tag={tag} source={`registry.tnlab-368aa2.testnet via ${view.rpc || "public RPC"}`} at={loading ? "reading" : whenFull(view.readAt)} />{view.block ? <span className="tp mono">block #{int(view.block.height)}</span> : null}</>}
        right={<><A href={tourStart()} className="xb">Take the tour</A><A href="/features" className="xb ghost">Verify it yourself</A><A href="/features/engine" className="xb ghost">Recompute a score</A></>}
      />
      {state === "partial" ? <Note tone="warn">Some reads failed. Those values say "n/a" and the Verifier will not show green. See <A href="/status">Data status</A>.</Note> : null}
      <div className="kpirow">
        <Kpi label="Funds covered" value={int(k.funds)} tag={tag} source="get_fund for each known fund id" />
        <Kpi label="TrueVal covered" term="trueval" value={usdM(k.trueValCovered)} tag="computed" source="sum of true_val_cents over get_latest_certificate" />
        <Kpi label="Reported NAV covered" term="headline-nav" value={usdM(k.headlineCovered)} tag="computed" source="sum of headline_cents over get_latest_certificate" />
        <Kpi label="Pledged loans" term="pledge-token" value={int(k.pledged)} tag={tag} source="nft_total_supply()" />
        <Kpi label="Verdicts in force" term="verdict" value={`${k.verdictsPass} pass`} sub={`${k.verdictsFlag} flag, ${k.verdictsExpired} expired`} tag={tag} source="get_latest_verdict per loan; expiry vs now" tone="g" />
        <Kpi label="Double pledges refused" term="double-pledge" value={int(k.blocked)} tag={tag} source="get_attempts_page per fund" tone={k.blocked ? "r" : undefined} />
        <Kpi label="NAV outside TrueRange" term="truerange" value={`${k.outsideRange} of ${funds.length}`} tag="computed" source="headline_cents against true_val_cents plus or minus true_range_cents" tone={k.outsideRange ? "r" : "g"} />
        <Kpi label="TEE signers" term="tee" value={int(k.teeSigners)} tag={tag} source="get_tee_signers()" />
      </div>

      <div className="g21">
        <Panel id="t-nav" title="Reported NAV against TrueRange" sub="What the fund reports, against where its loans' value likely falls. A red diamond is outside the range." tags={<><SrcTag tag={tag} source="get_latest_certificate" /><SrcTag tag="computed" source="TrueVal plus or minus TrueRange" /></>}>
          <NavRangeChart funds={funds} />
        </Panel>
        <Panel title="What am I looking at?">
          <ul className="plain">
            <li><b>Two fictional funds</b> pledged 16 loans on NEAR testnet. Each pledge is a non-transferable token, so one loan can back one fund only.</li>
            <li><b>An AI model inside a TEE</b> read each loan document and signed a verdict. Only the verdict reached the chain.</li>
            <li><b>The score</b> checks the reported NAV against TrueRange. Meridian reports more than its loans support and tried to pledge a loan Harbor already holds. It scores red.</li>
          </ul>
          <div className="hrow mt"><A href="/funds/meridian-yield-fund" className="xb sm">Open Meridian</A><A href="/verify" className="xb sm ghost">Run the verifier</A></div>
        </Panel>
      </div>

      <div className="grid3">
        <Panel title="Score by fund" tags={<SrcTag tag={tag} source="get_latest_certificate" />}>
          <ScoreBars funds={funds} />
        </Panel>
        <Panel title="Loans by asset type" tags={<SrcTag tag={tag} source="nft_tokens metadata extra.asset_type" />}>
          <StackBars rows={Object.entries(split).map(([f, v]) => ({ label: fundName(f).replace(" Fund", ""), values: v as Record<string, number> }))} keys={["real_estate", "invoices"]} colors={["#4cc2ff", "#9b8cff"]} labels={{ real_estate: "Real estate", invoices: "Invoices" }} />
        </Panel>
        <Panel title="Alerts" sub="Refused double pledges, stored on the fund that tried." tags={<SrcTag tag={tag} source="get_attempts_page, get_alerts_page" />}>
          {blocked.length === 0 ? <p className="dim">No refused pledges.</p> : blocked.map((b) => (
            <div key={b.attempt_id} className="note n-bad">
              <span><b>{fundName(b.fund_id)}</b> tried to pledge a loan another fund already holds, {whenFull(b.at_ms)}. Refused and recorded on chain as {b.attempt_id}.</span>
              <A href="/features/double-pledge" className="xb sm ghost">See the refusal</A>
            </div>
          ))}
        </Panel>
      </div>

      <Panel className="mt" title="Activity on chain" sub="Every pledge, verdict, certificate and refusal the registry holds, by time stored." tags={<SrcTag tag={tag} source="nft_tokens issued_at, get_latest_verdict at_ms, stored_at_ms, get_attempts_page" />}>
        <ActivityChart events={ev} />
      </Panel>

      <div className="grid2">
        <Panel title="Funds" right={<A href="/funds" className="xb sm ghost">All funds</A>} pad={false}>
          <table className="dt">
            <thead><tr><th>Fund</th><th>Score</th><th className="r">TrueVal</th><th className="r">Reported NAV</th><th>NAV check</th></tr></thead>
            <tbody>{funds.map((f) => (
              <tr key={f.fund_id}><td><A href={`/funds/${f.fund_id}`}>{fundName(f.fund_id)}</A></td><td><Band band={f.band} score={f.score} /></td><td className="r num">{usdM(f.trueVal)}</td><td className="r num">{usdM(f.headline)}</td>
                <td>{f.headlinePosition === "inside" ? <span className="tp g">inside</span> : <span className="tp r">{f.headlinePosition} range</span>}</td></tr>
            ))}</tbody>
          </table>
        </Panel>
        <Panel title="Latest events" pad={false} tags={<SrcTag tag={tag} />}>
          <ul className="timeline">{ev.slice(0, 7).map((e, i) => (
            <li key={i}><span className="dim mono">{when(e.at)}</span><span className="tp">{KIND_LABEL[e.kind]}</span><span>{e.text}{e.fund_id ? `, ${fundName(e.fund_id)}` : ""}</span></li>
          ))}</ul>
        </Panel>
      </div>
      {Extra ? <div className="mt"><Extra /></div> : null}
    </>
  );
}
