// Guided product tour: one place on screen is lit, a popover points at it, and the rest is dimmed. Info steps move
// on with Next. Action steps name one real thing to click and move on by themselves once the click has had its effect.
// Skip tutorial, Esc and Finish store a flag so the tour does not start again. The step lives in the URL (?tour=N).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { KNOWN_TXS } from "../../data/tx.mjs";
import { navigate, usePath } from "../ui";
import { txUrl } from "./fmt";
import { useRegistry } from "./store";
import { placePopover, type Box, type Placed } from "./tour-place";
import { TOUR_KEY, TOUR_STEPS, parseTour, pathnameOf, shouldAutoStart, tourHref, tourStart, type TourStep } from "./tour-steps";

export { tourStart };

const NARROW = "(max-width: 1100px)";
const PAD = 6;
const ADVANCE_MS = 450;

const store = {
  get: () => { try { return window.localStorage.getItem(TOUR_KEY); } catch { return null; } },
  set: (v: string) => { try { window.localStorage.setItem(TOUR_KEY, v); } catch { /* private mode: the tour may start again */ } },
};
function replace(href: string) {
  window.history.replaceState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
};
const sameBox = (a: Box | null, b: Box | null) => !!a && !!b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

function targetOf(step: TourStep, narrow: boolean): Element | null {
  const sel = narrow && step.mobileTarget ? step.mobileTarget : step.target;
  const el = document.querySelector(sel);
  if (el && visible(el)) return el;
  const after = step.done?.kind === "exists" ? document.querySelector(step.done.selector) : null; // the click already worked: point at its result
  return after && visible(after) ? after : null;
}

export function Tour() {
  const path = usePath();
  const { loading, reg } = useRegistry();
  const readAt = reg?.readAt ?? null;
  const n = parseTour(path);
  const step = n ? TOUR_STEPS[n - 1] : null;
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [box, setBox] = useState<Box | null>(null);
  const [found, setFound] = useState<"wait" | "yes" | "no">("wait");
  const [size, setSize] = useState({ w: 340, h: 240 });
  const popRef = useRef<HTMLElement>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const clicked = useRef(false);
  const sawLoading = useRef(false);
  const readAtAtClick = useRef<string | null>(null);
  const readAtRef = useRef<string | null>(null);
  readAtRef.current = readAt;

  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // first visit: start once on the app home, unless it was switched off or already seen
  useEffect(() => {
    if (step) return;
    if (shouldAutoStart({ pathname: pathnameOf(window.location.pathname), search: window.location.search, stored: store.get() })) {
      store.set("started");
      replace(tourStart());
    }
  }, [step]);

  const go = useCallback((k: number) => {
    if (k < 1 || k > TOUR_STEPS.length) return;
    navigate(tourHref(TOUR_STEPS[k - 1].path, k));
  }, []);
  const stop = useCallback(() => {
    store.set("dismissed");
    const u = new URL(window.location.href);
    u.searchParams.delete("tour");
    replace(u.pathname + u.search);
  }, []);

  // find the target, scroll it into view, keep its box current
  useEffect(() => {
    if (!step) return;
    setBox(null);
    setFound("wait");
    clicked.current = false;
    sawLoading.current = false;
    let el: Element | null = null;
    let last: Box | null = null;
    let tries = 0;
    let raf = 0;
    let lastSeen = 0;
    const mark = (next: Element | null) => {
      if (next === el) return;
      document.querySelectorAll(".tour-hl").forEach((x) => { x.classList.remove("tour-hl"); x.removeAttribute("data-tour-hl"); });
      el = next;
      if (el) {
        el.classList.add("tour-hl");
        el.setAttribute("data-tour-hl", "");
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" as ScrollBehavior }); // reveals it inside a scrolling box
        // then put the target high enough that the popover fits under it: the target and the card are centred as one block
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const block = r.height + 14 + sizeRef.current.h + 16;
        const top = block <= vh - 76 ? 70 + (vh - 76 - block) / 2 : 76;
        window.scrollBy(0, r.top - top);
        setFound("yes");
      }
    };
    const tick = () => {
      const now = performance.now();
      const cur = targetOf(step, window.matchMedia(NARROW).matches);
      if (cur) { mark(cur); lastSeen = now; if (!cur.classList.contains("tour-hl")) cur.classList.add("tour-hl"); } // a re-render can reset the class
      else if (el && !el.isConnected && now - lastSeen > 1500) { mark(null); setFound("no"); }
      else if (!el && ++tries > 50) setFound("no");
      if (el && el.isConnected) {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const l = Math.max(r.left - PAD, 4), t = Math.max(r.top - PAD, 4);
        const b: Box = { left: l, top: t, width: Math.max(Math.min(r.right + PAD, vw - 4) - l, 0), height: Math.max(Math.min(r.bottom + PAD, vh - 4) - t, 0) };
        if (!sameBox(last, b)) { last = b; setBox(b); }
      }
      raf = window.setTimeout(tick, tries < 50 ? 100 : 160) as unknown as number;
    };
    raf = window.setTimeout(tick, 60) as unknown as number; // after the popover for this step has been measured
    const onResize = () => { last = null; };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(raf);
      window.removeEventListener("resize", onResize);
      document.querySelectorAll(".tour-hl").forEach((x) => { x.classList.remove("tour-hl"); x.removeAttribute("data-tour-hl"); });
    };
  }, [step, path.split("?")[0]]);

  // action steps: the click on the target, then the expected change, then on to the next step
  useEffect(() => {
    if (!step || step.kind !== "action" || !step.done) return;
    const done = step.done;
    let timer = 0;
    const advance = () => { if (!timer) timer = window.setTimeout(() => go(n + 1), ADVANCE_MS); };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const sel = narrow && step.mobileTarget ? step.mobileTarget : step.target;
      if (!t || !t.closest(sel)) return;
      clicked.current = true;
      sawLoading.current = false;
      readAtAtClick.current = readAtRef.current;
      if (done.kind === "path" && !e.defaultPrevented && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        go(n + 1);
      }
    };
    document.addEventListener("click", onClick, true);
    const poll = done.kind === "exists" ? window.setInterval(() => { if (clicked.current && document.querySelector(done.selector)) advance(); }, 100) : 0;
    return () => { document.removeEventListener("click", onClick, true); window.clearInterval(poll); window.clearTimeout(timer); };
  }, [step, n, narrow, go]);
  useEffect(() => {
    if (!step || step.done?.kind !== "reread" || !clicked.current) return;
    if (loading) { sawLoading.current = true; return; }
    // the read finished: either this click started one, or one that was already running ended after the click and stored a new read
    if (sawLoading.current || readAt !== readAtAtClick.current) { const t = window.setTimeout(() => go(n + 1), ADVANCE_MS); return () => window.clearTimeout(t); }
  }, [loading, readAt, step, n, go]);

  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); stop(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step, stop]);

  // focus moves into the popover on every step
  useEffect(() => { if (step && found !== "wait") popRef.current?.focus({ preventScroll: true }); }, [step, found]);
  useLayoutEffect(() => {
    const r = popRef.current?.getBoundingClientRect();
    if (r && (Math.abs(r.width - size.w) > 0.5 || Math.abs(r.height - size.h) > 0.5)) setSize({ w: r.width, h: r.height });
  });

  if (!step) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const placed: Placed | null = found === "yes" && box ? placePopover(box, size, { w: vw, h: vh }) : null;
  const fallback = found === "no" || (found === "yes" && !!placed && placed.side === "over");
  const pos = placed && !fallback ? placed : { side: "over" as const, left: Math.max(8, vw - size.w - 16), top: Math.max(8, vh - size.h - 16), arrow: 0 };
  const last = n === TOUR_STEPS.length;
  const tx = step.link?.tx ? txUrl(KNOWN_TXS[step.link.tx].hash) : null;
  const spot = found === "yes" && box ? box : null;
  const pane = (k: string, s: React.CSSProperties) => <div key={k} className="tour-pane" style={s} aria-hidden="true" />;
  return (
    <>
      <div className="tour-layer" data-testid="tour-layer">
        {spot && !fallback ? (
          <>
            {pane("t", { left: 0, top: 0, width: "100vw", height: spot.top })}
            {pane("b", { left: 0, top: spot.top + spot.height, width: "100vw", height: Math.max(vh - spot.top - spot.height, 0) })}
            {pane("l", { left: 0, top: spot.top, width: spot.left, height: spot.height })}
            {pane("r", { left: spot.left + spot.width, top: spot.top, width: Math.max(vw - spot.left - spot.width, 0), height: spot.height })}
            {step.kind === "info" ? pane("c", { left: spot.left, top: spot.top, width: spot.width, height: spot.height, background: "transparent" }) : null}
            <div className="tour-spot" style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }} aria-hidden="true" />
          </>
        ) : pane("all", { left: 0, top: 0, width: "100vw", height: "100vh" })}
      </div>
      <aside
        ref={popRef} tabIndex={-1} className="tour" role="dialog" aria-label="Product tour" aria-describedby="tour-body" data-side={pos.side} data-step={step.id} data-kind={step.kind}
        style={{ left: pos.left, top: pos.top, visibility: found === "wait" ? "hidden" : "visible" }}
      >
        {pos.side !== "over" ? <i className={`tour-arrow a-${pos.side}`} style={pos.side === "top" || pos.side === "bottom" ? { left: pos.arrow } : { top: pos.arrow }} aria-hidden="true" /> : null}
        <div className="tour-h">
          <span className="mono dim">Step {n} of {TOUR_STEPS.length}</span>
          <button className="linkbtn" onClick={stop} aria-label="Skip the tutorial">Skip tutorial</button>
        </div>
        <div className="tour-bar" role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={TOUR_STEPS.length} aria-valuenow={n}><i style={{ width: `${(n / TOUR_STEPS.length) * 100}%` }} /></div>
        <h3>{step.title}</h3>
        <p id="tour-body">{step.body}{tx ? <> <a href={tx} target="_blank" rel="noopener noreferrer">{step.link!.label}</a>.</> : null}</p>
        {step.kind === "action" ? <p className="tour-act"><span className="mono">Your turn</span> {step.act}</p> : null}
        <div className="hrow between">
          <button className="xb sm ghost" onClick={() => go(n - 1)} disabled={n === 1} aria-label="Previous step">Back</button>
          {last
            ? <button className="xb sm" onClick={stop} aria-label="Finish the tour">Finish</button>
            : <button className={`xb sm${step.kind === "action" ? " ghost" : ""}`} onClick={() => go(n + 1)} aria-label="Next step">Next</button>}
        </div>
      </aside>
    </>
  );
}
