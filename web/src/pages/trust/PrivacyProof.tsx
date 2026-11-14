// Three sections for the Trust page: who sees what, the attestation evidence with its last verified time, and the
// evidence ledger. Data layer plus a minimal render built only from the existing kit components and existing CSS
// classes; no layout of its own. The sections are marked "UI PASS" for the visual pass.
// Data: src/content/privacy-boundary.ts, data/recorded/attestation-evidence.json, data/recorded/evidence-ledger.json.
import evidence from "../../../data/recorded/attestation-evidence.json";
import ledger from "../../../data/recorded/evidence-ledger.json";
import { lastVerifiedLine, type AttestationEvidence } from "../../content/attestation-evidence";
import { LEAKS, LEVELS, PARTIES, ROWS } from "../../content/privacy-boundary";
import { Ext, Panel, SrcTag } from "../../shell/kit";
import { whenFull } from "../../shell/fmt";

const EV = evidence as unknown as AttestationEvidence;

type LedgerEntry = {
  id: string; label: string; shows: string; tx_hash: string; signer: string; receiver: string; actions: string;
  outcome: { status: string; result: string }; block_height: number; block_time_utc: string; explorer_url: string; explorer_alt_url: string;
};
const LEDGER = ledger as unknown as { entries: LedgerEntry[]; evidence_hash: string };

// UI PASS: section 1 of 3. A 7 column table: the item, then one column per party. Each cell is a level label and a note.
// The level labels are the four values of LEVELS; they want a visual scale (sees, partial, assumed, hidden).
export function PrivacyBoundary() {
  return (
    <Panel id="t-privacy-boundary" className="mt" title="Who sees what" sub="What each party can see and what stays hidden. Every row names the code or repository document it comes from. Rows marked design are not deployed." tags={<SrcTag tag="recorded" source="web/src/content/privacy-boundary.ts, tested against the files it names" />} pad={false}>
      <div className="tscroll">
        <table className="dt">
          <thead>
            <tr><th>What</th>{PARTIES.map((p) => <th key={p.id} title={p.who}>{p.label}</th>)}</tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: "normal", minWidth: 260 }}>
                  <strong>{r.item}</strong> <span className="tp">{r.status === "design" ? "design, not deployed" : r.status === "mixed" ? "live and design" : "live"}</span>
                  <div className="dim">{r.lives}</div>
                  <div className="dim">Source: {r.sources.map((s, i) => <span key={s.file}>{i ? ", " : ""}<code>{s.file}</code></span>)}</div>
                </td>
                {PARTIES.map((p) => (
                  <td key={p.id} style={{ whiteSpace: "normal", minWidth: 190, verticalAlign: "top" }}>
                    <span className="tp">{LEVELS[r.cells[p.id].level]}</span>
                    <div className="dim">{r.cells[p.id].note}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pb">
        <h3>Who the columns are</h3>
        <ul>{PARTIES.map((p) => <li key={p.id}><strong>{p.label}.</strong> {p.who}</li>)}</ul>
        <h3>What this still leaks</h3>
        <ul>{LEAKS.map((l) => <li key={l.id}><strong>{l.title}.</strong> {l.text}</li>)}</ul>
        <p className="dim">The same leaks are listed in <code>docs/KNOWN_LIMITS.md</code>.</p>
      </div>
    </Panel>
  );
}

// UI PASS: section 2 of 3. The last verified line is the headline. Then two result groups (OutLayer quotes, NEAR AI Cloud checks),
// then the two lists: what the checks prove and what they do not. Keep "do not prove" as visible as "prove".
export function AttestationEvidence() {
  const o = EV.outlayer;
  const n = EV.near_ai;
  return (
    <Panel id="t-attestation-evidence" className="mt" title="Attestation evidence" sub={lastVerifiedLine(EV)} tags={<SrcTag tag="recorded" source={`web/data/recorded/attestation-evidence.json, evidence_hash ${EV.evidence_hash.slice(0, 12)}`} />}>
      <p>Commands: {EV.commands.map((c, i) => <span key={c}>{i ? ", " : ""}<code>{c}</code></span>)}. Run both yourself to repeat it. Evidence hash <code>{EV.evidence_hash}</code>, written at commit <code>{EV.commit}</code> by <code>npm run record:attestation</code>.</p>
      <h3>OutLayer fingerprints</h3>
      <p>{o.records.length} recorded loan fingerprints. {o.distinct_quotes} distinct Intel TDX quotes verified with Intel collateral. {o.approved_measurement_sets} approved worker measurement sets read from <code>{o.worker_registry}</code>. All {o.loans_checked} loans in <code>tee/loans.json</code> use these fingerprints. Fingerprint module <code>{o.wasm_sha256}</code>, project <code>{o.project}</code>.</p>
      <p className="dim">Each record was checked for: {o.checks_per_record.join("; ")}.</p>
      <div className="tscroll">
        <table className="dt">
          <thead><tr><th>Document</th><th>Loan hash</th><th>Result</th><th>Public OutLayer proof</th></tr></thead>
          <tbody>
            {o.records.map((r) => (
              <tr key={r.call_id}>
                <td>{r.document_id}</td>
                <td className="mono">{r.loan_hash}</td>
                <td>{r.pass ? <span className="ok">pass</span> : <span className="bad">fail</span>}</td>
                <td><Ext href={r.proof_url}>call {r.call_id.slice(0, 8)}</Ext></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>NEAR AI Cloud report</h3>
      <p>Contract <code>{n.contract}</code>, model {n.model}, signer <code>{n.signer}</code>. Report sha256 <code>{n.report_sha256}</code>, captured {whenFull(Date.parse(n.report_captured_at))}, {n.verdicts_signed} recorded verdicts.</p>
      <div className="tscroll">
        <table className="dt">
          <thead><tr><th>Part</th><th>Check</th><th>Result</th></tr></thead>
          <tbody>
            {n.checks.map((c, i) => (
              <tr key={i}>
                <td>{c.section ?? "Registry and recorded verdicts"}</td>
                <td style={{ whiteSpace: "normal" }}>{c.check.replace(/\s+/g, " ")}</td>
                <td>{c.pass ? <span className="ok">pass</span> : <span className="bad">fail</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>What these checks prove</h3>
      <ul>{EV.proves.map((x) => <li key={x}>{x}</li>)}</ul>
      <h3>What these checks do not prove</h3>
      <ul>{EV.not_proves.map((x) => <li key={x}>{x}</li>)}</ul>
    </Panel>
  );
}

// UI PASS: section 3 of 3. One row per transaction: label, what it shows, full hash, explorer links, block time in UTC.
// Time order, oldest first. Refused rows (the signer refusal and the double pledge) are the ones a judge will want to find.
export function EvidenceLedger() {
  return (
    <Panel id="t-evidence-ledger" className="mt" title="Evidence ledger" sub="The testnet transactions this repository points to, each read from the public archival RPC and cross-checked on NearBlocks. Block times are UTC." tags={<SrcTag tag="recorded" source={`web/data/recorded/evidence-ledger.json, evidence_hash ${LEDGER.evidence_hash.slice(0, 12)}`} />} pad={false}>
      <div className="tscroll">
        <table className="dt">
          <thead><tr><th>Block time (UTC)</th><th>What</th><th>Result</th><th>Transaction</th></tr></thead>
          <tbody>
            {LEDGER.entries.map((e) => (
              <tr key={e.id}>
                <td style={{ verticalAlign: "top" }}>{e.block_time_utc.slice(0, 19).replace("T", " ")} UTC<div className="dim">{whenFull(Date.parse(e.block_time_utc))}</div><div className="dim">block {e.block_height}</div></td>
                <td style={{ whiteSpace: "normal", minWidth: 280, verticalAlign: "top" }}><strong>{e.label}</strong><div className="dim">{e.shows}</div><div className="dim">{e.signer} to {e.receiver}: {e.actions}</div></td>
                <td style={{ whiteSpace: "normal", verticalAlign: "top" }}><span className={e.outcome.status === "success" ? "ok" : "warn"}>{e.outcome.status}</span><div className="dim">{e.outcome.result}</div></td>
                <td style={{ verticalAlign: "top" }}><div className="mono" style={{ wordBreak: "break-all" }}>{e.tx_hash}</div><Ext href={e.explorer_url}>NearBlocks</Ext> <Ext href={e.explorer_alt_url}>NEAR Explorer</Ext></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pb">
        <p className="dim">Evidence hash <code>{LEDGER.evidence_hash}</code>. Regenerate with <code>npm run record:ledger</code>. A refused transaction is still a real transaction: the contract's refusal is the evidence.</p>
      </div>
    </Panel>
  );
}
