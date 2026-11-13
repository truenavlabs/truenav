// Adapters from the live registry view to the depth modules' props. Every data room number is shown only when the
// demo file's anchors match the live certificate and loan set (anchorsMatch); otherwise the modules get outOfSync.
import "../../modules/terminal.css";
import { useEffect, useMemo, useState } from "react";
import demo from "../../data/demo/funds.demo.json";
import { anchorsMatch } from "../../data/demo/model.mjs";
import * as feedsMod from "../../data/feeds/feeds.mjs";
import { marketsModel, tickerItems } from "../../data/feeds/view.mjs";
import * as mods from "../../modules/index.mjs";
import { useRegistry, type Registry } from "../shell/store";
import { fundName, whenFull } from "../shell/fmt";
import { A, navigate } from "../ui";
import { Note, PageHead, Panel, SrcTag } from "../shell/kit";

// The modules are plain JS with optional props; type them loosely at this one boundary.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyC = React.ComponentType<any>;
const { AuditorView, CashFlowPanel, ExposurePanel, InvestorView, LoanBook, LoanDetail, ManagerView, MarketsPanels, MarketTicker, NavHistoryChart, ReportBundle, StressPanel } = mods as unknown as Record<string, AnyC>;
const { FEEDS, presentFeed, startPoll } = feedsMod as unknown as { FEEDS: Record<string, unknown>; presentFeed: (a: object) => unknown; startPoll: (id: string, o: object) => () => void };
type DemoFund = (typeof demo.funds)[number];
const FUNDS = demo.funds as DemoFund[];
const demoFund = (id: string) => FUNDS.find((f) => f.fund_id === id) ?? null;
const Root = ({ children }: { children: React.ReactNode }) => <div className="tn-root tn-embed">{children}</div>;

function liveAnchors(view: Registry, fundId: string) {
  const c = view.funds.find((f) => f.fund_id === fundId)?.certificate?.certificate;
  if (!c) return null;
  return { score: c.score, true_val_cents: c.true_val_cents, headline_cents: c.headline_cents, policy_nav_cents: c.policy_nav_cents, loan_hashes: view.loans.filter((l) => l.fund_id === fundId).map((l) => l.loan_hash) };
}
/** outOfSync reason, or null when the demo detail matches the chain (or the recorded read when offline). */
function useSync(fundId: string) {
  const { view, tag } = useRegistry();
  const f = demoFund(fundId);
  const live = liveAnchors(view, fundId);
  if (!f) return { f: null, outOfSync: "No demo detail for this fund.", tag };
  const m = anchorsMatch(f.anchors, live);
  return { f, outOfSync: m.ok ? undefined : m.reason, tag };
}
const DemoNote = () => <Note tone="demo">Demo data. Fictional loan level detail, anchored to the live certificate: it shows only while its totals match the chain.</Note>;

export function Exposure({ fundId }: { fundId: string }) {
  const { f, outOfSync } = useSync(fundId);
  return <><DemoNote /><Root>{f ? <><NavHistoryChart points={f.nav_history} outOfSync={outOfSync} /><ExposurePanel exposures={f.exposures} concentration={f.why_score.concentration} outOfSync={outOfSync} /></> : null}</Root></>;
}
export function CashFlows({ fundId }: { fundId: string }) {
  const { f, outOfSync } = useSync(fundId);
  return <><DemoNote /><Root>{f ? <CashFlowPanel cashFlows={f.cash_flows} outOfSync={outOfSync} /> : null}</Root></>;
}
export function Stress({ fundId }: { fundId: string }) {
  const { f, outOfSync } = useSync(fundId);
  return <><DemoNote /><Root>{f ? <StressPanel scenarios={f.stress_scenarios} outOfSync={outOfSync} /> : null}</Root></>;
}
export function DataRoom({ fundId }: { fundId: string }) {
  const { f, outOfSync } = useSync(fundId);
  const [lens, setLens] = useState<"public" | "data_room">("data_room");
  return (
    <>
      <DemoNote />
      <div className="hrow" style={{ gap: 6, margin: "8px 0" }}>
        <button className={`chipbtn${lens === "public" ? " on" : ""}`} onClick={() => setLens("public")}>Public lens</button>
        <button className={`chipbtn${lens === "data_room" ? " on" : ""}`} onClick={() => setLens("data_room")}>Data room lens (demo)</button>
      </div>
      <Root>{f ? <LoanBook loans={f.loans} lens={outOfSync ? "public" : lens} outOfSync={outOfSync} onOpen={(l: { loan_hash?: string }) => l.loan_hash && navigate(`/loans/${l.loan_hash}`)} /> : null}</Root>
    </>
  );
}
export function Reports({ fundId }: { fundId: string }) {
  return <p className="mt"><A className="xb" href={`/reports/${fundId}`}>Open the printable report and JSON bundle</A></p>;
}
export function Report({ fundId }: { fundId: string }) {
  const { view } = useRegistry();
  const { f } = useSync(fundId);
  return (
    <>
      <PageHead crumbs={[["Funds", "/funds"], [fundName(fundId), `/funds/${fundId}`], ["Report"]]} title={`${fundName(fundId)}: report`} lead="A printable sheet and a JSON bundle with a sha256 per section. Demo loan detail is fictional." right={<button className="xb ghost" onClick={() => window.print()}>Print</button>} />
      <Root>{f ? <ReportBundle fund={f} readAt={view.readAt ? new Date(view.readAt).toISOString() : undefined} /> : <p>No report for this fund.</p>}</Root>
    </>
  );
}
export function LoanExtra({ hash }: { hash: string }) {
  const hit = FUNDS.flatMap((f) => f.loans.map((l) => ({ f, l }))).find((x) => x.l.loan_hash === hash);
  const { outOfSync } = useSync(hit?.f.fund_id ?? "");
  if (!hit) return null;
  return <div className="mt"><DemoNote /><Root><LoanDetail loan={hit.l} lens="data_room" outOfSync={outOfSync} /></Root></div>;
}

function alertsFrom(view: Registry) {
  return view.funds.flatMap((f) => (f.attempts?.attempts || []).map((a: { attempt_id: string; at_ms: number }) => ({ id: a.attempt_id, text: `${fundName(f.fund_id)}: refused pledge ${a.attempt_id}, ${whenFull(a.at_ms)}` })));
}
export function Investor() {
  const { view } = useRegistry();
  return <><PageHead title="Investor view" lead="Same public data as every role. No access control." /><Root><InvestorView funds={FUNDS} alerts={alertsFrom(view)} /></Root></>;
}
export function Manager() {
  const [id, setId] = useState(FUNDS[0]?.fund_id);
  return (
    <>
      <PageHead title="Fund manager view" lead="View as a fund. Nothing is signed or sent." right={<select value={id} onChange={(e) => setId(e.target.value)}>{FUNDS.map((f) => <option key={f.fund_id} value={f.fund_id}>{fundName(f.fund_id)}</option>)}</select>} />
      <Root><ManagerView fund={demoFund(id)} /></Root>
      <ManagerLive fundId={id} />
    </>
  );
}
/** Live chain state for the chosen fund: what the module above describes, read from the registry. */
function ManagerLive({ fundId }: { fundId: string }) {
  const { view, tag } = useRegistry();
  const f = view.funds.find((x) => x.fund_id === fundId);
  const loans = view.loans.filter((l) => l.fund_id === fundId);
  const attempts = (f?.attempts?.attempts || []) as { attempt_id: string; at_ms: number }[];
  const alerts = (f?.alerts || []) as number[];
  const pass = loans.filter((l) => l.latest?.verdict === "pass").length, flag = loans.filter((l) => l.latest?.verdict === "flag").length;
  return (
    <div className="grid2">
      <Panel title="My attempts and alerts" tags={<SrcTag tag={tag} source="get_attempts_page, get_alerts_page" />}>
        {attempts.length ? <ul className="plain">{attempts.map((a) => <li key={a.attempt_id}><span className="bad">Refused pledge</span> {a.attempt_id}, {whenFull(a.at_ms)}</li>)}</ul> : <p className="dim">No refused pledges. {alerts.length ? "" : "No alerts."}</p>}
        {alerts.length ? <p className="dim mt">{alerts.length} alert{alerts.length === 1 ? "" : "s"} stored on this fund: {alerts.map((t) => whenFull(t)).join("; ")}.</p> : null}
      </Panel>
      <Panel title="My loans and verdicts" tags={<SrcTag tag={tag} source="nft_tokens, get_latest_verdict" />}>
        <p>{loans.length} pledged loans: {pass} pass, {flag} flag, {loans.length - pass - flag} with no verdict.</p>
        <p className="mt"><A href={`/funds/${fundId}?tab=verdicts`}>All verdicts</A> · <A href={`/funds/${fundId}?tab=loans`}>Loan book</A> · <A href={`/account/${f?.fund?.account_id ?? ""}`}>View as the fund account</A></p>
        <p className="dim mt">Pledging needs a fresh servicer signature and is sent by the fund's own account: pledge_loan(loan_hash, asset_type, fund_account, nonce, expiry_ms, servicer_signature, ticket_signature). In this demo the servicer is TrueNav Labs.</p>
      </Panel>
    </div>
  );
}

export function Auditor() {
  return <><PageHead title="Auditor view" lead="How to re-check every number." /><Root><AuditorView funds={FUNDS} /></Root></>;
}

/* ---------- market feeds: one shared poller per tab ---------- */
type FeedMap = Record<string, unknown>;
const shared: { feeds: FeedMap; subs: Set<(f: FeedMap) => void>; started: boolean } = { feeds: {}, subs: new Set(), started: false };
function startFeeds() {
  if (shared.started) return;
  shared.started = true;
  const live: FeedMap = {};
  let snap: Record<string, unknown> = {};
  const publish = () => {
    const out: FeedMap = {};
    for (const id of Object.keys(FEEDS)) if (id !== "defillama-pool-chart") out[id] = presentFeed({ id, live: live[id], snapshot: snap[id] });
    shared.feeds = out;
    shared.subs.forEach((s) => s(out));
  };
  fetch("/feeds/snapshot.json").then((r) => r.json()).then((j) => { snap = j.feeds || {}; publish(); }).catch(() => publish());
  for (const id of Object.keys(FEEDS)) {
    if (id === "defillama-pool-chart") continue;
    startPoll(id, { hidden: () => document.hidden, onResult: (r: unknown) => { live[id] = r; publish(); } });
  }
}
function useFeeds() {
  const [feeds, setFeeds] = useState<FeedMap>(shared.feeds);
  useEffect(() => { shared.subs.add(setFeeds); startFeeds(); return () => { shared.subs.delete(setFeeds); }; }, []);
  return feeds;
}
export function Ticker() {
  const feeds = useFeeds();
  const items = useMemo(() => tickerItems(feeds), [feeds]);
  if (!items.length) return null;
  return <Root><MarketTicker items={items} /></Root>;
}
export function Markets() {
  const feeds = useFeeds();
  const model = useMemo(() => marketsModel(feeds), [feeds]);
  return <><PageHead title="Markets" lead="External market data. Context only: none of it feeds a TrueNav score." /><Root><MarketsPanels model={model} feeds={feeds} /></Root></>;
}
