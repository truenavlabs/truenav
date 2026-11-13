// Home: one viewport, no page scroll. Line field on the left, three tabs and one statement floating on the right,
// a corner index top left (the intro's dot lands on its marker) and a bottom bar with testnet fixture counts.
// Below 1024px the tabs sit in their own scroller above the field; the page itself still does not scroll.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { FIELD, HeroField, STAGE_W, type Fit } from "../components/HeroE";
import { Brand } from "../shell/Brand";
import { A, navigate } from "../ui";
import { counts } from "./facts";

const DESK = 1024;
// Desktop crops the stage to a band around the field and the panel, then fits that band inside the box.
const BAND = { y: 60, h: 620 };

const TABS = [
  {
    href: "/product", label: "Product", sub: "investors and managers",
    aria: "Product: what TrueNav shows investors and lets managers prove",
    icon: <svg viewBox="0 0 20 18" aria-hidden="true"><circle cx="7" cy="9" r="5" /><circle cx="13" cy="9" r="5" /></svg>,
  },
  {
    href: "/technology", label: "Technology", sub: "TEE to receipt",
    aria: "Technology: how private loan data becomes a public receipt on NEAR testnet",
    icon: <svg viewBox="0 0 20 18" aria-hidden="true"><path d="M10 2 2 6l8 4 8-4zM2 10l8 4 8-4M2 13.5l8 4 8-4" /></svg>,
  },
  {
    href: "/verify", label: "Verify", sub: "check a receipt",
    aria: "Verify: open the receipt checker in the app",
    icon: <svg viewBox="0 0 20 18" aria-hidden="true"><path d="M3 9.5 8 14 17 4" /></svg>,
  },
] as const;

function fitFor(w: number, h: number, desk: boolean): Fit {
  if (desk) {
    const s = Math.min(w / STAGE_W, h / BAND.h);
    return { s, ox: (w - STAGE_W * s) / 2, oy: (h - BAND.h * s) / 2 - BAND.y * s };
  }
  const s = Math.max(w / FIELD.w, h / FIELD.h);
  return { s, ox: (w - FIELD.w * s) / 2 - FIELD.x * s, oy: (h - FIELD.h * s) / 2 - FIELD.y * s };
}

export function Home({ freezeAt }: { freezeAt?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<Fit>({ s: 1, ox: 0, oy: 0 });
  const [desk, setDesk] = useState(() => window.innerWidth >= DESK);
  const [hot, setHot] = useState(-1);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const d = window.innerWidth >= DESK;
      setDesk(d);
      setFit(fitFor(el.clientWidth, el.clientHeight, d));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [desk]);

  // The home page is one screen: the document itself never scrolls here.
  useEffect(() => {
    document.documentElement.classList.add("tn-lock");
    return () => document.documentElement.classList.remove("tn-lock");
  }, []);

  // Keys 1 to 3 follow the tabs, unless a modifier is held or focus is in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i >= 0) navigate(TABS[i].href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const vars = { "--s": fit.s, "--ox": fit.ox, "--oy": fit.oy } as CSSProperties;
  const panel = (
    <div className="ld-panel">
      <nav className="ld-tabs" aria-label="Explore TrueNav">
        {TABS.map((t, i) => (
          <A
            key={t.href} href={t.href} className={`ld-tab t${i + 1}`} ariaLabel={t.aria}
            onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(-1)} onFocus={() => setHot(i)} onBlur={() => setHot(-1)}
          >
            <span className="ix mono" aria-hidden="true">{i + 1}</span>
            <span className="ic">{t.icon}</span>
            <span className="tx">{t.label}<small className="mono">{t.sub}</small></span>
            <span className="ct" aria-hidden="true">›</span>
          </A>
        ))}
      </nav>
      <div className="ld-stmt">
        <span className="lbl">truenav</span>
        <h1>
          TrueNav checks tokenized credit funds <b>privately, inside a TEE on NEAR</b>: investors see an independent value next to the
          fund's reported NAV, and managers prove it without exposing their loans.
        </h1>
      </div>
    </div>
  );

  return (
    <div className={`landing ${desk ? "desk" : "mob"}`} style={vars}>
      {desk ? null : (
        <header className="ld-top">
          <span className="ld-mark" data-tn-dot aria-hidden="true" />
          <Brand />
          <A href="/about" className="ld-about mono">About</A>
          <A href="/overview" className="pillbtn sm">Open app <span aria-hidden="true">→</span></A>
        </header>
      )}
      {desk ? (
        <div className="ld-cidx mono" aria-hidden="true">
          <div className="hd"><span className="ld-mark" data-tn-dot />TRUENAV</div>
          {TABS.map((t, i) => (
            <div key={t.href} className={hot === -1 ? "" : hot === i ? "on" : "off"}>[{i + 1}] {t.label}</div>
          ))}
          <div className={hot === -1 ? "" : "off"}><A href="/about">[4] About</A></div>
        </div>
      ) : null}
      {desk ? null : <div className="ld-scroll">{panel}</div>}
      <div className="ld-stage" ref={box}>
        <HeroField fit={fit} freezeAt={freezeAt} />
        {desk ? panel : null}
      </div>
      <footer className="ld-bar">
        {desk ? <Brand /> : null}
        <dl className="ld-counts" aria-label="Testnet fixture counts">
          {counts().map((c) => (
            <div key={c.label} title={`from ${c.source}`}>
              <dt className="mono">{c.label}</dt>
              <dd className="mono">{c.value}</dd>
            </div>
          ))}
        </dl>
        <div className="ld-meta mono">
          <span>testnet fixture counts</span>
          <span>near testnet · synthetic data</span>
        </div>
        {desk ? <A href="/overview" className="pillbtn">Open app <span aria-hidden="true">→</span></A> : null}
      </footer>
    </div>
  );
}
