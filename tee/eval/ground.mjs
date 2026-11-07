// Eval-level grounding of the duplicate check (owner decision 7 Nov). The model returns duplicate_evidence_line,
// the number of the line it says holds "CERTIFIED COPY" or "re-issued". Only the eval has the documents, so only
// the eval can check it: a duplicate_document flag counts only if that line really contains one of the phrases.
// Otherwise the code is dropped at the eval level, and a flag with no codes left counts as pass.
// This never changes anything on chain: there a signed flag stays a flag and clears only through a new request.
import { lineOf } from "../reply.mjs";

export const DUPLICATE_PHRASES = ["CERTIFIED COPY", "re-issued"];

/** True when line n of the document contains one of the duplicate phrases (exact, as the prompt defines them). */
export function evidenceHolds(docText, n) {
  if (!Number.isInteger(n) || n < 1) return false;
  const line = lineOf(docText, n);
  return typeof line === "string" && DUPLICATE_PHRASES.some((p) => line.includes(p));
}

/** { verdict, anomalies, dropped } after grounding the duplicate code against the document. */
export function groundVerdict(v, docText) {
  const anomalies = Array.isArray(v.anomalies) ? v.anomalies : [];
  if (!anomalies.includes("duplicate_document") || evidenceHolds(docText, v.duplicate_evidence_line)) {
    return { verdict: v.verdict, anomalies, dropped: false };
  }
  const left = anomalies.filter((a) => a !== "duplicate_document");
  return { verdict: left.length ? "flag" : "pass", anomalies: left, dropped: true };
}
