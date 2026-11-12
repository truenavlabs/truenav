import { A } from "../../ui";
import { PageHead, StatusChip } from "../../shell/kit";

const F: [string, string, string, "live" | "recorded" | "built" | "notdeployed"][] = [
  ["F1", "tee-underwriting", "TEE underwriting: 19 recorded cases, document diff, reply checks, eval", "recorded"],
  ["F2", "verdicts", "On-chain verdicts: latest, history, expiry, reply hash match", "live"],
  ["F3", "attestation", "Attestation: live report hash, 15 recorded checks, tamper lab", "live"],
  ["F4", "double-pledge", "Double-pledge lock: lock lookup, pledge simulator, the real refusal", "live"],
  ["F5", "engine", "Scoring engine: recompute both scores, change any input, the T1 flag", "live"],
  ["F6", "certificates", "Certificates: history, test-key signer, the refused certificate", "live"],
  ["F7", "roles", "Roles and pause: who controls what, against the expected setup", "live"],
  ["F8", "paid-report", "Paid report API: 402, buy, 200 once, run_failed (simulated)", "built"],
  ["F9", "agent-pin", "Buyer agent pin: only the pinned engine build is trusted", "built"],
  ["F10", "receipts-mirror", "Receipts v3 and the Base mirror: schema check, calldata fields", "notdeployed"],
  ["F11", "evidence", "Judge and test evidence: 10 stages, test counts", "recorded"],
];

export default function Index() {
  return (
    <>
      <PageHead title="Verify it yourself" lead="Every built feature, one page each, with a test you can run in this browser. Read-only: nothing is sent to the chain." right={<A href="/verify" className="xb">Run the verifier</A>} />
      <div className="fgrid">
        {F.map(([n, slug, text, st]) => (
          <A key={slug} href={`/features/${slug}`} className="fcard">
            <span className="fn">{n}</span>
            <h3>{text.split(":")[0]}</h3>
            <p>{text.split(":").slice(1).join(":").trim()}</p>
            <StatusChip kind={st} />
          </A>
        ))}
      </div>
    </>
  );
}
