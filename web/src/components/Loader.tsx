// Intro, abstract-ribbon direction. Same ribbon geometry and palette as hero E, on one fixed 11.5 s timeline:
//   0.0 to  1.3  thin guide lines draw left to right, linear
//   1.3 to  2.0  tagline fades in under the lines, ease-out
//   2.5          a faint Skip appears
//   2.8 to  4.5  thick colored lines trace over the guides
//   4.5 to  5.7  hold, nothing moves
//   5.7 to  6.8  text fades out; lines collapse to the center with ease-in, into a short bar, then one blue dot
//   6.8 to  9.8  hold on the dot alone
//   9.8 to 10.3  the dot flies to the top left marker ([data-tn-dot]) with a fast ease-out
//  10.3 to 11.5  the page fades in and slides up slightly, ease-out, while the white backdrop clears
// The ribbon is static (one fixed phase): only drawing, collapse and the dot move.
// Shown once per browser session; skipped entirely under prefers-reduced-motion.
// Review helpers: ?force=1 shows it again, ?lt=SECONDS freezes any frame from 0 to 11.5, ?rm=1 (with force) shows the
// reduced-motion fallback, ?noloader=1 skips it.
import { useEffect, useRef, type RefObject } from "react";
import { clamp, eio, eout, lerp, mix, prefersReducedMotion, ssm, smoothPath, svgEl, type Pt } from "../lib/motion";

const SEEN = "truenav-loader-seen";
export const INTRO = {
  guides: [0, 1.3], tag: [1.3, 2.0], skip: 2.5, thick: [2.8, 4.5], hold: [4.5, 5.7], collapse: [5.7, 6.8],
  dot: [6.8, 9.8], fly: [9.8, 10.3], reveal: [10.3, 11.5],
} as const;
export const INTRO_END = INTRO.reveal[1];

const VW = 480, VH = 220, CYL = 110, N = 16, PH = 0.9, LANE = 0.45, DOT = 14;
const BLUE = "#0aa0f0", GREEN = "#14a86a", RED = "#e5484d";
const ramp = ["#9fb3c4", "#5b87ad", "#0a7fc0", "#0aa0f0", "#64c5fd", "#9fdcff"];
const rampAt = (u: number) => {
  const f = u * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(f));
  return mix(ramp[i], ramp[i + 1], f - i);
};
const SW = [2.5, 3, 3.5, 3, 2.5, 3.5, 3, 2.5];
const ein = (t: number) => Math.pow(clamp(t), 3);
const span = (t: number, [a, b]: readonly [number, number]) => clamp((t - a) / (b - a));
type LL = { i: number; c: number; harbor: boolean; col: string; sw: number; o: number; p?: SVGPathElement };

export function shouldShowLoader(search: string): boolean {
  const q = new URLSearchParams(search);
  if (q.has("force") || q.has("lt")) return true;
  if (q.has("noloader") || prefersReducedMotion()) return false;
  try {
    return !sessionStorage.getItem(SEEN);
  } catch {
    return true;
  }
}

// Where the dot lands: the home corner marker, else the brand glyph, else the top left corner.
function landing(): { x: number; y: number; d: number } {
  const el = document.querySelector<HTMLElement>("[data-tn-dot]") ?? document.querySelector<HTMLElement>(".brand .glyph");
  const r = el?.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return { x: 28, y: 28, d: 10 };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, d: Math.max(6, Math.min(r.width, r.height)) };
}

export function Loader({ ready, app, onDone }: { ready: boolean; app: RefObject<HTMLDivElement | null>; onDone: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const tagRef = useRef<HTMLParagraphElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    const el = root.current!, G = gRef.current!, SVG = svgRef.current!, TAG = tagRef.current!, SKIP = skipRef.current!, DT = dotRef.current!;
    const q = new URLSearchParams(window.location.search);
    const FROZEN = q.has("lt");
    const REDUCED = q.has("rm") || prefersReducedMotion();
    const lines: LL[] = [];
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1), c = u - 0.5, top = i < 8, swap = i === 6 || i === 9, harbor = swap ? !top : top;
      lines.push({ i, c, harbor, col: i === 3 ? GREEN : i === 12 ? RED : rampAt(Math.sin(u * Math.PI * 2.2 + 0.4) * 0.5 + 0.5), sw: SW[i % 8], o: 0 });
    }
    let a = 0, b = 0;
    lines.forEach((l) => { const rank = l.harbor ? a++ : b++; l.o = (rank / 7 - 0.5) * 2; });
    const guides = [0, 3, 6, 9, 12, 15];
    const W = (2 * Math.PI) / 2.8;
    const ribbon = (l: LL, xl: number, ph: number) => {
      const xo = 111 + xl * (978 / VW), k1 = (2 * Math.PI) / 760, k2 = (2 * Math.PI) / 430;
      const am = 150 * (0.55 + 0.45 * Math.cos(l.c * 2.6 + k1 * xo * 0.9 + W * ph));
      const y = am * Math.sin(k1 * xo + l.c * 3.1 + W * ph) + l.c * 210 * Math.cos(k2 * xo - W * ph * 2 + 0.8) * 0.8 + l.c * 190;
      return CYL + y * 0.3;
    };
    const yAt = (l: LL, xl: number, ph: number) => {
      const xn = xl / VW, bump = ssm(0.12, 0.38, xn) * (1 - ssm(0.62, 0.88, xn));
      const lane = (l.harbor ? CYL - 52 : CYL + 52) + l.o * 24;
      return lerp(ribbon(l, xl, ph), lane, LANE * bump);
    };
    G.replaceChildren();
    const gP = guides.map(() => svgEl("path", { stroke: "#64c5fd", "stroke-linecap": "round", pathLength: 1000, fill: "none" }, G));
    [...lines].sort((x, y) => Number(x.i === 3 || x.i === 12) - Number(y.i === 3 || y.i === 12)).forEach((l) => {
      l.p = svgEl("path", { "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1000, fill: "none" }, G);
    });
    // Static shapes: computed once, then only squeezed during the collapse.
    const base = (l: LL, ph: number) => {
      const p: Pt[] = [];
      for (let xl = 4; xl <= VW - 4 + 0.01; xl += 6) p.push([xl, yAt(l, xl, ph)]);
      return p;
    };
    const thickPts = lines.map((l) => base(l, PH));
    const guidePts = guides.map((gi) => base(lines[gi], PH - 0.28));
    const squeeze = (p: Pt[], f: number, sx: number) => p.map(([x, y]): Pt => [VW / 2 + (x - VW / 2) * sx, lerp(y, CYL, f)]);

    let KU = 1, sc = 1;
    const measure = () => {
      const w = SVG.getBoundingClientRect().width || VW;
      KU = w / VW;
      sc = 0.78 + 0.37 * clamp((w - 300) / 260);
    };
    const centre = () => {
      const r = SVG.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + (r.height * CYL) / VH };
    };
    let target: { x: number; y: number; d: number } | null = null;

    const setApp = (p: number | null) => {
      const A = app.current;
      if (!A) return;
      if (p === null) {
        A.style.removeProperty("visibility");
        A.style.removeProperty("opacity");
        A.style.removeProperty("transform");
        return;
      }
      const e = eout(p);
      A.style.visibility = p > 0 ? "visible" : "hidden";
      A.style.opacity = e.toFixed(3);
      A.style.transform = e < 1 ? `translateY(${((1 - e) * 14).toFixed(2)}px)` : "";
    };

    const draw = (t: number) => {
      measure();
      const x = span(t, INTRO.collapse);
      const f = ein(x / 0.7); // vertical collapse, accelerating
      const sx = x < 0.72 ? lerp(1, 0.07, ein(x / 0.72)) : lerp(0.07, 0.004, eio((x - 0.72) / 0.28)); // to a short bar, then a point
      const lineOut = ssm(0.86, 1, x);
      lines.forEach((l, i) => {
        const p = eio((t - INTRO.thick[0] - i * 0.04) / (INTRO.thick[1] - INTRO.thick[0] - (N - 1) * 0.04));
        const w = lerp(l.sw * sc, 4.5 * sc, f);
        l.p!.setAttribute("d", smoothPath(x > 0 ? squeeze(thickPts[i], f, sx) : thickPts[i], 1));
        l.p!.setAttribute("stroke", x > 0 ? mix(l.col, BLUE, f) : l.col);
        l.p!.setAttribute("stroke-width", (Math.max(w, 0.01) / KU).toFixed(3));
        l.p!.setAttribute("stroke-dasharray", "1000 1000");
        l.p!.setAttribute("stroke-dashoffset", (1000 * (1 - p)).toFixed(1));
        l.p!.setAttribute("stroke-opacity", String(p > 0 ? 1 - lineOut : 0));
      });
      const gp = span(t, INTRO.guides); // linear, left to right
      guides.forEach((_, j) => {
        gP[j].setAttribute("stroke-width", (1.25 / KU).toFixed(3));
        gP[j].setAttribute("d", smoothPath(x > 0 ? squeeze(guidePts[j], f, sx) : guidePts[j], 1));
        gP[j].setAttribute("stroke-dasharray", "1000 1000");
        gP[j].setAttribute("stroke-dashoffset", (1000 * (1 - gp)).toFixed(1));
        gP[j].setAttribute("stroke-opacity", (0.7 * (1 - Math.min(1, f * 1.6))).toFixed(3));
      });
      const tin = eout(span(t, INTRO.tag)), tout = 1 - ssm(INTRO.collapse[0], INTRO.collapse[0] + 0.45, t);
      TAG.style.opacity = (tin * tout).toFixed(3);
      TAG.style.transform = `translateY(${((1 - tin) * 6).toFixed(2)}px)`;
      SKIP.style.opacity = (0.5 * ssm(INTRO.skip, INTRO.skip + 0.5, t) * (t < INTRO.fly[0] ? 1 : 1 - span(t, INTRO.fly))).toFixed(3);
      SKIP.style.visibility = t < INTRO.skip || t > INTRO.fly[1] ? "hidden" : "visible";

      // The dot: born as the bar shrinks to a point, held, then flown to the corner marker.
      const born = ssm(0.84, 1, x);
      const fp = eout(span(t, INTRO.fly));
      if (born <= 0) DT.style.opacity = "0";
      else {
        const c = centre();
        if (fp > 0 && !target) target = landing();
        const tg = target ?? { x: c.x, y: c.y, d: DOT };
        const px = lerp(c.x, tg.x, fp), py = lerp(c.y, tg.y, fp), d = lerp(DOT * (0.6 + 0.4 * born), tg.d, fp);
        DT.style.opacity = "1";
        DT.style.transform = `translate(${(px - d / 2).toFixed(2)}px, ${(py - d / 2).toFixed(2)}px)`;
        DT.style.width = DT.style.height = `${d.toFixed(2)}px`;
      }
      // Reveal: the backdrop clears and the page fades in under the landed dot.
      const rp = span(t, INTRO.reveal);
      el.style.backgroundColor = `rgba(255,255,255,${(1 - eout(rp)).toFixed(3)})`;
      el.style.pointerEvents = rp > 0 ? "none" : "";
      setApp(rp > 0 ? rp : 0);
    };

    if (FROZEN) {
      draw(clamp(parseFloat(q.get("lt") || "1.7"), 0, INTRO_END));
      return;
    }

    let raf = 0, done = false, clock = 0, last: number | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      setApp(null);
      try { sessionStorage.setItem(SEEN, "1"); } catch { /* ignore */ }
      onDone();
    };
    // Skip, and the reduced-motion fallback: a short plain fade, no motion.
    const quick = () => {
      if (done) return;
      cancelAnimationFrame(raf);
      raf = 0;
      el.classList.add("rm", "out");
      setApp(1);
      window.setTimeout(finish, 260);
    };
    SKIP.onclick = quick;
    if (REDUCED) {
      draw(INTRO.hold[0]);
      SKIP.style.opacity = "0.5";
      SKIP.style.visibility = "visible";
      const id = window.setTimeout(quick, 700);
      return () => window.clearTimeout(id);
    }
    const frame = (n: number) => {
      if (last !== null) {
        const dt = Math.min(0.05, (n - last) / 1000);
        // Hold at the start of the fly until fonts are ready, so the page never appears half styled.
        if (clock + dt < INTRO.fly[0] || readyRef.current) clock += dt;
      }
      last = n;
      if (clock >= INTRO_END) {
        draw(INTRO_END);
        finish();
        return;
      }
      draw(clock);
      raf = requestAnimationFrame(frame);
    };
    const onVis = () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!done && !raf) { last = null; raf = requestAnimationFrame(frame); }
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [app, onDone]);

  return (
    <div id="tn-loader" ref={root} role="status" aria-live="polite" aria-label="Loading TrueNav">
      <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} aria-hidden="true" focusable="false"><g ref={gRef} /></svg>
      <p className="tag" ref={tagRef}>TrueNav reads a reported figure and checks it.</p>
      <button className="skip" ref={skipRef} type="button">Skip intro</button>
      <div className="tn-dot" ref={dotRef} aria-hidden="true" />
    </div>
  );
}
