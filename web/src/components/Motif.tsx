import { useEffect, useRef } from "react";
import { rng, svgEl } from "../lib/motion";

type FlowOpts = { n?: number; seed?: number; amp?: number; y0?: number; fade?: number; op?: number };
const COLS = ["#64c5fd", "#0aa0f0", "#0a7fc0", "#9fd8fb"];

// Soft line field that fades in from the left. Used behind title strips and explainer cards.
function drawFlow(svg: SVGSVGElement, w: number, h: number, { n = 16, seed = 3, amp = 26, y0 = 0.5, fade = 0.45, op = 0.5 }: FlowOpts) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const id = `mf${seed}x${w}`;
  const defs = svgEl("defs", {}, svg);
  const g = svgEl("linearGradient", { id: id + "g", x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
  [[0, 0], [fade, 0], [Math.min(1, fade + 0.25), 1], [1, 1]].forEach(([o, a]) =>
    svgEl("stop", { offset: o, "stop-color": "#fff", "stop-opacity": a }, g),
  );
  const mk = svgEl("mask", { id: id + "m", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: w, height: h }, defs);
  svgEl("rect", { x: 0, y: 0, width: w, height: h, fill: `url(#${id}g)` }, mk);
  const grp = svgEl("g", { mask: `url(#${id}m)` }, svg);
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const ph = r() * 6.28, f1 = 0.004 + r() * 0.004, f2 = 0.011 + r() * 0.006, a1 = amp * (0.5 + r() * 0.7), a2 = amp * 0.3 * r();
    const base = h * y0 + (i - n / 2) * ((h * 0.5) / n) + (r() - 0.5) * 6;
    let d = "";
    for (let x = 0; x <= w; x += 6) {
      const y = base + Math.sin(x * f1 + ph) * a1 + Math.sin(x * f2 + ph * 2) * a2;
      d += (x ? "L" : "M") + x + " " + y.toFixed(2);
    }
    svgEl("path", { d, fill: "none", stroke: COLS[i % COLS.length], "stroke-width": i % 7 === 0 ? 2 : 1.5, opacity: op * (0.55 + r() * 0.45), "vector-effect": "non-scaling-stroke" }, grp);
  }
}

// Lines that bend around a circle, as in the hero card. Used behind the score ring.
function drawWrap(svg: SVGSVGElement, w: number, h: number, cx: number, cy: number, R: number, seed: number, step = 9, op = 0.55) {
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const r = rng(seed), cols = ["#64c5fd", "#0aa0f0", "#0a7fc0", "#9fd8fb", "#64c5fd"];
  let k = 0;
  for (let y0 = -30; y0 < h + 40; y0 += step) {
    const d0 = y0 - cy;
    if (Math.abs(d0) < step * 0.9) continue;
    const sg = Math.sign(d0), ad = Math.abs(d0), ph = r() * 6.28, amp = 1.2 + r() * 1.6;
    let d = "";
    for (let x = -4; x <= w + 4; x += 3) {
      const dx = x - cx, q = Math.max(0, 1 - (dx / R) * (dx / R)), push = q * q * R * R;
      const y = cy + sg * Math.sqrt(ad * ad + push) + Math.sin(x * 0.025 + ph) * amp * (1 - q);
      d += (d ? "L" : "M") + x + " " + y.toFixed(2);
    }
    svgEl("path", { d, fill: "none", stroke: cols[k++ % cols.length], "stroke-width": k % 6 === 0 ? 2 : 1.5, opacity: op * (0.5 + r() * 0.5) }, svg);
  }
}

function useSized(draw: (svg: SVGSVGElement, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    let lw = 0, lh = 0;
    const run = () => {
      const r = svg.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      if (!w || !h || (w === lw && h === lh)) return;
      lw = w; lh = h;
      draw(svg, w, h);
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(svg);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

export function FlowLines({ className = "lines", ...o }: FlowOpts & { className?: string }) {
  const ref = useSized((svg, w, h) => drawFlow(svg, w, h, o), [o.seed, o.n, o.amp, o.fade, o.op, o.y0]);
  return <svg ref={ref} className={className} aria-hidden="true" />;
}

export function WrapLines({ seed, cyOffset, radius = 112 }: { seed: number; cyOffset: number; radius?: number }) {
  const ref = useSized((svg, w, h) => drawWrap(svg, w, h, w / 2, cyOffset, radius, seed), [seed, cyOffset, radius]);
  return <svg ref={ref} className="field" aria-hidden="true" />;
}
