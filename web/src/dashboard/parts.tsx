import { useEffect, useRef, useState, type ReactNode } from "react";
import { TOOLTIPS } from "../copy";
import { millions, usdMv } from "../format";
import type { HistoryPoint } from "../api/client";

export type BandKey = "g" | "y" | "r";
export const BANDKEY: Record<string, BandKey> = { green: "g", yellow: "y", red: "r" };
export const BANDWORD: Record<string, string> = { green: "Green", yellow: "Yellow", red: "Red" };
export const bandVar = (b: BandKey) => `var(--${b === "g" ? "green" : b === "r" ? "red" : "amber"})`;

export function Chip({ tone, children, dot, title }: { tone?: BandKey | "b" | "ex"; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`chip${tone ? " " + tone : ""}`} title={title}>
      {dot && tone && tone !== "ex" ? <i className={`dot ${tone}`} /> : null}
      {children}
    </span>
  );
}

type Term = "score" | "trueVal" | "trueRange";
const TERM_LABEL: Record<Term, string> = { score: "TrueNav score", trueVal: "TrueVal", trueRange: "TrueRange" };

// A label that always carries its explainer: on hover and focus, and to screen readers.
export function Explain({ term, children, inline }: { term: Term; children?: ReactNode; inline?: boolean }) {
  return (
    <span className={`explain${inline ? " inline" : ""}`} tabIndex={0} aria-label={`${TERM_LABEL[term]}: ${TOOLTIPS[term]}`}>
      <span className="lbl">{children ?? TERM_LABEL[term]}</span>
      <span className="q" aria-hidden="true">?</span>
      <span className="pop" role="tooltip">
        <b>{TERM_LABEL[term]}</b> {TOOLTIPS[term]}
        {term === "score" ? <em> Bands: {TOOLTIPS.bands}</em> : null}
      </span>
    </span>
  );
}

export function ExplainLine({ term }: { term: Term }) {
  return <div className="xline">{TOOLTIPS[term]}</div>;
}

type RangeIn = { lo: number; hi: number; tv: number; rep: number; inside: boolean; over: boolean; under: boolean; band: BandKey };

function tone(r: RangeIn) {
  if (!r.inside) return { bt: "rgba(229,72,77,.16)", ink: "#b9292e" };
  if (r.band === "y") return { bt: "rgba(201,146,26,.2)", ink: "var(--amber-ink)" };
  return { bt: "rgba(20,168,106,.18)", ink: "#0d7a4c" };
}

export function rangeIn(d: { truerange_low: string; truerange_high: string; trueval: string; reported_nav: string; nav_result: string }, band: BandKey): RangeIn {
  return {
    lo: millions(d.truerange_low), hi: millions(d.truerange_high), tv: millions(d.trueval), rep: millions(d.reported_nav),
    inside: d.nav_result === "inside", over: d.nav_result === "outside_high", under: d.nav_result === "outside_low", band,
  };
}

export function RangeBar({ r }: { r: RangeIn }) {
  const a0 = Math.min(r.lo, r.rep), b0 = Math.max(r.hi, r.rep), pad = (b0 - a0) * 0.22;
  const a = a0 - pad, b = b0 + pad, P = (v: number) => ((v - a) / (b - a)) * 100;
  const t = tone(r);
  const out = r.over || r.under;
  const edge = r.over ? r.hi : r.lo;
  return (
    <div className="rng" style={{ ["--bt" as string]: t.bt }}>
      <div className="axis" />
      {Array.from({ length: 13 }, (_, i) => <i key={i} className="tick" style={{ left: `${(i / 12) * 100}%` }} />)}
      <div className="band" style={{ left: `${P(r.lo)}%`, width: `${P(r.hi) - P(r.lo)}%` }} />
      <div className="tvl" style={{ left: `${P(r.tv)}%` }} />
      <div className="t dn" style={{ left: `${P(r.lo)}%`, transform: "translateX(-100%)", paddingRight: 6 }}><small>low</small>{usdMv(r.lo)}</div>
      <div className="t dn" style={{ left: `${P(r.hi)}%`, transform: "none", paddingLeft: 6 }}><small>high</small>{usdMv(r.hi)}</div>
      <div className="t dn hide-m" style={{ left: `${P(r.tv)}%` }}><small>trueval</small>{usdMv(r.tv)}</div>
      <div className={`rep${out ? " out" : ""}`} style={{ left: `${P(r.rep)}%` }} />
      {out ? (
        <>
          <div className="leader" style={{ left: `${Math.min(P(edge), P(r.rep))}%`, width: `${Math.abs(P(r.rep) - P(edge))}%` }} />
          <div className="bk" style={{ left: `${Math.min(P(edge), P(r.rep))}%`, width: `${Math.abs(P(r.rep) - P(edge))}%` }} />
          <div className="bkt" style={{ left: `${(P(edge) + P(r.rep)) / 2}%` }}>
            {r.over ? "+" : "-"}{usdMv(Math.abs(r.rep - edge))} {r.over ? "above high" : "below low"}
          </div>
          <div className="t up rp-out" style={{ left: `${P(r.rep)}%` }}><small>reported</small>{usdMv(r.rep)}</div>
        </>
      ) : (
        <div className="t up" style={{ left: `${P(r.rep)}%` }}><small>reported nav</small>{usdMv(r.rep)}</div>
      )}
    </div>
  );
}

export function MiniRange({ r }: { r: RangeIn }) {
  const a0 = Math.min(r.lo, r.rep), b0 = Math.max(r.hi, r.rep), pad = (b0 - a0) * 0.14;
  const a = a0 - pad, b = b0 + pad, P = (v: number) => ((v - a) / (b - a)) * 100;
  const t = tone(r);
  return (
    <div className="mrng" style={{ ["--bt" as string]: t.bt }}>
      <div className="axis" />
      <div className="band" style={{ left: `${P(r.lo)}%`, width: `${P(r.hi) - P(r.lo)}%` }} />
      <div className="tvl" style={{ left: `${P(r.tv)}%` }} />
      <div className={`rep${r.inside ? "" : " out"}`} style={{ left: `${P(r.rep)}%` }} />
      <div className="t" style={{ left: `${P(r.lo)}%` }}>{usdMv(r.lo)}</div>
      <div className="t" style={{ left: `${P(r.hi)}%` }}>{usdMv(r.hi)}</div>
      <div className={`t rp${r.inside ? "" : " out"}`} style={{ left: `${P(r.rep)}%` }}>rep {usdMv(r.rep)}</div>
    </div>
  );
}

export function ScoreRing({ score }: { score: number }) {
  const C = 100, R = 76, SW = 10, circ = 2 * Math.PI * R, len = (circ * score) / 100;
  return (
    <svg viewBox="0 0 200 200" width={200} height={200} aria-hidden="true">
      {Array.from({ length: 100 }, (_, i) => {
        const a = (i / 100) * Math.PI * 2 - Math.PI / 2, major = i % 10 === 0, l = major ? 7 : 4, r1 = 92;
        return (
          <line key={i} x1={C + Math.cos(a) * r1} y1={C + Math.sin(a) * r1} x2={C + Math.cos(a) * (r1 + l)} y2={C + Math.sin(a) * (r1 + l)}
            stroke={major ? "#5b7287" : "#c3d1dc"} strokeWidth={major ? 1.6 : 1.2} />
        );
      })}
      <circle cx={C} cy={C} r={R} fill="#fff" stroke="#e3edf4" strokeWidth={SW} />
      <circle cx={C} cy={C} r={R} fill="none" stroke="var(--bandc)" strokeWidth={SW} strokeDasharray={`${len} ${circ}`}
        transform={`rotate(-90 ${C} ${C})`} className="arc" style={{ ["--len" as string]: len }} />
      <g className="arcdot" style={{ transform: `rotate(${(score / 100) * 360}deg)` }}>
        <circle cx={C} cy={C - R} r={4.6} fill="#fff" stroke="var(--bandc)" strokeWidth={2.4} />
      </g>
    </svg>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const run = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    run();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function ScoreHistory({ points, color, labelBelow }: { points: HistoryPoint[]; color: string; labelBelow: boolean }) {
  const [ref, { w: W, h: H }] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const L = 34, Rr = 14, T = 12, B = 24;
  const ok = W > 0 && H > 0 && n > 1;
  const pw = W - L - Rr, ph = H - T - B;
  const X = (i: number) => L + (i * pw) / (n - 1), Y = (v: number) => T + ph * (1 - v / 100);
  const pts = points.map((p, i) => [X(i), Y(p.score)] as const);
  let d = "";
  if (ok) {
    d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2, k = 0.18;
      d += ` C${p1[0] + (p2[0] - p0[0]) * k} ${p1[1] + (p2[1] - p0[1]) * k}, ${p2[0] - (p3[0] - p1[0]) * k} ${p2[1] - (p3[1] - p1[1]) * k}, ${p2[0]} ${p2[1]}`;
    }
  }
  const last = n - 1;
  return (
    <div className="chartbox" ref={ref}>
      {ok ? (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Score history, example data, latest ${points[last].score}`}>
          <defs>
            <linearGradient id="hist-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity={0.12} />
              <stop offset="1" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <rect x={L} width={W - L - Rr} y={Y(v) - (v === 0 ? 1 : 0.5)} height={v === 0 ? 2 : 1} fill={v === 0 ? "#c3d0db" : "#edf2f6"} />
              <text x={L - 8} y={Y(v) + 3.5} textAnchor="end" className="ax">{v}</text>
            </g>
          ))}
          {points.map((p, i) => (
            <text key={p.label} x={X(i)} y={H - 6} textAnchor="middle" className={`ax${i === last ? " now" : ""}`}>{p.label}</text>
          ))}
          <path d={`${d} L${pts[last][0]} ${Y(0)} L${pts[0][0]} ${Y(0)} Z`} fill="url(#hist-fill)" className="cfill" />
          <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" className="cline" pathLength={1} style={{ strokeDasharray: 1 }} />
          {pts.map((p, i) => (
            <g key={i} className="cdot" style={{ ["--i" as string]: i }}>
              {i === last ? <circle cx={p[0]} cy={p[1]} r={9} fill="none" stroke={color} strokeWidth={1.5} opacity={0.45} /> : null}
              <circle cx={p[0]} cy={p[1]} r={i === last ? 5 : 3.6} fill={i === last ? color : "#fff"} stroke={i === last ? "#fff" : color} strokeWidth={2} />
              <circle cx={p[0]} cy={p[1]} r={14} fill="transparent" style={{ cursor: "crosshair" }}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          ))}
          <text x={pts[last][0] - 12} y={pts[last][1] + (labelBelow ? 20 : -12)} textAnchor="end" className="lastv" fill={color}>{points[last].score}</text>
        </svg>
      ) : null}
      {hover !== null && ok ? (
        <div className="tip" style={{ left: pts[hover][0], top: pts[hover][1] }}>
          {points[hover].label} · {points[hover].score} · {points[hover].source === "fixture" ? "fixture receipt" : "example"}
        </div>
      ) : null}
    </div>
  );
}
