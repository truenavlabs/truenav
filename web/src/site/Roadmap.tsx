// Roadmap, marketing version. Only the Now column is live, and only on NEAR testnet. Every other item is planned.
// Items restate the app's roadmap and the upgrade notes. Order shows intent, not a schedule.
import { ROADMAP } from "./content";
import { RoadmapDiagram } from "./diagrams";
import { Band, Card, Chip, Cta, Figure, Grid, Hero, Pill } from "./kit";
import { SitePage } from "./Shell";

export function Roadmap() {
  const next = ROADMAP.filter((r) => r.horizon === "Next");
  const later = ROADMAP.filter((r) => r.horizon === "Later");
  return (
    <SitePage route="roadmap">
      <Hero
        label="roadmap"
        title="What it can become. None of the planned items is live."
        lead="Today TrueNav is a testnet prototype with fictional funds. This is what we intend to build next. Order shows intent, not a schedule."
        actions={<><Pill href="/pilot">Request a pilot <span aria-hidden="true">→</span></Pill><Pill href="/security#limits" kind="ghost">Known limits</Pill></>}
      />
      <Band tone="white" label="timeline" title="Now, next, later.">
        <Figure caption="roadmap timeline. Only Now is live, and only on NEAR testnet"><RoadmapDiagram /></Figure>
      </Band>
      <Band tone="tint" label="now" title="Live on NEAR testnet today." lead="Real, with fictional data.">
        <Grid cols={2}>
          <Card title="Registry and pledge lock" chip="live"><p>Refuses a second fund's pledge of the same loan. Stores TEE verdicts and score certificates.</p></Card>
          <Card title="TEE verdicts on chain" chip="live"><p>A model in a NEAR AI Cloud TEE signs verdicts on private loan documents. The registry checks the signature.</p></Card>
          <Card title="Public score engine" chip="live"><p>TrueVal, TrueRange and a 0 to 100 score from verified loans and chain data. Anyone can recompute it.</p></Card>
          <Card title="Verifier" chip="live"><p>Public chain reads and a receipt checker that need no key and no account.</p></Card>
        </Grid>
      </Band>
      <Band tone="white" label="next" title="Planned, not live.">
        <Grid cols={2}>
          {next.map((r) => <Card key={r.title} title={r.title} chip={r.status}><p>{r.body}</p></Card>)}
        </Grid>
      </Band>
      <Band tone="tint" label="later" title="Further out. Planned, not live.">
        <Grid cols={3}>
          {later.map((r) => <Card key={r.title} title={r.title} chip={r.status}><p>{r.body}</p></Card>)}
        </Grid>
        <p className="mk-p" style={{ marginTop: 18 }}><Chip s="planned" /> means we have not built it or have not deployed it. Nothing on this page is promised for a date.</p>
      </Band>
      <Cta label="next" title="Help decide what comes first.">
        <Pill href="/pilot" kind="inv">Request a pilot <span aria-hidden="true">→</span></Pill>
        <Pill href="/built-on-near" kind="ghost inv">Built on NEAR</Pill>
      </Cta>
    </SitePage>
  );
}
