// Methodology: the published rules behind TrueVal, TrueRange and the score. Restates the app's Methodology page and the
// score rules (R1 to R16, R25). The app copy stays under /app/methodology. Nothing here invents a rule.
import { A } from "../ui";
import { Band, Card, Code, Cta, Facts, Grid, Hero, Note, Pill, Table } from "./kit";
import { SitePage } from "./Shell";

export function MethodologyPage() {
  return (
    <SitePage route="methodology">
      <Hero
        label="methodology"
        title="How the number is made."
        lead="TrueVal, TrueRange and the TrueNav score, with every rule published. The engine is open code and deterministic, so anyone can recompute each figure from the same inputs."
        actions={<><Pill href="/features/engine">Run the engine in your browser <span aria-hidden="true">→</span></Pill><Pill href="/app/methodology" kind="ghost">Method page in the app</Pill></>}
      >
        <p className="mk-meta mono">Rules effective 14 Nov 2026 · changes are tracked in the public repository history</p>
      </Hero>

      <Band tone="white" label="the three numbers" title="TrueVal, TrueRange and a score.">
        <Grid cols={3}>
          <Card label="TrueVal" title="What the loans are worth">
            <p>The sum over verified loans of EAD × (1 − PD × LGD). EAD is principal plus accrued interest minus repayments. A model estimate, not fair value.</p>
            <p>A loan is verified when it is open, valid, its pledge token is held, it carries no anomaly flag and it is not a duplicate. Every other open loan is left out.</p>
          </Card>
          <Card label="TrueRange" title="Where TrueVal likely falls">
            <p>TrueVal plus or minus z × the standard deviation of loss, with z = 1.96 and variance = the sum of EAD² × LGD² × PD × (1 − PD).</p>
            <p>This assumes loans default independently. It is a demo estimate. Correlated defaults are planned, not live.</p>
          </Card>
          <Card label="score" title="0 to 100, in three bands">
            <p>How far the reported NAV can be trusted. <b>Green</b> from 85, <b>yellow</b> 60 to 84, <b>red</b> below 60.</p>
          </Card>
        </Grid>
      </Band>

      <Band tone="tint" label="the score" title="Where the points come from.">
        <Table
          head={["Part", "Points", "How it is set"]}
          caption="Score parts"
          rows={[
            ["Gap", "up to 40", "How far the loan-implied headline sits outside TrueRange, against 10% of TrueVal. Inside the range gives the full 40."],
            ["Coverage", "up to 40", "40 × min(1, policy NAV ÷ the larger of the loan-implied headline and the listed book): how much of the claim verified loans back."],
            ["Freshness", "up to 20", "Full at 24 hours or less, falling in a straight line to 0 at 168 hours, from the oldest input date."],
            ["Penalty", "minus", "15 × 0.5^(age in days ÷ 30) for each distinct blocked double-pledge attempt."],
          ]}
        />
        <p className="mk-p" style={{ marginTop: 14 }}>Score = gap + coverage + freshness − penalty, rounded half up, floored at 0.</p>
      </Band>

      <Band tone="white" label="holds and caps" title="Rules that override the arithmetic.">
        <Grid cols={2}>
          <Card title="No green for 30 days after an attempt"><p>A fund that attempted a double pledge is capped at yellow. The number itself is unchanged.</p></Card>
          <Card title="The 50% test"><p>If more than half the claimed value is unverified, the fund is disclaimed: red with no number.</p></Card>
          <Card title="Stale or missing data"><p>A certificate over data older than 30 days fails verification. A fund never certified, with no headline, is not rated.</p></Card>
          <Card title="Our own policy"><p>The 30 days, 50% and 10% thresholds are TrueNav's own policy, not agency figures.</p></Card>
        </Grid>
      </Band>

      <Band tone="tint" label="inputs" title="The model tables are demo, not calibrated.">
        <Table
          head={["Input", "Value used"]}
          caption="Model tables"
          rows={[
            ["Probability of default (PD) by days past due", "Current 2%, 1 to 30 days 10%, 31 to 60 days 25%, 61 to 90 days 45%, over 90 days 100%."],
            ["Loss given default (LGD) by asset type", "Real estate (first lien) 31%. Invoices, treated as unsecured, 67%: an inference from a corporate stress table."],
          ]}
        />
        <Note label="read this">These tables are placeholders so the pipeline can run end to end. They are not calibrated to real loan performance, and the funds are fictional.</Note>
      </Band>

      <Band tone="white" label="TEE verdicts" title="How the private checks enter the score.">
        <p className="mk-p">A model in an attested TEE reads each pledged loan's private document, compares it with the fund's claim and signs a verdict-only reply. A flag makes the loan unverified and excludes it. With no verdict, a loan is pending for 7 days after its on-chain pledge time, then unverified. The engine reads verdicts from the chain and never calls the TEE itself.</p>
        <p className="mk-p">One flag on one Harbor loan takes the demo fund from green to red. Reproduce it from a fresh clone:</p>
        <Code>{`npm run demo   # Harbor scores 99 green, then about 52 red after one TEE flag`}</Code>
        <Facts rows={[["what moves a score", "a new TEE flag or an overdue verdict · a blocked double pledge · older data · a headline NAV outside TrueRange"], ["try it", <A href="/features/engine?preset=t1">the engine page in the demo app</A>]]} />
      </Band>

      <Cta label="next" title="Recompute it yourself.">
        <Pill href="/features/engine" kind="inv">Open the engine <span aria-hidden="true">→</span></Pill>
        <Pill href="/evidence" kind="ghost inv">Evidence</Pill>
      </Cta>
    </SitePage>
  );
}
