import replay from "../../../data/recorded/judge-replay.json";
import counts from "../../../data/recorded/test-counts.json";
import { when } from "../../shell/fmt";
import { FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";

type Stage = { id: string; name: string; status: string; claim: string; evidence: string; label?: string };

export default function Evidence() {
  const stages = (replay as { stages: Stage[] }).stages;
  const eph = (replay as unknown as { ephemeral: { generated_at: string; wall_ms: number } }).ephemeral;
  const passed = stages.filter((s) => s.status === "pass").length;
  const tryIt = (
    <>
      <div className="kpirow">
        <div className="kpi"><div className="kl">Judge stages</div><div className="kval ok">{passed} of {stages.length}</div><div className="ks">offline replay, commit {replay.commit.slice(0, 7)}, {when(eph.generated_at)}, {(eph.wall_ms / 1000).toFixed(1)} s</div></div>
        <div className="kpi"><div className="kl">Tests</div><div className="kval">{counts.tests}</div><div className="ks">{counts.pass} pass, {counts.fail} fail, {counts.skipped} skipped</div></div>
        <div className="kpi"><div className="kl">Measured on</div><div className="kval" style={{ fontSize: 16 }}>{counts.commit}</div><div className="ks">{counts.command}, Node {counts.node}</div></div>
      </div>
      <p className="dim mt">Skipped: {counts.skipped_why}. Counts are read from a committed file written from the run output, not typed by hand.</p>
      <Panel className="mt" title="Judge stages" sub="npm run judge -- --replay: no keys, funds, Docker, Rust, Python or network." tags={<SrcTag tag="recorded" source={`web/data/recorded/judge-replay.json, evidence_hash ${String((replay as { evidence_hash: string }).evidence_hash).slice(0, 12)}`} />} pad={false}>
        {stages.map((s) => (
          <div className="checkrow" key={s.id} style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}>
            <span className={`st st-${s.status === "pass" ? "live" : "fail"}`}>{s.id} {s.status}</span>
            <div>
              <div className="cl">{s.name}: {s.claim}</div>
              <div className="cd">{s.evidence}</div>
              {s.label ? <div className="cd" style={{ color: "var(--dim)" }}>{s.label}</div> : null}
            </div>
          </div>
        ))}
      </Panel>
      <Note tone="info">CI: the link to the run on the final public commit is added after the repository goes public; older run ids stop resolving after the switch.</Note>
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F11 Judge and test evidence"]]} title="Judge and test evidence" lead="One command replays every claim offline. Here is the last recorded run and the test counts." />
      <FeatureFrame
        what="The judge script checks each README claim with one stage: fixtures, tamper, engine, engine pin, failed head, paid report, dashboard data, mirror, attestation subset and wasm stamp."
        status={<StatusChip kind="recorded" />}
        tryIt={tryIt}
        proves={["Each claim's check passed on the recorded commit, offline.", "The test suite count and result for the named commit."]}
        notProves={["Anything about a later commit: rerun the judge on the commit you are looking at.", "The live parts: the replay is offline by design. Live checks are on the other feature pages."]}
        run={["npm ci", "npm run judge -- --replay", "npm test"]}
        sources={["judge/run.mjs", "judge/stages.mjs", "web/data/recorded/judge-replay.json", "web/data/recorded/test-counts.json"]}
      />
    </>
  );
}
