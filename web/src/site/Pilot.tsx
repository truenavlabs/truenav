// Request a pilot: an invitation, not a status. No pilot is running, and TrueNav is a testnet prototype.
// Contact is GitHub Issues until another path is chosen.
import { Band, Card, Chip, Cta, Grid, Hero, Note, Num, Pill, PillExt, Steps } from "./kit";
import { ISSUES, SitePage } from "./Shell";

export function Pilot() {
  return (
    <SitePage route="pilot">
      <Hero
        label="request a pilot"
        title="Try TrueNav on your own question."
        lead="If you do due diligence on tokenized private credit, or run a fund that wants to be checkable without publishing its loans, we would like to hear from you. This is an invitation: no pilot is running yet."
        actions={<><PillExt href={ISSUES}>Open an issue ↗</PillExt><Pill href="/overview" kind="ghost">Try the demo first</Pill></>}
      />

      <Band tone="white" label="who it is for" title="Four kinds of reader.">
        <Grid cols={4}>
          <Card title="Fund managers"><p>You want investors to check your NAV without seeing your loans.</p></Card>
          <Card title="Fund administrators"><p>You want an independent, repeatable check beside your NAV process.</p></Card>
          <Card title="Allocators"><p>You want to see the gap between a reported NAV and the loans behind it.</p></Card>
          <Card title="Auditors"><p>You want to re-run a check from public data.</p></Card>
        </Grid>
      </Band>

      <Band tone="tint" label="what a pilot is" title="Three steps, all on testnet.">
        <Steps>
          <Num n={1} title="Agree the question">Which fund or loan type, and what you want to know about it.</Num>
          <Num n={2} title="Run the checks">The same TEE checks and score engine as the demo. Today the demo uses mock bank data and fictional documents, so what real data would connect is something we agree with you.</Num>
          <Num n={3} title="Review the result">You get the score, the reasons behind it and the public receipt. We agree what is written to the testnet registry before anything is written, because it is public.</Num>
        </Steps>
      </Band>

      <Band id="status" tone="white" label="status" title="Where TrueNav is today.">
        <p className="mk-p"><Chip s="live" /> The registry, the TEE verdicts and the score engine are real, on NEAR testnet.</p>
        <p className="mk-p"><Chip s="demo" /> Every fund, loan and document in the demo is fictional.</p>
        <p className="mk-p"><Chip s="limit">testnet only</Chip> Do not send real funds or real loan documents.</p>
        <Note label="how to reach us">
          Open an issue on the public repository and say who you are, what you want to check and why. Issues are public, so do not post anything confidential. For a security problem, use a private security advisory instead.
        </Note>
      </Band>

      <Cta label="contact" title="Start with an issue.">
        <PillExt href={ISSUES} kind="inv">Open an issue ↗</PillExt>
        <Pill href="/about" kind="ghost inv">About TrueNav Labs</Pill>
      </Cta>
    </SitePage>
  );
}
