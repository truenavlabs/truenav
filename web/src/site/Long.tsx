// Long marketing page: dark hero, then a white section with a sticky isometric stack on the left and numbered
// sections on the right. Each stack layer fills solid blue once its section has scrolled up to the reading line.
import { useEffect, useRef, useState, type ReactNode } from "react";

export type LongSection = { id: string; title: string; layer: string; body: ReactNode };

function IsoStack({ layers, reached }: { layers: string[]; reached: number }) {
  // Layer 01 sits at the bottom of the stack and is drawn first, so upper layers overlap it.
  const W = 200, H = 100, GAP = 62, X = 120, TOP = 40, n = layers.length;
  return (
    <svg className="iso" viewBox="0 0 400 360" role="img" aria-label={`Stack of ${n} layers, ${reached + 1} of ${n} in view`}>
      {layers.map((label, i) => {
        const y = TOP + (n - 1 - i) * GAP;
        const d = `M${X} ${y}L${X + W / 2} ${y + H / 2}L${X} ${y + H}L${X - W / 2} ${y + H / 2}Z`;
        return (
          <g key={label} className={`iso-l${i <= reached ? " on" : ""}${i === reached ? " cur" : ""}`}>
            <path d={d} />
            <path className="tick" d={`M${X + W / 2 + 6} ${y + H / 2}H${X + W / 2 + 22}`} />
            <text x={X + W / 2 + 28} y={y + H / 2 + 4} className="mono">{String(i + 1).padStart(2, "0")} {label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function LongPage({ hero, sections, after }: { hero: ReactNode; sections: LongSection[]; after?: ReactNode }) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const [reached, setReached] = useState(0);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      let r = 0;
      refs.current.forEach((el, i) => {
        if (el && el.getBoundingClientRect().top < window.innerHeight * 0.55) r = i;
      });
      setReached(r);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return (
    <>
      <section className="lp-hero">{hero}</section>
      <section className="lp-wrap">
        <div className="lp-body">
          <div className="lp-art">
            <div className="lp-sticky">
              <IsoStack layers={sections.map((s) => s.layer)} reached={reached} />
            </div>
          </div>
          <div className="lp-secs">
            {sections.map((s, i) => (
              <article key={s.id} id={s.id} ref={(el) => { refs.current[i] = el; }} className={`lp-sec${i <= reached ? " on" : ""}`}>
                <div className="lp-n mono" aria-hidden="true">{String(i + 1).padStart(2, "0")}</div>
                <div className="lp-c">
                  <h2>{s.title}</h2>
                  {s.body}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
      {after}
    </>
  );
}
