import { useState } from "react";
import { decide, variants } from "../../../data/agent-sim.mjs";
import build from "../../../../receipts/v3-build.json";
import { short } from "../../shell/fmt";
import { Copy, FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";

export default function AgentPin() {
  const pin = (build as { engine: { sha256: string } }).engine.sha256;
  const nowIso = new Date().toISOString();
  const vs = variants(pin, nowIso) as [string, Record<string, unknown> | null][];
  const [k, setK] = useState(0);
  const [name, r] = vs[k];
  const d = decide("HONEST-CREDIT", r, { nowMs: Date.parse(nowIso), pins: new Set([pin]) });
  const tone = d.action === "approve" ? "ok" : d.action === "review" ? "warn" : "bad";
  const tryIt = (
    <>
      <Panel title="The pin" tags={<SrcTag tag="recorded" source="receipts/v3-build.json engine.sha256" />}>
        <p className="mono" style={{ wordBreak: "break-all" }}>{pin} <Copy text={pin} /></p>
        <p className="dim">The agent accepts a v3 score only from the engine build with this hash ({short(pin, 8, 4)}). Anything else is declined as engine_hash and nothing is bought.</p>
      </Panel>
      <div className="hrow mt" style={{ gap: 6, flexWrap: "wrap" }}>
        {vs.map(([n], i) => <button key={n} className={`chipbtn${i === k ? " on" : ""}`} onClick={() => setK(i)}>{n}</button>)}
      </div>
      <div className="twocol mt">
        <div>
          <h3>Receipt the agent reads</h3>
          <pre className="raw">{r ? JSON.stringify({ ...r, version_key: r.version_key ? short(String(r.version_key), 8, 4) : undefined, engine_version_key: r.engine_version_key ? short(String(r.engine_version_key), 8, 4) : undefined, engine_code_sha256: r.engine_code_sha256 ? short(String(r.engine_code_sha256), 8, 4) : undefined }, null, 1) : "none stored"}</pre>
        </div>
        <div>
          <h3>Agent decision: {name}</h3>
          <Note tone={tone}><b>{d.action}</b> ({d.reason}): {d.detail}</Note>
          <p className="dim">{d.action === "decline" ? "Nothing is bought." : d.action === "review" ? "Held for a human; nothing is bought automatically." : "The agent may buy the report."}</p>
          <p className="dim">A v3 green receipt still ends in review as unattested: no verified TEE attestation for the v3 engine yet.</p>
        </div>
      </div>
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F9 Buyer agent pin"]]} title="Buyer agent engine pin" lead="An agent that buys reports trusts a score only if it came from the exact engine build it pins." />
      <FeatureFrame
        what="The buyer agent checks each receipt before paying: that it matches its own hash, that the run did not fail, that a v3 score came from the pinned engine build, then the score rules."
        status={<><StatusChip kind="built" /><p className="dim mt">Browser port of the agent's decision; the agent itself is not deployed.</p></>}
        tryIt={tryIt}
        proves={["Only the pinned engine hash is accepted; any other build is declined before any score rule.", "The decision order the agent follows, on every receipt shape."]}
        notProves={["That the pinned build ran inside a TEE. v3 receipts are unattested and stay in review.", "That receipts exist on chain. The receipts contract named in v3 is not on the live registry."]}
        run={["node --test agent/test/engine-pin.test.mjs agent/test/agent.test.mjs"]}
        sources={["agent/agent.mjs:108", "receipts/v3-build.json", "web/data/agent-sim.mjs"]}
      />
    </>
  );
}
