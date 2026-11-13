// What-if inputs for the scoring engine page. Pure functions over the committed engine input and the live verdict
// store; the page edits a copy and every result is compared with the certified inputs.
import { recomputeScores } from "./recompute.mjs";

export const T1_PRESET = Object.freeze({ loanId: "H-RE-01", verdict: "flag", anomalies: ["amount_mismatch"], source: "tee/fixtures/verdicts-368aa2.json T1-altered-amount" });

/** Copy of the TEE verdict store with some loans' latest verdict replaced. edits: { [loan_id]: {verdict, anomalies} } */
export function editTeeStore(teeStore, loanMap, edits) {
  const out = JSON.parse(JSON.stringify(teeStore || {}));
  for (const [loanId, e] of Object.entries(edits || {})) {
    const m = loanMap.find((x) => x.loan_id === loanId);
    if (!m || !out[m.loan_hash]) continue;
    const prev = out[m.loan_hash].latest || {};
    out[m.loan_hash].latest = { ...prev, verdict: e.verdict, anomalies: e.verdict === "pass" ? [] : [...(e.anomalies || [])] };
  }
  return out;
}

/** True when the edited inputs differ from the certified ones in any way. */
export function isWhatIf(certified, edited, teeEdits) {
  return JSON.stringify(certified) !== JSON.stringify(edited) || Object.keys(teeEdits || {}).length > 0;
}

/** Run the engine on edited inputs. Returns per fund results with rawX100. */
export function runWhatIf({ fixtures, loanMap, teeStore, teeEdits }) {
  return recomputeScores({ fixtures, loanMap, teeStore: editTeeStore(teeStore, loanMap, teeEdits) });
}
