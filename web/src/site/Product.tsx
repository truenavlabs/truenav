// Product: a short lead, two cards (one per side of the trade) and what the product is made of. Every figure comes from the
// committed demo fixtures (facts.ts), labeled as demo.
import { A } from "../ui";
import { PUBLIC_V3_FIELDS } from "../public";
import { fund, HARBOR, MERIDIAN, publicLines } from "./facts";
import { SHOTS } from "./content";
import { Band, Card, Chip, Cta, Grid, Pill, Shot } from "./kit";
import { SitePage } from "./Shell";

export function FundRow({ id }: { id: string }) {
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
    <SitePage route="product">
      <section className="pd">
        <header className="pd-head">
          <span className="lbl">product</span>
          <h1>One check, both sides of the trade.</h1>
          <p>TrueNav is a credit scorecard for tokenized private-credit funds, built on NEAR. Investors get an independent value before they buy. Managers get a public receipt that proves their NAV and shows none of their loans.</p>
        </header>
        <div className="pd-cards">
          <article className="pd-card light" aria-labelledby="pd-inv">
            <div className="pd-top">
              <span className="lbl">for investors</span>
              <h2 id="pd-inv">See the gap before you buy.</h2>
              <p>TrueNav recomputes what a fund's loans are worth and puts that value, TrueVal, next to the NAV the fund reports.</p>
            </div>
            <div className="pd-mock ui" aria-label="Example from the demo fixtures">
              <div className="pm-bar mono"><span>demo funds</span><span>fixture · testnet</span></div>
              <FundRow id={HARBOR} />
              <FundRow id={MERIDIAN} />
            </div>
            <div className="pd-cta">
              <A href="/investors" className="pillbtn">For investors <span aria-hidden="true">→</span></A>
              <A href="/funds" className="pillbtn ghost">Open the demo funds</A>
            </div>
          </article>
          <article className="pd-card dark" aria-labelledby="pd-man">
            <div className="pd-top">
              <span className="lbl">for managers</span>
              <h2 id="pd-man">Prove your NAV, keep your loans private.</h2>
              <p>Loan documents are checked inside a TEE. What goes public is a receipt of {PUBLIC_V3_FIELDS.length} allowlisted fields, with no loan rows in it.</p>
            </div>
            <div className="pd-mock term" aria-label="Public receipt fields for the Harbor demo fund">
              <div className="tm-bar mono"><i /><i /><i /><span>public receipt · harbor (demo) · seq 1</span></div>
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
              <A href="/managers" className="pillbtn inv">For fund managers <span aria-hidden="true">→</span></A>
              <A href="/features/double-pledge" className="pillbtn ghost inv">Try the pledge lock</A>
            </div>
          </article>
        </div>
      </section>

      <Band tone="white" label="what the product is" title="Three parts, one number." lead="Each part is built and runs on NEAR testnet today. The funds are fictional.">
        <Grid cols={3}>
          <Card label="01" title="The score" chip="live" href="/methodology" cta="Methodology">
            <p>A public, deterministic engine computes TrueVal, TrueRange and a score from 0 to 100 from verified loans and chain data. Anyone can recompute it.</p>
          </Card>
          <Card label="02" title="The pledge lock" chip="live" href="/technology" cta="How it works">
            <p>A registry contract refuses a second fund's pledge of the same loan, and stores the signed verdict of each private document check.</p>
          </Card>
          <Card label="03" title="The receipt" chip="live" href="/evidence" cta="Evidence">
            <p>A public receipt with a fixed allowlist of fields. The receipt checker in the demo app walks it through signature, attestation, fund binding and freshness.</p>
          </Card>
        </Grid>
        <div style={{ marginTop: 32 }}>
          <Shot {...SHOTS.overview} />
        </div>
        <p className="mk-p" style={{ marginTop: 14 }}><Chip s="demo" /> The app is a demo. It reads committed fixtures and public NEAR testnet views, and it never sends a transaction.</p>
      </Band>

      <Cta label="next" title="See it on your own question.">
        <Pill href="/pilot" kind="inv">Request a pilot <span aria-hidden="true">→</span></Pill>
        <Pill href="/overview" kind="ghost inv">Open demo</Pill>
      </Cta>
    </SitePage>
  );
}
