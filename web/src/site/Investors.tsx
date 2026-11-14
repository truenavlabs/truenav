// For investors and allocators: is this NAV believable? Copy restates the README problem, the methodology and the
// receipt checker. Funds shown are the fictional demo funds, labeled.
import { Band, Card, Code, Cta, Grid, Hero, Pill, Shot } from "./kit";
import { SHOTS } from "./content";
import { FundRow } from "./Product";
import { HARBOR, MERIDIAN } from "./facts";
import { SitePage } from "./Shell";

const FAQ: [string, string][] = [
  ["Is this a credit rating?", "No. TrueNav informs. It is not a rating agency and not investment advice. A red score is information about how far a reported NAV can be trusted."],
  ["Does a red score block anything?", "No. TrueNav never moves or blocks a subscription, a redemption or any other transfer. The registry makes no cross-contract call and sends no NEAR."],
  ["Are the numbers real?", "The demo funds, loans and documents are fictional. The registry, the TEE verdicts on chain and the score engine are real, on NEAR testnet."],
  ["Can I use it on a real fund today?", "No. It is a testnet prototype. If you run due diligence on tokenized private credit and want to try it on your own question, request a pilot."],
];

export function Investors() {
  return (
    <SitePage route="investors">
      <Hero
        label="for investors and allocators"
        title="See the gap before you buy."
        lead="A tokenized private-credit fund reports a NAV. TrueNav puts an independent value and range next to it, so you can see whether the loans behind the number support it."
        actions={<><Pill href="/funds">Open the demo funds <span aria-hidden="true">→</span></Pill><Pill href="/methodology" kind="ghost">How the score works</Pill></>}
      />

      <Band tone="white" label="the question" title="Is this NAV believable?" lead="From the outside you cannot see the loans. These are the three things you would want to know.">
        <Grid cols={3}>
          <Card title="Are the loans real?"><p>A model in a TEE checks each private loan document against the fund's claim and signs a verdict. You see the verdicts, not the documents.</p></Card>
          <Card title="Are they worth it?"><p>A public engine values each verified loan after expected losses and shows the result as TrueVal, with a TrueRange around it.</p></Card>
          <Card title="Is each loan pledged once?"><p>A registry on NEAR testnet refuses a second fund's pledge of the same loan. A refused attempt is public and lowers the score of the fund that tried.</p></Card>
        </Grid>
      </Band>

      <Band tone="tint" label="what you see" title="A score, a band and a range." lead="Each fund page shows the TrueNav score from 0 to 100, its band, and how the reported NAV sits against the independent range.">
        <div className="mk-two">
          <div>
            <ul className="mk-list">
              <li><b>Score and band.</b> Green from 85, yellow 60 to 84, red below 60.</li>
              <li><b>Reported NAV beside TrueVal.</b> And whether the reported figure sits inside or outside TrueRange.</li>
              <li><b>The reasons.</b> What pulled the score down: unverified loans, stale data, a blocked double pledge.</li>
              <li><b>An as-of date.</b> Data older than a day loses freshness points.</li>
            </ul>
            <p className="mk-p">TrueVal is a model estimate, not fair value. TrueRange assumes loans default independently. The default tables are demo, not calibrated.</p>
          </div>
          <div className="pd-mock ui" style={{ marginTop: 0 }} aria-label="Two demo funds">
            <div className="pm-bar mono"><span>demo funds</span><span>fixture · testnet</span></div>
            <FundRow id={HARBOR} />
            <FundRow id={MERIDIAN} />
          </div>
        </div>
        <div className="mk-two" style={{ marginTop: 32 }}>
          <Shot {...SHOTS.harbor} />
          <Shot {...SHOTS.meridian} />
        </div>
      </Band>

      <Band tone="white" label="check a claim yourself" title="You do not need to trust our page." lead="Public chain reads and open code. No key, no account, no funds.">
        <Code>{`npm run chain:read          # recompute both demo funds from chain data
npm run verify:attestation  # re-check the published TEE attestation
npm run verify:fingerprints # check recorded loan fingerprints`}</Code>
        <div className="mk-two">
          <Shot {...SHOTS.verify} caption="receipt checker with a tampered reply, demo data" />
          <div>
            <p className="mk-p">The receipt checker in the demo app walks a receipt through signature, attestation, fund binding and freshness. In the app those checks are simulated on fixtures, with no network. The commands above run on the real chain data.</p>
            <p className="mk-p"><Pill href="/verify">Open the receipt checker <span aria-hidden="true">→</span></Pill></p>
            <p className="mk-p"><Pill href="/evidence" kind="ghost">See the evidence</Pill></p>
          </div>
        </div>
      </Band>

      <Band tone="tint" label="questions" title="Short answers.">
        <div className="mk-faq">
          {FAQ.map(([q, a]) => (
            <details key={q}><summary>{q}</summary><p>{a}</p></details>
          ))}
        </div>
      </Band>

      <Cta label="next" title="Test it on your own question.">
        <Pill href="/pilot" kind="inv">Request a pilot <span aria-hidden="true">→</span></Pill>
        <Pill href="/overview" kind="ghost inv">Open demo</Pill>
      </Cta>
    </SitePage>
  );
}
