import { createElement as h } from "react";
import { bpsToPct, formatUsdFromCents } from "./format.mjs";
import { Empty, Panel } from "./ui.mjs";

export function ExposurePanel({ exposures, concentration, outOfSync }) {
  if (outOfSync) return h(Panel, { title: "Exposure", mix: "live", note: outOfSync }, h(Empty, null, outOfSync));
  if (!exposures) return h(Panel, { title: "Exposure" }, h(Empty, null, "No exposure rows."));
  const blocks = [
    ["Asset type", exposures.by_asset_type, "computed"],
    ["Geography", exposures.by_geography, "demo"],
    ["Sector", exposures.by_sector, "demo"],
    ["Lien", exposures.by_lien, "demo"],
    ["Vintage", exposures.by_vintage_quarter, "demo"],
    ["Maturity", exposures.by_maturity_bucket, "demo"],
    ["Delinquency", exposures.by_delinquency, "computed"],
  ];
  return h(Panel, {
    id: "tn-exposure",
    title: "Exposure",
    mix: "Live chain data + demo detail",
    note: "Asset type and delinquency use the fixture book. Geography, sector, lien, vintage and maturity use demo fields.",
  },
  h("div", { className: "tn-grid" }, blocks.map(([title, block, mix]) => h("div", { className: "tn-span-4", key: title },
    h(SplitBars, { title, block, mix })))),
  concentration ? h("p", { className: "tn-note" },
    `Engine concentration (flag only, no score impact): largest obligor ${(concentration.largestShare * 100).toFixed(1)}%, top five ${(concentration.topFiveShare * 100).toFixed(1)}%. ${concentration.reference || ""}`) : null,
  exposures.hhi ? h("p", { className: "tn-note" }, `Demo HHI by borrower alias: ${exposures.hhi.value.toFixed(3)}.`) : null);
}

function SplitBars({ title, block, mix }) {
  const parts = block && block.parts ? block.parts : [];
  return h("div", null,
    h("h3", null, title, " ", h("span", { className: `tn-chip ${mix}` }, mix)),
    parts.length ? parts.map((p) => h("div", { key: p.key, style: { marginBottom: "8px" } },
      h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "12px" } },
        h("span", null, p.key),
        h("span", { className: "tn-num" }, `${(p.share * 100).toFixed(1)}%`)),
      h("div", { className: "tn-bar" }, h("span", { style: { width: `${Math.max(2, p.share * 100)}%` } })))) : h(Empty, null, "No rows."));
}

export function CashFlowPanel({ cashFlows, claimedVsSettled, outOfSync }) {
  if (outOfSync) return h(Panel, { title: "Cash flows", note: outOfSync }, h(Empty, null, outOfSync));
  const rows = cashFlows && cashFlows.monthly ? cashFlows.monthly.slice(-8) : [];
  const max = Math.max(1, ...rows.map((r) => Number(r.scheduled_interest_cents) || 0));
  return h(Panel, {
    id: "tn-cash",
    title: "Cash flows",
    mix: "demo",
    note: cashFlows && cashFlows.rule,
  },
  rows.length ? h("div", null, rows.map((r) => h("div", { key: r.month, style: { display: "grid", gridTemplateColumns: "72px 1fr 140px", gap: "8px", alignItems: "center", marginBottom: "6px" } },
    h("span", { className: "tn-mono" }, r.month),
    h("div", { className: "tn-bar", title: "scheduled vs received" },
      h("span", { style: { width: `${(Number(r.received_cents) / max) * 100}%`, background: "#2fbf71" } })),
    h("span", { className: "tn-num" }, `short ${formatUsdFromCents(r.shortfall_cents)}`)))) : h(Empty, null, "No cash flow months."),
  claimedVsSettled ? h("p", { className: "tn-note" },
    `Claimed vs bank-settled (${claimedVsSettled.source || "cash-flow engine"}): match ${bpsToPct(claimedVsSettled.cash_match_bps)}, never settled ${formatUsdFromCents(claimedVsSettled.claimed_not_settled_cents)}.`) : null);
}

export function StressPanel({ scenarios = [], outOfSync }) {
  if (outOfSync) return h(Panel, { title: "Stress", note: outOfSync }, h(Empty, null, outOfSync));
  return h(Panel, {
    id: "tn-stress",
    title: "Stress",
    mix: "computed (demo)",
    note: "These runs are not a score change on chain. Reported NAV is the fixture headline.",
  },
  h("table", { className: "tn-table" },
    h("thead", null, h("tr", null,
      h("th", null, "Scenario"),
      h("th", { className: "num" }, "TrueVal"),
      h("th", { className: "num" }, "TrueRange"),
      h("th", null, "Reported NAV"))),
    h("tbody", null, scenarios.map((s) => h("tr", { key: s.id },
      h("td", null, h("div", null, s.label), h("div", { className: "tn-note" }, s.rule)),
      h("td", { className: "num tn-num" }, formatUsdFromCents(s.true_val_cents)),
      h("td", { className: "num tn-num" }, formatUsdFromCents(s.true_range_cents)),
      h("td", null, h(SourceChipText, { where: s.reported_nav_vs_range })))))),
  h(StressChart, { scenarios }));
}

function SourceChipText({ where }) {
  const label = where === "above" ? "above the range" : where === "below" ? "below the range" : "inside the range";
  const cls = where === "inside" ? "green" : "red";
  return h("span", { className: `tn-chip ${cls}` }, label);
}

function StressChart({ scenarios }) {
  const width = 640;
  const height = 160;
  const rows = scenarios.filter((s) => s.true_val_cents);
  if (!rows.length) return null;
  const vals = rows.flatMap((s) => {
    const tv = Number(s.true_val_cents);
    const tr = Number(s.true_range_cents);
    return [tv - tr, tv + tr, Number(s.reported_nav_cents)];
  });
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (c) => 8 + ((Number(c) - lo) / (hi - lo || 1)) * (width - 16);
  const band = 14;
  return h("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img", "aria-label": "TrueRange under each stress scenario" },
    rows.map((s, i) => {
      const y = 18 + i * 22;
      const tv = Number(s.true_val_cents);
      const tr = Number(s.true_range_cents);
      return h("g", { key: s.id },
        h("rect", { x: x(tv - tr), y, width: Math.max(2, x(tv + tr) - x(tv - tr)), height: band, fill: "#4cc2ff", opacity: "0.25" }),
        h("line", { x1: x(s.reported_nav_cents), x2: x(s.reported_nav_cents), y1: y - 2, y2: y + band + 2, stroke: "#f0524f", "stroke-width": "1.5" }));
    }));
}

export function NavHistoryChart({ points = [], outOfSync }) {
  if (outOfSync) return h(Panel, { title: "NAV vs TrueRange", note: outOfSync }, h(Empty, null, outOfSync));
  const live = points.filter((p) => p.true_val_cents);
  const last = live[live.length - 1];
  return h(Panel, {
    id: "tn-nav-history",
    title: "NAV vs TrueRange",
    mix: "recorded + demo",
    note: "The last point is the engine certificate pin. Earlier TrueVal marks are a demo backfill, not certified. Confirm the last point with get_latest_certificate before calling it live.",
  },
  h(HistorySvg, { points, last }),
  last ? h("p", { className: "tn-note" },
    `Latest reported ${formatUsdFromCents(last.reported_nav_cents)}, TrueVal ${formatUsdFromCents(last.true_val_cents)}, TrueRange ${formatUsdFromCents(last.true_range_cents)}.`) : h(Empty, null, "No history."));
}

function HistorySvg({ points, last }) {
  if (!points.length) return null;
  const width = 720;
  const height = 220;
  const pad = 28;
  const nums = points.flatMap((p) => [Number(p.reported_nav_cents), Number(p.demo_true_val_cents || p.true_val_cents || 0)].filter((n) => n > 0));
  if (last) {
    nums.push(Number(last.true_val_cents) - Number(last.true_range_cents), Number(last.true_val_cents) + Number(last.true_range_cents));
  }
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const x = (i) => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
  const y = (c) => height - pad - ((Number(c) - lo) / (hi - lo || 1)) * (height - pad * 2);
  const reported = points.map((p, i) => `${x(i)},${y(p.reported_nav_cents)}`).join(" ");
  const backfill = points.filter((p) => p.demo_true_val_cents).map((p) => {
    const i = points.indexOf(p);
    return `${x(i)},${y(p.demo_true_val_cents)}`;
  }).join(" ");
  const lastI = points.length - 1;
  return h("svg", { className: "chartbox", viewBox: `0 0 ${width} ${height}`, width: "100%", role: "img", "aria-label": "Reported NAV and demo TrueVal backfill" },
    h("polyline", { fill: "none", stroke: "#4cc2ff", "stroke-width": "1.5", points: reported }),
    backfill ? h("polyline", { fill: "none", stroke: "#e8b53a", "stroke-width": "1.5", "stroke-dasharray": "4 4", points: backfill }) : null,
    last ? h("rect", {
      x: x(lastI) - 6,
      y: y(Number(last.true_val_cents) + Number(last.true_range_cents)),
      width: 12,
      height: Math.max(2, y(Number(last.true_val_cents) - Number(last.true_range_cents)) - y(Number(last.true_val_cents) + Number(last.true_range_cents))),
      fill: "#4cc2ff",
      opacity: "0.25",
    }) : null,
    points.map((p, i) => h("text", { key: p.month, x: x(i), y: height - 8, fill: "#8a96a8", "font-size": "10", "text-anchor": "middle" }, p.month.slice(2))));
}
