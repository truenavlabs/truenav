import { fundSummary, verdictState } from "../../data/derive.mjs";
import { NavRangeChart } from "../shell/charts";
import { useRecompute } from "../shell/engine";
import { accountUrl, assetLabel, countdown, fundName, int, short, usd, usdM, when, whenFull } from "../shell/fmt";
import { Band, DataTable, Ext, Hash, Kpi, Note, PageHead, Panel, Q, SrcTag, Tabs, type Col } from "../shell/kit";
import { SLOTS } from "../shell/slots";
import { useRegistry, type Registry } from "../shell/store";
import { A, navigate } from "../ui";

type L = Registry["loans"][number];

export default function Fund({ fundId, tab: initialTab }: { fundId: string; tab?: string }) {
  const { view, tag, now } = useRegistry();
  const f = fundSummary(view, fundId, now);
  const rc = useRecompute(view).find((x) => x.r.fundId === fundId);
  const tab = initialTab || "overview";
  // The tab lives in the URL (other parameters are kept), so a link, the back button and the tour can all set it.
  const setTab = (t: string) => { const u = new URL(window.location.href); u.searchParams.set("tab", t); navigate(u.pathname + u.search); };
  if (!f || (!f.registered && tag === "live")) {
    return (
      <>
        <PageHead title="Fund not found" crumbs={[["Funds", "/funds"], [fundId]]} lead={`No fund with id "${fundId}" is registered on registry.tnlab-368aa2.testnet.`} />
        <A href="/funds" className="xb">All funds</A>
      </>
    );
  }
  const loans = view.loans.filter((l) => l.fund_id === fundId);
  const row = view.funds.find((x) => x.fund_id === fundId)!;
  const tabs = [
    { id: "overview", label: "Overview" }, { id: "loans", label: `Loan book (${loans.length})` }, { id: "pledges", label: `Pledges and alerts${f.attempts ? ` (${f.attempts})` : ""}` },
    { id: "verdicts", label: "Verdicts" }, { id: "certificates", label: "Certificates" }, ...SLOTS.fundTabs.map((t) => ({ id: t.id, label: t.label })),
  ];
  const Slot = SLOTS.fundTabs.find((t) => t.id === tab)?.Component;
  const ReportButton = SLOTS.ReportButton;
  const loanCols: Col<L>[] = [
    { key: "hash", label: "Loan hash", get: (l) => <Hash h={l.loan_hash} href={`/loans/${l.loan_hash}`} a={10} z={6} />, csv: (l) => l.loan_hash, sort: (l) => l.loan_hash },
    { key: "asset", label: "Asset type", get: (l) => assetLabel(l.asset_type), sort: (l) => l.asset_type || "", csv: (l) => l.asset_type },
    { key: "pledged", label: "Pledged", get: (l) => when(l.issued_at_ms), sort: (l) => l.issued_at_ms || 0, csv: (l) => l.issued_at_ms },
    { key: "verdict", label: "Enclave verdict", get: (l) => (l.latest ? <span className={`tp ${l.latest.verdict === "pass" ? "g" : "r"}`}>{l.latest.verdict}</span> : "none"), csv: (l) => l.latest?.verdict },
    { key: "anom", label: "Anomaly codes", get: (l) => (l.latest?.anomalies?.length ? l.latest.anomalies.join(", ") : <span className="dim">none</span>), csv: (l) => (l.latest?.anomalies || []).join(" ") },
    { key: "valid", label: "Valid until", get: (l) => (l.latest ? `${when(Number(l.latest.expires_at_ms))} (${verdictState(l.latest, now) === "current" ? countdown(Number(l.latest.expires_at_ms) - now) : "expired"})` : "n/a"), csv: (l) => l.latest?.expires_at_ms },
    { key: "flags", label: "Past flags", align: "r", get: (l) => String(l.flagCount ?? 0), csv: (l) => l.flagCount },
  ];
  return (
    <>
      <PageHead
        crumbs={[["Funds", "/funds"], [fundName(fundId)]]}
        title={<span className="hrow">{fundName(fundId)} <Band band={f.band} score={f.score} /></span>}
        chips={<><span className="tp mono">{fundId}</span>{f.account_id ? <Ext href={accountUrl(f.account_id)}>{f.account_id}</Ext> : null}<span className="tp">manager {f.manager_id}</span><SrcTag tag={tag} source={`get_fund({"fund_id":"${fundId}"})`} /></>}
        right={<><A href={`/verify?fund=${fundId}`} className="xb ghost">Verify this fund</A><A href="/features/engine" className="xb ghost">Recompute</A>{ReportButton ? <ReportButton fundId={fundId} /> : null}</>}
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === "overview" ? (
        <>
          <div className="kpirow">
            <Kpi label="TrueNav score" term="score" value={<>{f.score ?? "n/a"} <small style={{ fontSize: 12 }}>{f.band}</small></>} tag={tag} source="get_latest_certificate" tone={f.band === "green" ? "g" : f.band === "yellow" ? "y" : "r"} />
            <Kpi label="Reported NAV" term="headline-nav" value={usdM(f.headline)} tag={tag} source="certificate headline_cents" tone={f.headlinePosition !== "inside" ? "r" : undefined} />
            <Kpi label="Policy NAV" term="policy-nav" value={usdM(f.policy)} tag={tag} source="certificate policy_nav_cents" />
            <Kpi label="TrueVal" term="trueval" value={usdM(f.trueVal)} tag={tag} source="certificate true_val_cents" />
            <Kpi label="TrueRange" term="truerange" wrap value={f.range ? <>{usdM(f.range.low)} to<br />{usdM(f.range.high)}</> : "n/a"} tag="computed" source="true_val_cents plus or minus true_range_cents" />
            <Kpi label="Refused pledges" term="blocked-attempt" value={int(f.attempts)} tag={tag} source="get_attempts_page" tone={f.attempts ? "r" : undefined} />
          </div>
          <div className="g21">
            <Panel title="Reported NAV against TrueRange" tags={<SrcTag tag={tag} />}>
              <NavRangeChart funds={[f]} height={80} />
              <p className="mt">
                {f.headlinePosition === "inside"
                  ? <>The reported NAV of <b>{usd(f.headline)}</b> sits inside TrueRange. The loans support it.</>
                  : <>The reported NAV of <b>{usd(f.headline)}</b> is <b className="bad">{usd(Math.abs(f.gapCents ?? 0))} {f.headlinePosition}</b> TrueRange ({usd(f.range?.low)} to {usd(f.range?.high)}). The loans, after expected losses, do not support it.</>}
              </p>
            </Panel>
            <Panel title="Why this score" sub="From the public engine, recomputed in your browser just now." tags={<SrcTag tag="computed" source="engine/src/score.mjs on spec/nav/fixtures.json + live verdicts" />}>
              {rc ? <ul className="plain">{rc.why.map((w, i) => <li key={i}><span className="tp">{w.kind}</span> {w.text}</li>)}</ul> : <p className="dim">No engine result.</p>}
            </Panel>
          </div>
          <Panel id="t-recompute" className="mt" title="Recompute check" sub="Your browser ran the scoring engine on the same inputs and compared every number with the signed certificate on chain." tags={<><SrcTag tag="computed" /><SrcTag tag={tag} source="get_latest_certificate" /></>}
            right={rc ? (rc.cmp.match ? <span className="status s-live">Matches the certificate</span> : <span className="status" style={{ background: "var(--red-t)", color: "var(--red)" }}>Does not match</span>) : null} pad={false}>
            {rc ? (
              <table className="dt">
                <thead><tr><th>Field</th><th className="r">Recomputed in your browser</th><th className="r">Signed certificate on chain</th><th>Result</th></tr></thead>
                <tbody>{rc.cmp.rows.map((x) => (
                  <tr key={x.k}><td>{x.k}</td><td className="r num">{String(x.mine)}</td><td className="r num">{String(x.chain)}</td><td>{x.ok ? <span className="ok">match</span> : <span className="bad">differs</span>}</td></tr>
                ))}</tbody>
              </table>
            ) : null}
          </Panel>
          <div className="grid2">
            <Panel title="Certificate" tags={<SrcTag tag={tag} source="get_latest_certificate" />}>
              <table className="kvt"><tbody>
                <tr><th>Signed</th><td>{whenFull(f.signedAt)}</td></tr>
                <tr><th>Data as of</th><td>{whenFull(f.dataAsOf)}</td></tr>
                <tr><th>Signer</th><td>{short(f.certSigner, 8, 6)} (test key, not TEE)</td></tr>
                <tr><th>Engine commit</th><td>{f.engineCommit}</td></tr>
                <tr><th>Certificates stored</th><td>{f.certCount}</td></tr>
              </tbody></table>
            </Panel>
            <Panel title="Loans at a glance" tags={<SrcTag tag={tag} source="nft_tokens, get_latest_verdict" />}>
              <table className="kvt"><tbody>
                <tr><th>Pledged loans</th><td>{f.loans}</td></tr>
                {Object.entries(f.byAsset).map(([k, v]) => <tr key={k}><th>{assetLabel(k)}</th><td>{String(v)}</td></tr>)}
                <tr><th>Verdicts</th><td>{f.verdicts.pass} pass, {f.verdicts.flag} flag, {f.verdicts.expired} expired</td></tr>
                <tr><th>Verdicts valid until</th><td>{whenFull(f.verdictsValidUntil)}</td></tr>
              </tbody></table>
            </Panel>
          </div>
        </>
      ) : null}

      {tab === "loans" ? (
        <>
          <Note tone="info">Public view: exactly what the chain shows. Loans appear by hash, asset type, pledge time and verdict. Principal, borrower and documents never reach the chain.</Note>
          <Panel className="mt" title="Pledged loans" pad={false} tour="loan-book" tags={<SrcTag tag={tag} source="nft_tokens, get_lock, get_latest_verdict, get_flag_count" />}>
            <DataTable rows={loans} cols={loanCols} csvName={`truenav-${fundId}-loans`} rowKey={(l) => l.loan_hash} onRow={(l) => `/loans/${l.loan_hash}`} initial={{ key: "pledged", dir: 1 }} empty="No pledged loans yet." />
          </Panel>
        </>
      ) : null}

      {tab === "pledges" ? (
        <div className="grid2" style={{ marginTop: 0 }}>
          <Panel id="t-refused" title="Refused pledges by this fund" tags={<SrcTag tag={tag} source={`get_attempts_page({"fund_id":"${fundId}","from_index":0,"limit":50})`} />}>
            {f.attemptList.length === 0 ? <p className="dim">None. This fund never tried to pledge a loan another fund holds.</p> : (
              <ul className="plain">{f.attemptList.map((a: { attempt_id: string; at_ms: number }) => <li key={a.attempt_id} className="note n-bad"><b className="mono">{a.attempt_id}</b> {whenFull(a.at_ms)}: tried to pledge a loan another fund already holds. Refused with "already pledged elsewhere".</li>)}</ul>
            )}
            <p className="dim mt">When a fund tries to pledge a loan that another fund already holds, the contract refuses it and stores one blocked attempt and one alert against the fund that tried. Nothing is stored against the fund that holds the loan, and the record does not name it. A pledge sent by an account that is not the named fund stores nothing.</p>
          </Panel>
          <Panel title="Alerts" tags={<SrcTag tag={tag} source="get_alerts_page, get_alert_count" />}>
            {f.alertList.length === 0 ? <p className="dim">No alerts.</p> : <ul className="plain">{f.alertList.map((t: number) => <li key={t}><span className="tp r">alert</span> {whenFull(t)}</li>)}</ul>}
            <p className="mt"><A href="/features/double-pledge" className="xb sm ghost">Try the pledge lock yourself</A></p>
          </Panel>
        </div>
      ) : null}

      {tab === "verdicts" ? (
        <Panel title="Latest enclave verdict per loan" pad={false} tags={<SrcTag tag={tag} source="get_latest_verdict" />}>
          <DataTable rows={loans} rowKey={(l) => l.loan_hash} csvName={`truenav-${fundId}-verdicts`} onRow={(l) => `/loans/${l.loan_hash}`} cols={[
            { key: "hash", label: "Loan", get: (l) => <Hash h={l.loan_hash} href={`/loans/${l.loan_hash}`} />, csv: (l) => l.loan_hash },
            { key: "v", label: "Verdict", get: (l) => l.latest?.verdict ?? "none", csv: (l) => l.latest?.verdict },
            { key: "signer", label: "Signer", get: (l) => <span className="mono">{short(l.latest?.signer, 6, 4)}</span>, csv: (l) => l.latest?.signer },
            { key: "model", label: "Model", get: (l) => l.latest?.model_id ?? "n/a", csv: (l) => l.latest?.model_id },
            { key: "req", label: "Request sha256", get: (l) => <Hash h={l.latest?.request_sha256} />, csv: (l) => l.latest?.request_sha256 },
            { key: "resp", label: "Response sha256", get: (l) => <Hash h={l.latest?.response_sha256} />, csv: (l) => l.latest?.response_sha256 },
            { key: "at", label: "Stored", get: (l) => when(Number(l.latest?.at_ms)), sort: (l) => Number(l.latest?.at_ms || 0), csv: (l) => l.latest?.at_ms },
            { key: "count", label: "History", align: "r", get: (l) => String(l.verdictCount ?? 0), csv: (l) => l.verdictCount },
          ]} />
        </Panel>
      ) : null}

      {tab === "certificates" ? (
        <>
          <Note tone="warn">Signed by a test key held by TrueNav Labs ({short(f.certSigner, 6, 4)}), not by a TEE key. Anyone can recompute the numbers: see the Recompute check on the Overview tab.</Note>
          <Panel className="mt" title="Certificate history" tags={<SrcTag tag={tag} source="get_certificate_history_page (returns signed_at timestamps)" />}>
            <ul className="plain">{(row.certHistory || []).map((t: number) => <li key={t}><span className="tp c">certificate</span> signed {whenFull(t)}{t === f.signedAt ? " (latest)" : ""}</li>)}</ul>
          </Panel>
          <Panel className="mt" title="Latest certificate, raw" tags={<SrcTag tag={tag} source={`get_latest_certificate({"fund_id":"${fundId}"})`} />}>
            <pre className="raw">{JSON.stringify(row.certificate, null, 2)}</pre>
          </Panel>
        </>
      ) : null}

      {Slot ? <Slot fundId={fundId} /> : null}
      <p className="dim mt" style={{ fontSize: 11.5 }}><Q id="testnet">Testnet</Q> data. Fund and manager are fictional.</p>
    </>
  );
}
