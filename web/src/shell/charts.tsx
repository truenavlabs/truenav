// Hand-drawn SVG charts (no chart dependency). One idea per chart, direct labels, thin lines.
import { useState } from "react";
import { usdM, when, fundName } from "./fmt";

type FundRow = { fund_id: string; band: string | null; score: number | null; range: { low: number; high: number; trueVal: number | null } | null; headline: number | null; policy: number | null; headlinePosition: string | null };
const bandColor = (b: string | null) => (b === "green" ? "var(--green)" : b === "yellow" ? "var(--yellow)" : b === "red" ? "var(--red)" : "var(--muted)");

/** One row per fund: TrueRange as a shaded band, TrueVal tick, policy NAV ring, reported NAV diamond (red when outside). */
export function NavRangeChart({ funds, height = 64 }: { funds: FundRow[]; height?: number }) {
  const rows = funds.filter((f) => f.range && f.headline !== null);
  if (!rows.length) return <p className="dim">No certificate to draw.</p>;
  const W = 760, L = 150, R = 30, rowH = height, H = rows.length * rowH + 34;
  return (
    <div className="chartbox">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Reported NAV against TrueRange per fund">
        {rows.map((f, i) => {
          const r = { ...f.range!, trueVal: f.range!.trueVal ?? 0 }, rep = f.headline!, pol = f.policy ?? rep;
          const lo = Math.min(r.low, rep, pol), hi = Math.max(r.high, rep, pol), pad = (hi - lo) * 0.18 || 1;
          const a = lo - pad, b = hi + pad, X = (v: number) => L + ((v - a) / (b - a)) * (W - L - R);
          const y = 18 + i * rowH, mid = y + rowH / 2 - 6, out = f.headlinePosition !== "inside";
          return (
            <g key={f.fund_id}>
              <text x={0} y={mid - 6} className="axl">{fundName(f.fund_id)}</text>
              <text x={0} y={mid + 10} className="ax" fill={bandColor(f.band)} style={{ fill: bandColor(f.band) }}>score {f.score ?? "n/a"} {f.band}</text>
              <line x1={L} x2={W - R} y1={mid} y2={mid} stroke="var(--border2)" strokeWidth={1} />
              <rect x={X(r.low)} width={Math.max(2, X(r.high) - X(r.low))} y={mid - 10} height={20} rx={3} fill={out ? "rgba(240,82,79,.14)" : "rgba(47,191,113,.16)"} stroke={out ? "rgba(240,82,79,.45)" : "rgba(47,191,113,.45)"} />
              <line x1={X(r.trueVal)} x2={X(r.trueVal)} y1={mid - 14} y2={mid + 14} stroke="var(--text)" strokeWidth={2} />
              <text x={X(r.low)} y={mid + 26} className="ax" textAnchor="middle">{usdM(r.low)}</text>
              <text x={X(r.high)} y={mid + 26} className="ax" textAnchor="middle">{usdM(r.high)}</text>
              <text x={X(r.trueVal)} y={mid - 18} className="ax" textAnchor="middle">TrueVal {usdM(r.trueVal)}</text>
              {f.policy !== null && f.policy !== rep ? <circle cx={X(pol)} cy={mid} r={4.5} fill="none" stroke="var(--cmp)" strokeWidth={1.6}><title>Policy NAV {usdM(pol)}</title></circle> : null}
              <rect x={X(rep) - 6} y={mid - 6} width={12} height={12} transform={`rotate(45 ${X(rep)} ${mid})`} fill={out ? "var(--red)" : "var(--bg)"} stroke={out ? "var(--red)" : "var(--text)"} strokeWidth={2} />
              <text x={X(rep) + (out ? 10 : 0)} y={out ? mid + 4 : mid - 18} dx={out ? 4 : 0} className="ax" textAnchor={out ? "start" : "middle"} style={{ fill: out ? "var(--red)" : undefined }}>
                {out ? `reported ${usdM(rep)}, ${f.headlinePosition} range` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="lgd">
        <span><i style={{ background: "rgba(47,191,113,.4)" }} />TrueRange</span>
        <span><i style={{ background: "var(--text)", width: 3 }} />TrueVal</span>
        <span><i style={{ background: "var(--bg)", border: "2px solid var(--text)", transform: "rotate(45deg)" }} />Reported NAV (red when outside)</span>
        <span><i style={{ border: "1.6px solid var(--cmp)", borderRadius: "50%" }} />Policy NAV</span>
      </div>
    </div>
  );
}

type Ev = { at: number; kind: string; text: string; fund_id?: string | null };
const KIND_COLOR: Record<string, string> = { pledge: "var(--cyan)", verdict: "var(--green)", certificate: "var(--cmp)", blocked: "var(--red)", signer: "var(--yellow)" };
export const KIND_LABEL: Record<string, string> = { pledge: "Pledge", verdict: "Verdict", certificate: "Certificate", blocked: "Refused pledge", signer: "TEE signer" };

/** Swimlane timeline of real on-chain events. */
export function ActivityChart({ events }: { events: Ev[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!events.length) return <p className="dim">No activity.</p>;
  const kinds = ["pledge", "verdict", "certificate", "blocked", "signer"].filter((k) => events.some((e) => e.kind === k));
  const t0 = Math.min(...events.map((e) => e.at)), t1 = Math.max(...events.map((e) => e.at));
  const W = 760, L = 108, R = 16, lane = 26, H = kinds.length * lane + 36;
  const X = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  return (
    <div className="chartbox">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="On-chain activity timeline">
        {kinds.map((k, i) => (
          <g key={k}>
            <text x={0} y={18 + i * lane + 4} className="axl">{KIND_LABEL[k]}</text>
            <line x1={L} x2={W - R} y1={18 + i * lane} y2={18 + i * lane} stroke="var(--border)" />
          </g>
        ))}
        {ticks.map((t, i) => <text key={i} x={X(t)} y={H - 4} className="ax" textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>{when(t)}</text>)}
        {events.map((e, i) => {
          const y = 18 + kinds.indexOf(e.kind) * lane;
          return (
            <circle key={i} cx={X(e.at)} cy={y} r={hover === i ? 6 : 4} fill={KIND_COLOR[e.kind]} fillOpacity={0.85} stroke="var(--bg)" strokeWidth={1}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ cursor: "crosshair" }} />
          );
        })}
      </svg>
      {hover !== null ? (
        <div className="tip" style={{ left: `${(X(events[hover].at) / W) * 100}%`, top: `${((18 + kinds.indexOf(events[hover].kind) * lane) / H) * 100}%` }}>
          {when(events[hover].at)} · {events[hover].text}{events[hover].fund_id ? ` · ${fundName(events[hover].fund_id)}` : ""}
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal stacked bars: count per category per row. */
export function StackBars({ rows, keys, colors, labels }: { rows: { label: string; values: Record<string, number> }[]; keys: string[]; colors: string[]; labels: Record<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => keys.reduce((s, k) => s + (r.values[k] || 0), 0)));
  const W = 360, L = 130, H = rows.length * 30 + 6;
  return (
    <div className="chartbox">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Counts by category">
        {rows.map((r, i) => {
          let x = L;
          return (
            <g key={r.label}>
              <text x={0} y={i * 30 + 18} className="axl">{r.label}</text>
              {keys.map((k, j) => {
                const w = ((r.values[k] || 0) / max) * (W - L - 30);
                const el = w > 0 ? (
                  <g key={k}>
                    <rect x={x} y={i * 30 + 6} width={w} height={16} rx={2} fill={colors[j]} />
                    <text x={x + w / 2} y={i * 30 + 18} className="ax" textAnchor="middle" style={{ fill: "#04121c", fontWeight: 700 }}>{r.values[k]}</text>
                  </g>
                ) : null;
                x += w;
                return el;
              })}
            </g>
          );
        })}
      </svg>
      <div className="lgd">{keys.map((k, j) => <span key={k}><i style={{ background: colors[j] }} />{labels[k] ?? k}</span>)}</div>
    </div>
  );
}

/** Score bars with the 60 and 85 band thresholds drawn. */
export function ScoreBars({ funds }: { funds: { fund_id: string; score: number | null; band: string | null }[] }) {
  const W = 360, L = 130, H = funds.length * 30 + 22, X = (v: number) => L + (v / 100) * (W - L - 10);
  return (
    <div className="chartbox">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Score by fund">
        {[60, 85].map((t) => (
          <g key={t}>
            <line x1={X(t)} x2={X(t)} y1={0} y2={H - 16} stroke="var(--border2)" strokeDasharray="3 3" />
            <text x={X(t)} y={H - 4} className="ax" textAnchor="middle">{t}</text>
          </g>
        ))}
        {funds.map((f, i) => (
          <g key={f.fund_id}>
            <text x={0} y={i * 30 + 16} className="axl">{fundName(f.fund_id).replace(" Fund", "")}</text>
            <rect x={L} y={i * 30 + 4} width={X(f.score ?? 0) - L} height={16} rx={2} fill={bandColor(f.band)} />
            <text x={X(f.score ?? 0) + 4} y={i * 30 + 16} className="ax" style={{ fill: "var(--text)" }}>{f.score ?? "n/a"}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
