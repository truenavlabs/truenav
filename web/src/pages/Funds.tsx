import { useState } from "react";
import { fundSummaries } from "../../data/derive.mjs";
import { NavRangeChart } from "../shell/charts";
import { fundName, int, usd, usdM, when } from "../shell/fmt";
import { Band, DataTable, Note, PageHead, Panel, Q, SrcTag, type Col } from "../shell/kit";
import { useRegistry } from "../shell/store";
import type { FundSummary } from "../shell/types";
import { A } from "../ui";

export default function Funds() {
  const { view, tag, now } = useRegistry();
  const all = fundSummaries(view, now) as FundSummary[];
  const [band, setBand] = useState<string>("all");
  const [outside, setOutside] = useState(false);
  const rows = all.filter((f) => (band === "all" || f.band === band) && (!outside || f.headlinePosition !== "inside"));
  const cols: Col<FundSummary>[] = [
    { key: "fund", label: "Fund", get: (f) => <><A href={`/funds/${f.fund_id}`}><b>{fundName(f.fund_id)}</b></A><div className="dim mono" style={{ fontSize: 11 }}>{f.account_id}</div></>, sort: (f) => f.fund_id, csv: (f) => f.fund_id },
    { key: "score", label: "Score", get: (f) => <Band band={f.band} score={f.score} />, sort: (f) => f.score ?? -1, csv: (f) => f.score },
    { key: "tv", label: "TrueVal", align: "r", get: (f) => usd(f.trueVal), sort: (f) => f.trueVal ?? 0, csv: (f) => f.trueVal },
    { key: "range", label: "TrueRange", align: "r", get: (f) => (f.range ? `${usdM(f.range.low)} to ${usdM(f.range.high)}` : "n/a"), csv: (f) => (f.range ? `${f.range.low}..${f.range.high}` : "") },
    { key: "nav", label: "Reported NAV", align: "r", get: (f) => usd(f.headline), sort: (f) => f.headline ?? 0, csv: (f) => f.headline },
    { key: "check", label: "NAV check", get: (f) => (f.headlinePosition === "inside" ? <span className="tp g">inside</span> : <span className="tp r">{f.headlinePosition} range by {usd(Math.abs(f.gapCents ?? 0))}</span>), sort: (f) => f.gapCents ?? 0, csv: (f) => f.headlinePosition },
    { key: "loans", label: "Loans", align: "r", get: (f) => int(f.loans), sort: (f) => f.loans, csv: (f) => f.loans },
    { key: "verdicts", label: "Verdicts", get: (f) => `${f.verdicts.pass} pass / ${f.verdicts.flag} flag${f.verdicts.expired ? ` / ${f.verdicts.expired} expired` : ""}`, csv: (f) => `${f.verdicts.pass}/${f.verdicts.flag}` },
    { key: "blocked", label: "Refused pledges", align: "r", get: (f) => (f.attempts ? <span className="bad">{f.attempts}</span> : "0"), sort: (f) => f.attempts ?? 0, csv: (f) => f.attempts },
    { key: "cert", label: "Certificate", get: (f) => when(f.signedAt), sort: (f) => f.signedAt ?? 0, csv: (f) => (f.signedAt ? new Date(f.signedAt).toISOString() : "") },
    { key: "src", label: "Source", get: () => <SrcTag tag={tag} source="get_fund, get_latest_certificate, nft_tokens, get_attempts_page" /> },
  ];
  return (
    <>
      <PageHead title="Funds" lead="Every fund registered on the TrueNav testnet registry, with its latest signed certificate and what the chain says about its loans." crumbs={[["Overview", "/overview"], ["Funds"]]} />
      <Panel title="Reported NAV against TrueRange" tags={<SrcTag tag={tag} />}><NavRangeChart funds={all} /></Panel>
      <Panel className="mt" title="All funds" pad={false} tour="funds-table" right={
        <div className="hrow">
          <label className="f" style={{ display: "flex", gap: 6, alignItems: "center" }}><Q id="band">Band</Q>
            <select value={band} onChange={(e) => setBand(e.target.value)}><option value="all">all</option><option>green</option><option>yellow</option><option>red</option></select>
          </label>
          <label className="hrow" style={{ fontSize: 12 }}><input type="checkbox" checked={outside} onChange={(e) => setOutside(e.target.checked)} /> NAV outside range only</label>
        </div>
      }>
        <DataTable rows={rows} cols={cols} csvName="truenav-funds" rowKey={(f) => f.fund_id} onRow={(f) => `/funds/${f.fund_id}`} initial={{ key: "score", dir: -1 }}
          empty={<>No funds match. <button className="linkbtn" onClick={() => { setBand("all"); setOutside(false); }}>Clear filters</button></>} />
      </Panel>
      <Note tone="info">Only two fictional funds are registered on this testnet registry. More demo funds (not on chain) appear here when the demo dataset module is enabled, always marked Demo.</Note>
    </>
  );
}
