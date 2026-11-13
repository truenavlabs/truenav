// UI kit for the app: source chips, explainers, panels, KPI tiles, hashes, sortable tables, states.
import { useMemo, useState, type ReactNode } from "react";
import { TAG_INFO } from "../../data/tags.mjs";
import { toCsv, download } from "../../data/csv.mjs";
import { TERM } from "../content/glossary";
import { A } from "../ui";
import { short } from "./fmt";

export type Tag = "live" | "recorded" | "computed" | "demo" | "external";

/** Provenance chip. Hover or focus shows what the tag means and the exact source. */
export function SrcTag({ tag, source, at, label }: { tag: Tag; source?: string; at?: string; label?: string }) {
  const info = (TAG_INFO as Record<string, { label: string; hint: string }>)[tag];
  return (
    <span className={`src src-${tag}`} tabIndex={0} aria-label={`${info.label}: ${info.hint}${source ? ` Source: ${source}` : ""}`}>
      <i aria-hidden="true" />
      {label ?? info.label}
      {at ? <span className="src-at">{at}</span> : null}
      <span className="pop" role="tooltip">
        <b>{info.label}.</b> {info.hint}
        {source ? <code>{source}</code> : null}
      </span>
    </span>
  );
}

/** "?" explainer linked to a glossary term. */
export function Q({ id, children }: { id: string; children?: ReactNode }) {
  const t = TERM[id];
  if (!t) return <>{children}</>;
  return (
    <span className="q" tabIndex={0} aria-label={`${t.term}: ${t.text}`}>
      {children ?? t.term}
      <span className="qm" aria-hidden="true">?</span>
      <span className="pop" role="tooltip">
        <b>{t.term}.</b> {t.text}
      </span>
    </span>
  );
}

export function Panel({ title, sub, tags, right, children, className, id, pad = true }: {
  title?: ReactNode; sub?: ReactNode; tags?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string; pad?: boolean;
}) {
  return (
    <section className={`panel${className ? " " + className : ""}`} id={id}>
      {title || tags || right ? (
        <header className="ph">
          <div className="pt">
            <h2>{title}</h2>
            {sub ? <p>{sub}</p> : null}
          </div>
          <div className="pr">{tags}{right}</div>
        </header>
      ) : null}
      <div className={pad ? "pb" : "pb0"}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tag, source, tone, term, wrap }: {
  label: string; value: ReactNode; sub?: ReactNode; tag: Tag; source?: string; tone?: "g" | "y" | "r" | "c"; term?: string; wrap?: boolean;
}) {
  return (
    <div className={`kpi${tone ? " t-" + tone : ""}`}>
      <div className="kl">{term ? <Q id={term}>{label}</Q> : label}</div>
      <div className={`kval num${wrap ? " kval-wrap" : ""}`}>{value}</div>
      <div className="ks">
        <SrcTag tag={tag} source={source} />
        {sub ? <span>{sub}</span> : null}
      </div>
    </div>
  );
}

export function Band({ band, score }: { band: string | null | undefined; score?: number | null }) {
  if (!band) return <span className="band b-none">n/a</span>;
  const k = band === "green" ? "g" : band === "yellow" ? "y" : "r";
  return (
    <span className={`band b-${k}`}>
      {score !== undefined && score !== null ? <b className="num">{score}</b> : null}
      {band}
    </span>
  );
}

export function Copy({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        });
      }}
      aria-label={`Copy ${text}`}
    >
      {done ? "copied" : label}
    </button>
  );
}

export function Hash({ h, href, a = 6, z = 4 }: { h: string | null | undefined; href?: string; a?: number; z?: number }) {
  if (!h) return <span className="mono dim">n/a</span>;
  return (
    <span className="hash">
      {href ? <A href={href} className="mono" title={h}>{short(h, a, z)}</A> : <span className="mono" title={h}>{short(h, a, z)}</span>}
      <Copy text={h} label="" />
    </span>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="ext" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

export function Skel({ rows = 3, h = 14 }: { rows?: number; h?: number }) {
  return (
    <div className="skel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <i key={i} style={{ height: h, width: `${90 - ((i * 17) % 40)}%` }} />)}
    </div>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "ok" | "demo"; children: ReactNode }) {
  return <div className={`note n-${tone}`}><div className="nb">{children}</div></div>;
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="note n-bad" role="alert">
      <b>Could not read.</b> <span className="mono">{error}</span>
      {retry ? <button className="xb sm" onClick={retry}>Retry</button> : null}
    </div>
  );
}

export type Col<T> = { key: string; label: ReactNode; get: (r: T) => ReactNode; sort?: (r: T) => number | string; csv?: (r: T) => unknown; align?: "r" | "l"; width?: string };

export function DataTable<T>({ rows, cols, csvName, initial, empty = "No rows.", onRow, rowKey }: {
  rows: T[]; cols: Col<T>[]; csvName?: string; initial?: { key: string; dir: 1 | -1 }; empty?: ReactNode; onRow?: (r: T) => string | undefined; rowKey: (r: T) => string;
}) {
  const [s, setS] = useState(initial ?? null);
  const sorted = useMemo(() => {
    if (!s) return rows;
    const c = cols.find((x) => x.key === s.key);
    if (!c || !c.sort) return rows;
    return [...rows].sort((a, b) => {
      const x = c.sort!(a), y = c.sort!(b);
      return (x < y ? -1 : x > y ? 1 : 0) * s.dir;
    });
  }, [rows, cols, s]);
  const exportCsv = () => {
    const text = toCsv(sorted as object[], cols.filter((c) => c.csv).map((c) => [(r: T) => c.csv!(r), typeof c.label === "string" ? c.label : c.key]));
    download(`${csvName}.csv`, text);
  };
  return (
    <div className="tablewrap">
      {csvName ? (
        <div className="tabletools">
          <span className="dim">{rows.length} rows</span>
          <button className="xb sm ghost" onClick={exportCsv}>Download CSV</button>
        </div>
      ) : null}
      <div className="tscroll">
        <table className="dt">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.align === "r" ? "r" : undefined} style={c.width ? { width: c.width } : undefined}
                  aria-sort={s && s.key === c.key ? (s.dir === 1 ? "ascending" : "descending") : undefined}>
                  {c.sort ? (
                    <button onClick={() => setS((p) => ({ key: c.key, dir: p && p.key === c.key ? ((-p.dir) as 1 | -1) : -1 }))}>
                      {c.label}
                      <span className="sortm" aria-hidden="true">{s && s.key === c.key ? (s.dir === 1 ? "▲" : "▼") : ""}</span>
                    </button>
                  ) : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={cols.length} className="empty">{empty}</td></tr>
            ) : sorted.map((r) => {
              const href = onRow ? onRow(r) : undefined;
              return (
                <tr key={rowKey(r)} className={href ? "link" : undefined} onClick={href ? (e) => {
                  if ((e.target as HTMLElement).closest("a,button")) return;
                  window.history.pushState(null, "", href);
                  window.dispatchEvent(new PopStateEvent("popstate"));
                } : undefined}>
                  {cols.map((c) => <td key={c.key} className={c.align === "r" ? "r num" : undefined}>{c.get(r)}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "on" : undefined} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

/** Page header with breadcrumb, title, lead and right-side actions. */
export function PageHead({ crumbs, title, lead, right, chips }: { crumbs?: [string, string?][]; title: ReactNode; lead?: ReactNode; right?: ReactNode; chips?: ReactNode }) {
  return (
    <div className="pagehead">
      {crumbs ? (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map(([l, h], i) => (
            <span key={i}>{h ? <A href={h}>{l}</A> : <span>{l}</span>}{i < crumbs.length - 1 ? <i>/</i> : null}</span>
          ))}
        </nav>
      ) : null}
      <div className="phrow">
        <div>
          <h1>{title}</h1>
          {chips ? <div className="chips">{chips}</div> : null}
          {lead ? <p className="lead">{lead}</p> : null}
        </div>
        {right ? <div className="phr">{right}</div> : null}
      </div>
    </div>
  );
}

/** The shared frame of every feature page (spec 4.16). */
export function FeatureFrame({ what, status, tryIt, proves, notProves, run, sources }: {
  what: ReactNode; status: ReactNode; tryIt: ReactNode; proves: ReactNode[]; notProves: ReactNode[]; run: string[]; sources: string[];
}) {
  return (
    <div className="feature">
      <div className="frow">
        <Panel title="What it does" className="fwhat"><p>{what}</p></Panel>
        <Panel title="Status" className="fstatus">{status}</Panel>
      </div>
      <Panel title="Try it" sub="Runs in your browser. Read-only: nothing is sent to the chain." className="ftry">{tryIt}</Panel>
      <div className="grid2">
        <Panel title="What this proves">
          <ul className="ticks">{proves.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Panel>
        <Panel title="What it does not prove">
          <ul className="limits">{notProves.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Panel>
      </div>
      <div className="grid2">
        <Panel title="Run it yourself">
          {run.map((c) => (
            <div className="cmd" key={c}><code>{c}</code><Copy text={c} /></div>
          ))}
        </Panel>
        <Panel title="Source">
          <ul className="srcs">{sources.map((s) => <li key={s}><Ext href={`https://github.com/truenavlabs/truenav/blob/main/${s.split(":")[0]}`}>{s}</Ext></li>)}</ul>
        </Panel>
      </div>
    </div>
  );
}

export function StatusChip({ kind }: { kind: "live" | "built" | "recorded" | "notdeployed" | "simulated" }) {
  const m = { live: ["s-live", "Live on testnet"], built: ["s-built", "Built and tested, not deployed"], recorded: ["s-rec", "Recorded"], notdeployed: ["s-nd", "Not deployed"], simulated: ["s-sim", "Simulation in your browser"] }[kind];
  return <span className={`status ${m[0]}`}>{m[1]}</span>;
}
