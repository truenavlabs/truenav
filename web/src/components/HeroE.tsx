// Hero E line field on its 1280 x 800 stage, without any chrome. The landing page owns layout: it measures its own
// box, picks a fit, and passes it in. Only the lines, the frame and the score card live on the stage.
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/motion";
import { buildHeroE, LOOP, type HeroFund } from "./heroE";
import { scores } from "../data";
import { publicV3 } from "../public";
import { NAMES } from "../copy";

const GREEN = "#14a86a", RED = "#e5484d";
export const STAGE_W = 1280, STAGE_H = 800;
// The framed field on the stage. Layouts crop to this box (mobile) or to a band around it (desktop).
export const FIELD = { x: 111, y: 93, w: 978, h: 550 } as const;

export type Fit = { s: number; ox: number; oy: number };

// Money fields are integer cents. 950000000 cents is $9.50M.
const M = (cents: string) => Number(cents) / 1e8;
const m2 = (cents: string) => "$" + M(cents).toFixed(2) + "M";

// Card values come from the public score fields only. The score is the whole-number public score.
function heroFunds(): [HeroFund, HeroFund] {
  const rows = scores.map(publicV3);
  const pick = (id: string, col: string): HeroFund => {
    const d = rows.find((r) => r.token_id === id)!;
    return {
      name: NAMES[id], score: d.score ?? 0, col,
      val: m2(d.trueval), rep: m2(d.reported_nav),
      res: d.nav_result === "inside" ? "INSIDE RANGE" : "OUTSIDE RANGE",
      lo: m2(d.truerange_low), hi: m2(d.truerange_high),
      lw: M(d.truerange_low), hw: M(d.truerange_high), v: M(d.trueval), r: M(d.reported_nav),
    };
  };
  return [pick("harbor-credit-fund", GREEN), pick("meridian-yield-fund", RED)];
}

export function HeroField({ fit, freezeAt, paused }: { fit: Fit; freezeAt?: number; paused?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const g = useRef<SVGGElement>(null);
  const ov = useRef<SVGGElement>(null);
  const defs = useRef<SVGDefsElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(!!paused);
  pausedRef.current = !!paused;

  useEffect(() => {
    if (!g.current || !ov.current || !defs.current || !card.current) return;
    const gg = g.current, oo = ov.current, dd = defs.current, cc = card.current;
    const scene = buildHeroE(gg, oo, dd, cc, heroFunds());
    let raf = 0;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      gg.replaceChildren();
      oo.replaceChildren();
      dd.querySelectorAll("linearGradient").forEach((n) => n.remove());
      cc.replaceChildren();
    };
    if (freezeAt !== undefined) {
      scene.draw(freezeAt % LOOP);
      return cleanup;
    }
    if (prefersReducedMotion()) {
      scene.draw(10.0);
      return cleanup;
    }
    let last: number | null = null, tt = 0, visible = true;
    const frame = (n: number) => {
      if (last !== null && !pausedRef.current) tt += Math.min(0.05, (n - last) / 1000);
      last = n;
      scene.draw(tt % LOOP);
      raf = requestAnimationFrame(frame);
    };
    const go = () => { if (!raf) { last = null; raf = requestAnimationFrame(frame); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const onVis = () => (document.hidden || !visible ? stop() : go());
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; onVis(); });
    if (box.current) io.observe(box.current);
    document.addEventListener("visibilitychange", onVis);
    go();
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cleanup();
    };
  }, [freezeAt]);

  return (
    <div className="hero-e" ref={box} aria-hidden="true">
      <div className="stage" style={{ transform: `translate(${fit.ox}px, ${fit.oy}px) scale(${fit.s})` }}>
        <svg className="field" viewBox="0 0 1280 800" shapeRendering="geometricPrecision" focusable="false">
          <defs ref={defs}>
            <clipPath id="hero-clip">
              <rect x={FIELD.x} y={FIELD.y} width={FIELD.w} height={FIELD.h} />
            </clipPath>
          </defs>
          <rect x={FIELD.x} y={FIELD.y} width={FIELD.w} height={FIELD.h} fill="#f5f5f5" fillOpacity="0.6" />
          <g clipPath="url(#hero-clip)" ref={g} />
          <g ref={ov} />
        </svg>
        <div className="frame" />
        <div className="hero-card" ref={card} />
      </div>
    </div>
  );
}
