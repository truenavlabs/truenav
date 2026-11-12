// Guided judge tour: 7 short steps across the real pages, no wallet. The step lives in the URL (?tour=N), so a
// reload or a shared link resumes it. Each step highlights one element on the page and says what it proves.
import { useEffect, useMemo, type ReactNode } from "react";
import { A, navigate, usePath } from "../ui";
import { KNOWN_TXS } from "../../data/tx.mjs";
import { usdM, txUrl, fundName } from "./fmt";
import { useRegistry, type Registry } from "./store";

const MERIDIAN = "meridian-yield-fund";
const LOAN = "33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc"; // Meridian M-IN-03

type Step = { path: string; target: string; title: string; secs: number; body: (v: Registry) => ReactNode };

function cert(v: Registry, id: string) {
  const f = v.funds.find((x) => x.fund_id === id);
  return (f?.certificate?.certificate ?? null) as null | { score: number | null; band: string; headline_cents: string; true_val_cents: string; true_range_cents: string };
}

export const TOUR: Step[] = [
  { path: "/overview", target: ".livepill", title: "Live from NEAR testnet", secs: 20, body: (v) => <>{v.funds.length} fictional funds and {v.loans.length} loans, read from the registry on NEAR testnet just now. The pill shows the time of the read and the block height. Click it to read again.</> },
  { path: "/overview", target: "#t-nav", title: "Reported NAV against TrueRange", secs: 20, body: (v) => {
    const c = cert(v, MERIDIAN);
    if (!c) return <>Each fund's reported NAV against the range its loans support.</>;
    const tv = Number(c.true_val_cents), tr = Number(c.true_range_cents);
    return <>Meridian reports {usdM(Number(c.headline_cents))}. TrueVal says {usdM(tv - tr)} to {usdM(tv + tr)}. Its score is {c.score ?? "n/a"}, {c.band}.</>;
  } },
  { path: `/funds/${MERIDIAN}?tab=pledges`, target: "#t-refused", title: "A double pledge, refused on chain", secs: 20, body: () => <>Meridian tried to pledge a loan Harbor already holds. The contract refused it and recorded one blocked attempt and one alert against Meridian. <a href={txUrl(KNOWN_TXS.refusedPledge.hash)} target="_blank" rel="noreferrer">See the transaction</a>.</> },
  { path: `/funds/${MERIDIAN}`, target: "#t-recompute", title: "Recompute the score yourself", secs: 20, body: (v) => {
    const c = cert(v, MERIDIAN);
    return <>Your browser just ran the public scoring engine on chain data and compared every number with the signed certificate{c ? ` (score ${c.score})` : ""}. Each row says match or differs.</>;
  } },
  { path: `/loans/${LOAN}`, target: "[data-tour=check-signature]", title: "Check an enclave signature", secs: 30, body: () => <>Press <b>Check signature</b>. Your browser recovers the signer of the enclave's reply and compares it with the TEE signer registered on chain. The loan document never touched the chain.</> },
  { path: "/verify", target: "#t-tamper", title: "The verifier, and a tamper test", secs: 40, body: () => <>Every check runs now in your browser against the chain and the committed evidence. Press a tamper button: one piece of evidence changes in memory and the matching row turns red. Rows marked recorded or not checked say why.</> },
  { path: `/reports/${MERIDIAN}`, target: "main", title: "Download the report", secs: 10, body: () => <>The {fundName(MERIDIAN)} report, with its sources. Print it or download the JSON bundle. That is the tour: about 3 minutes, no wallet, nothing sent.</> },
];

const withTour = (path: string, n: number) => `${path}${path.includes("?") ? "&" : "?"}tour=${n}`;
export const tourStart = () => withTour(TOUR[0].path, 1);

export function Tour() {
  const path = usePath();
  const { view } = useRegistry();
  const n = useMemo(() => Number(new URL(path, "http://x").searchParams.get("tour") || 0), [path]);
  const step = n >= 1 && n <= TOUR.length ? TOUR[n - 1] : null;

  useEffect(() => {
    if (!step) return;
    let el: Element | null = null, tries = 0;
    const t = window.setInterval(() => {
      el = document.querySelector(step.target);
      if (el || ++tries > 40) {
        window.clearInterval(t);
        if (el) { el.classList.add("tour-hl"); if (step.target !== "main") el.scrollIntoView({ block: "center", behavior: "smooth" }); }
      }
    }, 150);
    return () => { window.clearInterval(t); document.querySelectorAll(".tour-hl").forEach((x) => x.classList.remove("tour-hl")); };
  }, [step, path]);

  if (!step) return null;
  const go = (k: number) => navigate(k >= 1 && k <= TOUR.length ? withTour(TOUR[k - 1].path, k) : new URL(path, "http://x").pathname);
  return (
    <aside className="tour" role="dialog" aria-label="Judge tour">
      <div className="tour-h"><span className="mono dim">Step {n} of {TOUR.length} · about {step.secs} s</span><button className="linkbtn" onClick={() => go(0)} aria-label="End the tour">End tour</button></div>
      <h3>{step.title}</h3>
      <p>{step.body(view)}</p>
      <ol className="tour-dots">{TOUR.map((s, i) => <li key={i} className={i + 1 === n ? "on" : i + 1 < n ? "done" : ""} title={s.title} />)}</ol>
      <div className="hrow between">
        <button className="xb sm ghost" onClick={() => go(n - 1)} disabled={n === 1}>Back</button>
        {n < TOUR.length ? <button className="xb sm" onClick={() => go(n + 1)}>Next</button> : <A href="/features" className="xb sm">Done: all features</A>}
      </div>
    </aside>
  );
}
