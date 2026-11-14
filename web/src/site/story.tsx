// The Home story, below the hero: problem, what TrueNav does, how it helps investors and managers, how it works,
// why NEAR, roadmap, then the testnet note, the NEAR HACKATHON origin and the call to act.
import { A } from "../ui";
import { PUBLIC_V3_FIELDS } from "../public";
import { HACKATHON_URL, NEAR_CARDS, SHOTS } from "./content";
import { ProblemDiagram, RoadmapDiagram, StackDiagram } from "./diagrams";
import { Band, Card, Chip, Cta, Figure, Grid, Pill, PillExt, Shot, Steps, Num } from "./kit";
import { REPO, SiteFooter, WHITEPAPER_PDF } from "./Shell";

export function HomeStory() {
  return (
    <div className="hs-wrap" id="story">
      <Band
        id="problem" tone="white" label="the problem"
        title="A fund reports a NAV. You cannot see the loans behind it."
        lead="Tokenizing a fund's units does not change that. The loans stay in private files, so the number is taken on trust."
      >
        <div className="hs-prob">
          <div><b>Are the loans real?</b>You cannot check from the outside that they exist.</div>
          <div><b>Are they worth it?</b>You cannot check they are worth what the fund says.</div>
          <div><b>Pledged once?</b>You cannot check the same loan is not also pledged to another fund.</div>
        </div>
        <Figure caption="the problem, drawn: a NAV with private loans behind it, and one loan pledged twice">
          <ProblemDiagram />
        </Figure>
      </Band>

      <Band
        id="what" tone="tint" label="what TrueNav does"
        title="An independent check, published as three numbers."
        lead="TrueNav checks each private loan inside a TEE and publishes TrueVal, TrueRange and a score from 0 to 100, next to the NAV the fund reports."
      >
        <Grid cols={2}>
          <Card label="value and range" title="An independent value, with a range">
            <p><b>TrueVal</b> is what the fund's loans are worth after expected losses. <b>TrueRange</b> is where it likely falls. Both sit beside the reported NAV. A model estimate, not fair value; the default tables are demo.</p>
          </Card>
          <Card label="one loan, one fund" title="A pledge that cannot be repeated" chip="live">
            <p>A registry contract on NEAR testnet refuses a second fund's pledge of the same loan. Each pledge is a non-transferable token.</p>
          </Card>
          <Card label="private document checks" title="Verdicts, not documents" chip="live">
            <p>A model in a TEE compares each private loan document with the fund's claim and signs a verdict-only reply. The document never goes on chain.</p>
          </Card>
          <Card label="one score" title="Green, yellow or red">
            <p>The TrueNav score runs 0 to 100: green from 85, yellow 60 to 84, red below 60. It says how far the reported NAV can be trusted.</p>
          </Card>
        </Grid>
        <div className="hs-num" aria-label="One altered loan document moves a demo fund from green to red">
          <div><div className="big mono g">99.17</div><span className="mono">Harbor Credit Fund, green (demo fund)</span></div>
          <div><div className="big mono r">51.59</div><span className="mono">after a TEE flag on one altered loan document</span></div>
        </div>
        <p className="mk-p" style={{ marginTop: 14 }}>
          Replayed from recorded, TEE-signed replies on fictional data. TrueNav informs only: it never moves or blocks money.
        </p>
        <div className="mk-two" style={{ marginTop: 32 }}>
          <Shot {...SHOTS.harbor} />
          <Shot {...SHOTS.meridian} />
        </div>
      </Band>

      <Band
        id="helps" tone="white" label="who it helps"
        title="Both sides of a tokenized fund."
        lead="Allocators and fund administrators doing diligence on tokenized private credit get a check they can repeat. Managers get a way to prove it without publishing their loans."
      >
        <Grid cols={2}>
          <Card label="for investors and allocators" title="See the gap before you buy." href="/investors" cta="For investors">
            <ul className="mk-list">
              <li>An independent value and range next to the reported NAV.</li>
              <li>Compare funds on one score, with the reasons behind it.</li>
              <li>Check any claim yourself from public chain reads, with no account.</li>
            </ul>
          </Card>
          <Card label="for fund managers and administrators" title="Prove your NAV, keep your loans private." href="/managers" cta="For fund managers">
            <ul className="mk-list">
              <li>A public receipt of {PUBLIC_V3_FIELDS.length} allowlisted fields. No loan rows.</li>
              <li>Loan documents are checked in a TEE and stay private.</li>
              <li>See what moves your score, and fix it.</li>
            </ul>
          </Card>
        </Grid>
        <p className="mk-p" style={{ marginTop: 18 }}>Auditors can re-run every check from public data. The engine is open code and deterministic.</p>
      </Band>

      <Band
        id="how" tone="tint" label="how it works"
        title="Private checks, public proof."
        lead="Five steps take a fund's private loan file to a score anyone can re-check."
      >
        <Steps>
          <Num n={1} title="Documents stay private">A loan's on-chain id is an HMAC computed inside a TEE with a key nobody holds, so a document id cannot be tested against it.</Num>
          <Num n={2} title="A TEE model signs a verdict">The model reads the document in a NEAR AI Cloud TEE and returns a verdict-only reply, signed by a key that never leaves the enclave.</Num>
          <Num n={3} title="A contract checks and stores it">The registry recovers the signer, checks it is a registered TEE signer, checks the contract, network and expiry binding, and stores the verdict.</Num>
          <Num n={4} title="A public engine computes the numbers">Open code reads the verified loans and chain data and computes TrueVal, TrueRange and the score. A certificate with those numbers goes on the registry.</Num>
          <Num n={5} title="Anyone verifies">An investor re-checks the score with no key and no account: public chain reads, a command line check and the receipt checker.</Num>
        </Steps>
        <div style={{ marginTop: 32 }}>
          <Figure caption="the stack, with the privacy boundary. Status chips say what is live and what is not">
            <StackDiagram />
          </Figure>
        </div>
        <p className="mk-p" style={{ marginTop: 18 }}>
          <A href="/technology" className="ln">Read the full walkthrough →</A>
        </p>
      </Band>

      <Band
        id="why-near" tone="white" label="why NEAR"
        title="Built on NEAR, for a reason."
        lead="The private checks run in NEAR's TEEs. The public record lives on NEAR. Anyone can re-check both."
      >
        <Grid cols={3}>
          {NEAR_CARDS.map((c) => (
            <Card key={c.n} label={`0${c.n}`} title={c.title} chip={c.chip}><p>{c.body}</p></Card>
          ))}
        </Grid>
        <p className="mk-p" style={{ marginTop: 18 }}>
          Testnet only. Not zero knowledge. The contract checks the TEE's signature, and anyone can re-check the attestation.{" "}
          <A href="/built-on-near" className="ln">Why NEAR, in full →</A>
        </p>
      </Band>

      <Band
        id="roadmap" tone="tint" label="what it becomes"
        title="Roadmap, not live."
        lead="Everything outside the Now column is planned. Order shows intent, not a schedule."
      >
        <Figure caption="roadmap, drawn. Only Now is live, and only on NEAR testnet">
          <RoadmapDiagram />
        </Figure>
        <p className="mk-p" style={{ marginTop: 18 }}>
          <A href="/roadmap" className="ln">The full roadmap →</A>
        </p>
      </Band>

      <Band id="status" tone="white" label="status and origin">
        <div className="mk-two">
          <div className="hs-status">
            <span className="lbl">status</span>
            <h3>A testnet demo.</h3>
            <p className="mk-p"><Chip s="live" /> The registry contract, the TEE verdicts on chain and the public score engine are real, on NEAR testnet.</p>
            <p className="mk-p"><Chip s="demo" /> Every fund, loan, document and bank record is fictional. There are no clients and no real assets.</p>
            <p className="mk-p"><A href="/security#real" className="ln">What is real and what is simulated →</A></p>
          </div>
          <div className="hs-hack">
            <span className="lbl">origin</span>
            <h3>Built at NEAR HACKATHON 2026.</h3>
            <p className="mk-p">
              TrueNav started at NEAR HACKATHON, the November 2026 build event run at <a className="ln" href={HACKATHON_URL} target="_blank" rel="noopener noreferrer">nearhackathon.com ↗</a>.
              We built it between 5 and 14 November 2026, inside the event window, and entered two tracks: Privacy and Private AI, and Open Innovation.
            </p>
            <p className="mk-p mono" style={{ fontSize: 12, color: "var(--slate)" }}>TrueNav Labs is an entrant. This is not an award or an endorsement.</p>
            <p className="mk-p"><A href="/about#hackathon" className="ln">The story →</A></p>
          </div>
        </div>
      </Band>

      <Cta label="next" title="Try it, or run a pilot with us.">
        <Pill href="/pilot" kind="inv">Request a pilot <span aria-hidden="true">→</span></Pill>
        <Pill href="/overview" kind="ghost inv">Open the demo app</Pill>
        <a href={WHITEPAPER_PDF} className="pillbtn ghost inv" target="_blank" rel="noopener noreferrer">Read the whitepaper</a>
        <PillExt href={REPO} kind="ghost inv">Read the code ↗</PillExt>
      </Cta>
      <SiteFooter />
    </div>
  );
}
