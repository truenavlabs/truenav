// Product: one screen. Two cards, one per side of the trade. Every figure comes from the testnet fixtures (facts.ts).
import { A } from "../ui";
import { PUBLIC_V3_FIELDS } from "../public";
import { fund, HARBOR, MERIDIAN, publicLines } from "./facts";
import { REPO, SitePage } from "./Shell";

function FundRow({ id }: { id: string }) {
  const f = fund(id);
  const tone = f.band === "green" ? "g" : f.band === "red" ? "r" : "y";
  return (
    <div className={`pm-row ${tone}`}>
      <div className="pm-name">
        <b>{f.name}</b>
        <span className="mono">{f.id}</span>
      </div>
      <div className="pm-score mono" aria-label={`TrueNav score ${f.score} of 100`}>{f.score}<small>/100</small></div>
      <div className="pm-kv mono"><span>reported NAV</span><b>{f.reported}</b></div>
      <div className="pm-kv mono"><span>TrueVal</span><b>{f.trueval}</b></div>
      <div className="pm-kv mono"><span>TrueRange</span><b>{f.low} to {f.high}</b></div>
      <div className={`pm-res mono ${f.inside ? "in" : "out"}`}>{f.inside ? "reported NAV inside the range" : `reported NAV ${f.result}`}</div>
    </div>
  );
}

export function Product() {
  return (
    <SitePage route="product" className="one">
      <section className="pd">
        <header className="pd-head">
          <span className="lbl">product</span>
          <h1>One check, both sides of the trade.</h1>
          <p>Investors get an independent value before they buy. Managers get a public receipt that proves their NAV and shows none of their loans.</p>
        </header>
        <div className="pd-cards">
          <article className="pd-card light" aria-labelledby="pd-inv">
            <div className="pd-top">
              <span className="lbl">for investors</span>
              <h2 id="pd-inv">See the gap before you buy.</h2>
              <p>TrueNav recomputes what a fund's loans are worth and puts that value, TrueVal, next to the NAV the fund reports.</p>
            </div>
            <div className="pd-mock ui" aria-label="Example from the testnet fixtures">
              <div className="pm-bar mono"><span>funds</span><span>fixture · testnet</span></div>
              <FundRow id={HARBOR} />
              <FundRow id={MERIDIAN} />
            </div>
            <div className="pd-cta">
              <A href="/funds" className="pillbtn">Open the funds <span aria-hidden="true">→</span></A>
              <A href="/investor" className="pillbtn ghost">Investor view</A>
            </div>
          </article>
          <article className="pd-card dark" aria-labelledby="pd-man">
            <div className="pd-top">
              <span className="lbl">for managers</span>
              <h2 id="pd-man">Prove your NAV, keep your loans private.</h2>
              <p>Loan documents are checked inside a TEE. What goes public is a receipt of {PUBLIC_V3_FIELDS.length} allowlisted fields, with no loan rows in it.</p>
            </div>
            <div className="pd-mock term" aria-label="Public receipt fields for the Harbor fixture">
              <div className="tm-bar mono"><i /><i /><i /><span>public receipt · harbor · seq 1</span></div>
              <pre className="mono">
                <span className="cm"># public fields only, read through the allowlist</span>
                {"\n"}
                {publicLines(HARBOR).map(([k, v]) => (
                  <span key={k}>
                    <span className="k">{k}</span>
                    {": "}
                    <span className="v">{v}</span>
                    {"\n"}
                  </span>
                ))}
                <span className="cm"># loan documents, amounts, borrowers: not in the receipt</span>
              </pre>
            </div>
            <div className="pd-cta">
              <A href="/verify" className="pillbtn inv">Verify a receipt <span aria-hidden="true">→</span></A>
              <A href="/manager" className="pillbtn ghost inv">Manager view</A>
            </div>
          </article>
        </div>
      </section>
      <footer className="sfoot-slim mono">
        <span>near testnet · synthetic data · figures from the committed fixtures</span>
        <span><A href="/about">About</A> · <a href={REPO} target="_blank" rel="noopener noreferrer">Source ↗</a> · © 2026 TrueNav Labs</span>
      </footer>
    </SitePage>
  );
}
