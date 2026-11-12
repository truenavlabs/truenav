import { useState } from "react";
import { alerts, getFund, history, toggleWatch, watchlist } from "../api/client";
import { FlowLines, WrapLines } from "../components/Motif";
import { human, millions, shortHash, usdM, usdMv } from "../format";
import type { PublicReceipt } from "../public";
import { A } from "../ui";
import { BANDKEY, BANDWORD, Chip, Explain, ExplainLine, RangeBar, ScoreHistory, ScoreRing, bandVar, rangeIn, type BandKey } from "./parts";
import { DashShell } from "./Shell";

const TIER: Record<string, number> = { high: 4, medium: 2, low: 1, none: 4 };
const tcls = (t: number) => (t >= 3 ? "" : t === 2 ? "y" : "r");
const tcol = (t: number) => (t >= 3 ? "var(--b3)" : t === 2 ? "var(--amber-ink)" : "#b9292e");
const HOLD: Record<string, string> = {
  concentration_largest_obligor: "largest obligor concentration",
  concentration_top_five: "top five concentration",
  recent_pledge_attempt: "recent duplicate pledge attempt",
};

type Area = { nm: string; short: string; big: string; sub: string; t: number };

// Tiers come from public bands only. They are not measured percents.
function areaRows(d: PublicReceipt): Area[] {
  const P = d.parts_band, c = d.late_loan_cohorts;
  const att = d.blocked_attempts === "zero" ? "none" : `${human(d.blocked_attempts)} on record`;
  const late = d.late_share_band === "gt_25pct" ? 1 : d.late_share_band === "gt_10_lte_25pct" ? 2 : 3;
  const unv = d.unverified_share_band === "zero" ? 4 : 2;
  return [
    { nm: "Pledge coverage", short: "pledge", big: (d.pledge_coverage_bps / 100).toFixed(2) + "%", sub: `scope ${human(d.pledge_scope.coverage_status)} · conflicts 0 · attempts ${att}`, t: TIER[P.coverage] ?? 2 },
    { nm: "NAV agreement", short: "nav", big: human(d.nav_result), sub: `gap band ${human(d.nav_gap_band)} · part ${P.nav_gap}`, t: TIER[P.nav_gap] ?? 2 },
    { nm: "Data freshness", short: "fresh", big: human(d.freshness_band), sub: `part ${P.freshness} · as of ${d.data_as_of.slice(5, 10)}`, t: TIER[P.freshness] === 4 ? 4 : 3 },
    { nm: "Cash evidence", short: "cash", big: human(d.cash_match_band), sub: `evidence ${human(d.cash_evidence_status)} · cash match`, t: 4 },
    { nm: "Collections and yield", short: "coll", big: human(d.collection_rate_band), sub: `yield gap ${human(d.yield_gap_band)}`, t: 4 },
    { nm: "Late loans", short: "late", big: human(d.late_share_band), sub: `1 to 30 d ${human(c.dpd_1_30)} · 31 to 60 d ${human(c.dpd_31_60)}`, t: late },
    { nm: "Unverified share", short: "unver", big: human(d.unverified_share_band), sub: `score penalty ${P.penalty}`, t: unv },
  ];
}

function Seg({ t, row = 0, cls = "" }: { t: number; row?: number; cls?: string }) {
  return (
    <div className={`seg ${cls}`}>
      {[0, 1, 2, 3].map((i) => <i key={i} className={i < t ? "on" : ""} style={{ ["--i" as string]: i, ["--r" as string]: row }} />)}
    </div>
  );
}

const CHECK = (
  <svg className="tk" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M3 6.2l2.1 2L9 4" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
);

export function FundPage({ tokenId }: { tokenId: string }) {
  const fund = getFund(tokenId);
  const [collapsed, setCollapsed] = useState(() => {
    try { return sessionStorage.getItem("tn-col") === "1" || window.location.search.includes("collapsed"); } catch { return false; }
  });
  const [watched, setWatched] = useState(() => watchlist().includes(tokenId));
  if (!fund) {
    return (
      <DashShell route="fund" crumb={<>funds / <b>unknown</b></>}>
        <div className="card cb">No public receipt for this token. <A href="/funds">Back to funds</A></div>
      </DashShell>
    );
  }
  const d = fund.receipt;
  const band: BandKey = BANDKEY[d.band] ?? "y";
  const bc = bandVar(band);
  const r = rangeIn(d, band);
  const rows = areaRows(d);
  const top = rows.filter((x) => x.t === 4).length;
  const strongest = rows.reduce((a, x) => (x.t > a.t ? x : a));
  const weakest = rows.reduce((a, x) => (x.t < a.t ? x : a));
  const pts = history(tokenId);
  const al = alerts(tokenId);
  const att = d.blocked_attempts === "zero" ? 0 : 1;
  const clear = d.pledge_result === "clear";
  const verifyHref = `/verify?token_id=${encodeURIComponent(d.token_id)}&seq=${encodeURIComponent(d.seq)}`;
  const gap = r.tv - r.rep;
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { sessionStorage.setItem("tn-col", next ? "1" : "0"); } catch { /* ignore */ }
  };
  const obs = r.inside ? (
    <>Reported NAV <b>{usdM(d.reported_nav)}</b> is inside TrueRange and {usdMv(Math.abs(gap))} ({((Math.abs(gap) / r.tv) * 100).toFixed(1)}%) {gap >= 0 ? "below" : "above"} TrueVal. <span className="notes" title={d.holds.map((h) => HOLD[h] ?? h.replace(/_/g, " ")).join(", ")}>{d.holds.length} score notes</span>.</>
  ) : (
    <>Reported NAV <b>{usdM(d.reported_nav)}</b> is {usdMv(Math.abs(r.rep - (r.over ? r.hi : r.lo)))} {r.over ? "above TrueRange high" : "below TrueRange low"}.{att ? ` ${att} duplicate pledge attempt on record, result ${human(d.pledge_result)}.` : ""}</>
  );
  return (
    <DashShell route="fund" active={tokenId} crumb={<>funds / <b>{fund.name.toLowerCase()}</b></>}>
      <div className="card strip">
        <FlowLines seed={tokenId.startsWith("harbor") ? 3 : 11} fade={0.4} />
        <div className="tt"><div className="lbl idxl">[1] scores / fund</div><h1>{fund.name}</h1></div>
        <div className="kpis">
          <div className="kgrid">
            <div className="kg"><div className="v">{d.period_start.slice(5)} to {d.period_end.slice(5)}</div><div className="s">period {d.period_end.slice(0, 4)}</div></div>
            <div className="kg"><div className="v">{d.data_as_of.slice(5, 10)} {d.data_as_of.slice(11, 16)}Z</div><div className="s">data as of · {human(d.freshness_band)}</div></div>
            <div className="kg"><div className="v">seq {d.seq}</div><div className="s">receipt · {d.currency}</div></div>
            <div className="kg"><div className="v">{d.method_version.replace("truenav-", "")}</div><div className="s">method</div></div>
          </div>
          <div className="kside">
            <div><div className="v" style={{ color: "var(--b3)" }}>{strongest.nm}</div><div className="s">strongest area · by band tier</div></div>
            <div><div className="v" style={{ color: tcol(weakest.t) }}>{weakest.nm}</div><div className="s">weakest area · by band tier</div></div>
          </div>
        </div>
      </div>

      <div className="card accent obs" style={{ ["--bandc" as string]: bc }}>
        <span className="lbl" style={{ color: "var(--b2)" }}>observation</span>
        {r.inside ? <Chip tone="g" dot>inside range</Chip> : <Chip tone="r" dot>outside range</Chip>}
        <span className="tx">{obs}</span>
        <button className={`go ghost${watched ? " on" : ""}`} onClick={() => setWatched(toggleWatch(tokenId).includes(tokenId))} aria-pressed={watched}>
          {watched ? "watching" : "watch"}
        </button>
        <a className="go" href="#rcpt">see receipt →</a>
      </div>

      <div className={`g12${collapsed ? " col" : ""}`}>
        <div className="leftcol">
          <div className="rowB">
            <div className="card frame accent ringcard" style={{ ["--bandc" as string]: bc }}>
              <div className="ch"><Explain term="score" /><span className="r"><Chip tone={band}>{BANDWORD[d.band] ?? d.band}</Chip></span></div>
              <WrapLines seed={tokenId.startsWith("harbor") ? 5 : 9} cyOffset={116} />
              <div className="idx">r, θ, ρ<br />[1] score</div>
              <div className="ringwrap">
                <ScoreRing score={d.score ?? 0} />
                <div className="num"><div className="big">{d.score ?? "n/a"}</div><div className="of">/ 100</div></div>
              </div>
              <div className="parts">
                <div><div className="k">coverage</div><div className="v">{d.parts_band.coverage}</div></div>
                <div><div className="k">nav gap</div><div className="v">{d.parts_band.nav_gap}</div></div>
                <div><div className="k">freshness</div><div className="v">{d.parts_band.freshness}</div></div>
                <div><div className="k">penalty</div><div className="v">{d.parts_band.penalty}</div></div>
              </div>
            </div>

            <div className="card tv accent" style={{ ["--bandc" as string]: bc }}>
              <div className="ch">
                <span><Explain term="trueVal" inline>trueval</Explain><span className="lbl"> · </span><Explain term="trueRange" inline>truerange</Explain></span>
                <span className="r">{r.inside ? <Chip tone="g" dot>inside range</Chip> : <Chip tone="r" dot>outside range</Chip>}<Chip>{d.currency}</Chip></span>
              </div>
              <div className="tvtop">
                <div className="tvcol">
                  <div className="lbl">trueval</div>
                  <div className="tvbig">{usdM(d.trueval)}</div>
                  <ExplainLine term="trueVal" />
                </div>
                <div className="tvstats">
                  <div><div className="lbl">truerange low</div><div className="v">{usdM(d.truerange_low)}</div></div>
                  <div><div className="lbl">truerange high</div><div className="v">{usdM(d.truerange_high)}</div></div>
                  <div><div className="lbl">reported nav</div><div className="v" style={r.inside ? undefined : { color: "#b9292e" }}>{usdM(d.reported_nav)}</div></div>
                  <div><div className="lbl">width</div><div className="v">{usdMv(millions(d.truerange_high) - millions(d.truerange_low))}</div></div>
                </div>
              </div>
              <RangeBar r={r} />
              <div className="tvfoot">
                <div><div className="lbl">nav result</div><div className="v">{human(d.nav_result)}</div></div>
                <div><div className="lbl">nav gap band</div><div className="v">{human(d.nav_gap_band)}</div></div>
                <div><div className="lbl">unverified</div><div className="v">{human(d.unverified_share_band)}</div></div>
              </div>
            </div>
          </div>

          <div className="rowC">
            <div className="card chartcard" style={{ ["--bandc" as string]: bc }}>
              <div className="ch">
                <div className="tabs"><span className="tab on">Score history</span></div>
                <span className="r"><Chip tone="ex">example data</Chip></span>
              </div>
              <ScoreHistory points={pts} color={band === "g" ? "#14a86a" : band === "r" ? "#e5484d" : "#c9921a"} labelBelow={band === "g"} />
              <div className="legend">
                <span><i className="ld now" />latest point = fixture receipt seq {d.seq}</span>
                <span><i className="ld ex" />earlier points are example values</span>
              </div>
            </div>

            <div className="card pledge">
              <div className="ch"><span className="lbl">pledged once</span><span className="r">{att ? <Chip tone="y">clear · {att} attempt</Chip> : <Chip tone="g">clear</Chip>}</span></div>
              <div className="stat2">
                <div><div className="lbl">loans registered</div><div className="n">{human(d.loans_checked)}</div></div>
                <div><div className="lbl">conflicts found</div><div className="n" style={{ color: clear ? "var(--green)" : "var(--red)" }}>{clear ? 0 : "open"}</div></div>
              </div>
              <Lanes n={tokenId.startsWith("harbor") ? 14 : 7} />
              <div className="kv">
                <div className="k">result</div><div className="v">{human(d.pledge_result)} · {(d.pledge_coverage_bps / 100).toFixed(2)}%</div>
                <div className="k">dup attempts</div><div className="v" style={{ color: att ? "var(--amber-ink)" : undefined }}>{att ? "1 on record · info only" : "none on record"}</div>
                <div className="k">scope</div><div className="v">{d.pledge_scope.scope_id}</div>
                <div className="k">checked at</div><div className="v">block {d.pledge_scope.block_height}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="rightcol">
          <button className="handle" onClick={toggle} aria-label={collapsed ? "expand per-area panel" : "collapse per-area panel"} title="collapse or expand"><i /><i /></button>
          <div className="full">
            <div className="card areas" style={{ ["--bandc" as string]: bc }}>
              <div className="ahead">
                <span className="frac">{top}<span> / {rows.length}</span></span>
                <span className="tt">Per-area checks<small>areas at the top band tier</small></span>
              </div>
              <div className="legend2" title="Bars show the band tier from the public fields, not a measured percent">
                {([[4, "var(--b2)", "top band"], [3, "var(--b2)", "one below"], [2, "var(--amber)", "middle"], [1, "var(--red)", "lowest"]] as const).map(([n, c, t]) => (
                  <span key={t} className="pill" style={{ ["--c" as string]: c }}>
                    <span className="k">{[0, 1, 2, 3].map((i) => <i key={i} className={i < n ? "on" : ""} />)}</span>{t}
                  </span>
                ))}
              </div>
              {rows.map((a, k) => (
                <div key={a.nm} className={`area${k === 0 ? " first" : ""}`} style={{ ["--c" as string]: a.t >= 3 ? "var(--b2)" : tcol(a.t) }}>
                  <div className="h">
                    <span className="nm">{a.nm}</span>
                    {a.t === 4 ? CHECK : <span className="tk" />}
                    <span className="big" style={a.t < 3 ? { color: tcol(a.t) } : undefined}>{a.big}</span>
                  </div>
                  <Seg t={a.t} row={k} cls={tcls(a.t)} />
                  <span className="sub">{a.sub}</span>
                </div>
              ))}
            </div>
            <div className="card rcpt" id="rcpt">
              <div className="ch"><span className="lbl">latest receipt</span><span className="r"><Chip tone="b">seq {d.seq}</Chip></span></div>
              <div className="kv">
                <div className="k">hash</div><div className="v" title={d.receipt_sha256}>{shortHash(d.receipt_sha256)}</div>
                <div className="k">engine pin</div><div className="v" title={d.engine_version_key}>{shortHash(d.engine_version_key, 8, 6)}</div>
                <div className="k">method</div><div className="v">{d.method_version} · {d.valuation_time.slice(5, 10)}</div>
                <div className="k">attestation</div><div className="v"><Chip tone="y">unattested</Chip></div>
              </div>
              <A className="btn" href={verifyHref}>check receipt <span>→</span></A>
            </div>
          </div>
          <div className="rail">
            <div className="card">
              <div className="rh" style={{ ["--bandc" as string]: bc }}><span className="frac">{top}/{rows.length}</span></div>
              {rows.map((a) => (
                <div key={a.nm} className="ri" title={`${a.nm}: ${a.big}`}><b>{a.short}</b><Seg t={a.t} cls={tcls(a.t)} /></div>
              ))}
            </div>
            <div className="card"><div className="ri"><b>seq {d.seq}</b><span className="un">unattested</span></div><A className="btn sm" href={verifyHref}>check</A></div>
          </div>
        </div>
      </div>

      <div className="card alerts">
        <div className="ch"><span className="lbl">alerts</span><span className="r"><Chip tone="ex">example data</Chip></span></div>
        {al.length ? (
          <ul>
            {al.map((x, i) => (
              <li key={i}><span className="at">{x.at}</span><span className="kd">{x.kind.replace(/_/g, " ")}</span><span className="tx">{x.text}</span><span className="src">{x.source}</span></li>
            ))}
          </ul>
        ) : (
          <p className="none">No alerts in this window. Alerts fire on a 10 point drop, a band change, or NAV outside TrueRange.</p>
        )}
      </div>

      <div className="foot"><span>FIXTURE · TESTNET · synthetic receipt, public fields only</span><span>{d.token_id}</span></div>
    </DashShell>
  );
}

// One line per loan, each into exactly one lane. Counts are illustrative; the public field is a band.
function Lanes({ n }: { n: number }) {
  return (
    <div className="lanes">
      <svg width="100%" height="46" viewBox="0 0 272 46" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => {
          const y = 4 + i * (38 / (n - 1)), y2 = 23 + (y - 23) * 0.35;
          return <path key={i} d={`M0 ${y} C 110 ${y}, 120 ${y2}, 170 ${y2} L 272 ${y2}`} fill="none" stroke={i % 3 ? "#64c5fd" : "#0aa0f0"} strokeWidth={1.5} opacity={0.75} />;
        })}
        <rect x="184" y="13" width="88" height="20" fill="#0aa0f0" />
        <text x="193" y="26.5" className="lane-t">POOLED ONCE</text>
      </svg>
    </div>
  );
}
