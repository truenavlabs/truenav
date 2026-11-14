// For fund managers and administrators: prove NAV without exposing loans. Restates the README, the trust model and the
// public receipt allowlist.
import { PUBLIC_V3_FIELDS } from "../public";
import { Band, Card, Chip, Cta, Grid, Hero, Note, Num, Pill, Steps, Table } from "./kit";
import { HARBOR, publicLines } from "./facts";
import { SitePage } from "./Shell";

export function Managers() {
  return (
    <SitePage route="managers">
      <Hero
        label="for fund managers and administrators"
        title="Prove your NAV. Keep your loans private."
        lead="Investors want to check the number you report. TrueNav lets them, from a public receipt, while your loan documents stay inside a TEE."
        actions={<><Pill href="/pilot">Request a pilot <span aria-hidden="true">→</span></Pill><Pill href="/technology" kind="ghost">How it works</Pill></>}
      />

      <Band tone="white" label="the ask" title="Be checkable without being exposed." lead="A reported NAV is taken on trust because the loans behind it are private. Publishing the loans is not an option. TrueNav checks them privately and publishes the result.">
        <Grid cols={3}>
          <Card title="Documents stay private"><p>A model in a NEAR AI Cloud TEE reads each loan document and signs a verdict-only reply. The document never goes on chain.</p></Card>
          <Card title="Each loan pledged once"><p>Your fund pledges each loan on the registry. A second pledge of the same loan by another fund is refused.</p></Card>
          <Card title="A public receipt"><p>What goes public is a receipt of {PUBLIC_V3_FIELDS.length} allowlisted fields. No loan rows, no borrowers, no documents.</p></Card>
        </Grid>
      </Band>

      <Band tone="tint" label="how a run works" title="From loan file to receipt.">
        <Steps>
          <Num n={1} title="Pledge the loans">Each loan gets an on-chain fingerprint, an HMAC computed in a TEE. The registry mints a non-transferable token for the pledge.</Num>
          <Num n={2} title="The TEE checks each document">The model compares the private document with your claim and signs a verdict. A flag makes that loan unverified and leaves it out of TrueVal.</Num>
          <Num n={3} title="The engine computes the numbers">Open code values the verified loans and scores the fund. Anyone can recompute the result from the same inputs.</Num>
          <Num n={4} title="A certificate and receipt are published">The registry stores a signed certificate. The public receipt shows the score, band and checks, never the loans.</Num>
        </Steps>
      </Band>

      <Band tone="white" label="public and private" title="What goes public, and what does not.">
        <div className="mk-two wide-l">
          <div>
            <Table
              head={["Public", "Private"]}
              caption="Public versus private data"
              rows={[
                ["Loan fingerprint (an HMAC, not a document id)", "Loan document text"],
                ["Who holds each pledge", "Borrower details"],
                ["Verdict and anomaly codes", "Loan rows, which the receipt never carries"],
                ["Certificates with fund totals", "Per-loan figures in the documents"],
                [`The ${PUBLIC_V3_FIELDS.length} field public receipt`, "Cash evidence documents"],
              ]}
            />
            <Note label="read this">
              A fund's totals are public. A fund that holds one loan reveals that loan's value through its totals. Also, a verdict stores a hash of the request without a salt, so someone who already holds the document can test it against that hash. The full privacy notes are on the security page.
            </Note>
          </div>
          <div className="pd-mock term" style={{ marginTop: 0 }} aria-label="Public receipt fields for the Harbor demo fund">
            <div className="tm-bar mono"><i /><i /><i /><span>public receipt · harbor (demo)</span></div>
            <pre className="mono">
              <span className="cm"># public fields only</span>{"\n"}
              {publicLines(HARBOR).map(([k, v]) => (
                <span key={k}><span className="k">{k}</span>{": "}<span className="v">{v}</span>{"\n"}</span>
              ))}
              <span className="cm"># documents, amounts, borrowers: not here</span>
            </pre>
          </div>
        </div>
      </Band>

      <Band tone="tint" label="what moves your score" title="The rules are published." lead="Four things move a score.">
        <Grid cols={2}>
          <Card title="A new TEE flag, or an overdue verdict"><p>The loan becomes unverified, so coverage and TrueVal fall.</p></Card>
          <Card title="A blocked double pledge"><p>A penalty, and no green for 30 days after the attempt.</p></Card>
          <Card title="Older data"><p>Freshness is full at 24 hours or less and falls to zero at 168 hours.</p></Card>
          <Card title="A NAV outside the range"><p>If the reported NAV drifts outside TrueRange, the gap points fall.</p></Card>
        </Grid>
        <p className="mk-p" style={{ marginTop: 18 }}>The 30 day, 50% and 10% thresholds are TrueNav's own policy, not agency figures. <a className="ln" href="/methodology">Read the methodology →</a></p>
      </Band>

      <Band tone="white" label="a pilot" title="What a pilot would look like." lead="This is an invitation, not a status. No pilot is running.">
        <Steps>
          <Num n={1} title="Agree the scope">Which fund, which loan types and which documents. All on NEAR testnet.</Num>
          <Num n={2} title="Run the checks">The same TEE checks and score engine as the demo, over the documents you agree to share. Today the demo uses mock bank data and fictional documents.</Num>
          <Num n={3} title="Review the results">You get the score, the reasons and the receipt. Anything written to the testnet registry is public, so we agree what is written first.</Num>
        </Steps>
        <p className="mk-p" style={{ marginTop: 16 }}><Chip s="limit">testnet only</Chip> Not for real funds or real loan documents yet.</p>
      </Band>

      <Cta label="next" title="Run your fund through it.">
        <Pill href="/pilot" kind="inv">Request a pilot <span aria-hidden="true">→</span></Pill>
        <Pill href="/overview" kind="ghost inv">Open demo</Pill>
      </Cta>
    </SitePage>
  );
}
