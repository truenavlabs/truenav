import { useState } from "react";
import { verdictState } from "../../data/derive.mjs";
import { assetLabel, countdown, fundName, when } from "../shell/fmt";
import { DataTable, Hash, PageHead, Panel, SrcTag, type Col } from "../shell/kit";
import { loanIdOf } from "../shell/engine";
import { useRegistry, type Registry } from "../shell/store";

type L = Registry["loans"][number];

export default function Loans({ q = "" }: { q?: string }) {
  const { view, tag, now } = useRegistry();
  const [fund, setFund] = useState("all");
  const [asset, setAsset] = useState("all");
  const [text, setText] = useState(q);
  const rows = view.loans.filter((l) => (fund === "all" || l.fund_id === fund) && (asset === "all" || l.asset_type === asset) && (!text || l.loan_hash.startsWith(text.toLowerCase()) || (loanIdOf(l.loan_hash) || "").toLowerCase().includes(text.toLowerCase())));
  const cols: Col<L>[] = [
    { key: "hash", label: "Loan hash", get: (l) => <Hash h={l.loan_hash} href={`/loans/${l.loan_hash}`} a={10} z={6} />, sort: (l) => l.loan_hash, csv: (l) => l.loan_hash },
    { key: "fund", label: "Holder fund", get: (l) => fundName(l.fund_id), sort: (l) => l.fund_id || "", csv: (l) => l.fund_id },
    { key: "asset", label: "Asset type", get: (l) => assetLabel(l.asset_type), sort: (l) => l.asset_type || "", csv: (l) => l.asset_type },
    { key: "pledged", label: "Pledged", get: (l) => when(l.issued_at_ms), sort: (l) => l.issued_at_ms || 0, csv: (l) => (l.issued_at_ms ? new Date(l.issued_at_ms).toISOString() : "") },
    { key: "verdict", label: "Verdict", get: (l) => (l.latest ? <span className={`tp ${l.latest.verdict === "pass" ? "g" : "r"}`}>{l.latest.verdict}</span> : <span className="tp">none</span>), sort: (l) => l.latest?.verdict || "", csv: (l) => l.latest?.verdict },
    { key: "valid", label: "Valid until", get: (l) => (l.latest ? <>{when(Number(l.latest.expires_at_ms))} <span className="dim">({verdictState(l.latest, now) === "current" ? countdown(Number(l.latest.expires_at_ms) - now) : "expired"})</span></> : "n/a"), sort: (l) => Number(l.latest?.expires_at_ms || 0), csv: (l) => l.latest?.expires_at_ms },
    { key: "flags", label: "Past flags", align: "r", get: (l) => String(l.flagCount ?? "n/a"), sort: (l) => l.flagCount || 0, csv: (l) => l.flagCount },
  ];
  return (
    <>
      <PageHead title="Loans" crumbs={[["Overview", "/overview"], ["Loans"]]} lead="Every pledge token on the registry. A loan appears by its hash only: the chain never stores the borrower, the amount or the document." chips={<SrcTag tag={tag} source="nft_tokens, get_lock, get_latest_verdict, get_flag_count" />} />
      <Panel title={`${rows.length} of ${view.loans.length} pledged loans`} pad={false} right={
        <div className="hrow">
          <input placeholder="hash prefix or loan id" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter by hash" />
          <select value={fund} onChange={(e) => setFund(e.target.value)} aria-label="Fund"><option value="all">all funds</option>{view.funds.map((f) => <option key={f.fund_id} value={f.fund_id}>{fundName(f.fund_id)}</option>)}</select>
          <select value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Asset type"><option value="all">all assets</option><option value="real_estate">Real estate</option><option value="invoices">Invoices</option></select>
        </div>
      }>
        <DataTable rows={rows} cols={cols} csvName="truenav-loans" rowKey={(l) => l.loan_hash} onRow={(l) => `/loans/${l.loan_hash}`} initial={{ key: "pledged", dir: 1 }}
          empty={<>No loans match. <button className="linkbtn" onClick={() => { setFund("all"); setAsset("all"); setText(""); }}>Clear filters</button></>} />
      </Panel>
    </>
  );
}
