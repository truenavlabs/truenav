// What a TEE verdict reply may contain (owner decision 7 Nov). The full response body is public transaction data
// once submitted, so a reply with anything else is rejected, never rewritten: by the client before submitting
// (tee/underwrite.mjs retries), by the contract (parse_verdict), and by the CI check of the live contract
// (certify/check-chain-replies.mjs). The same rule is mirrored in contract/src/lib.rs (reply_problem).

export const ANOMALY_CODES = ["amount_mismatch", "asset_mismatch", "id_mismatch", "injection_attempt", "duplicate_document", "unreadable"];
export const CHECK_KEYS = ["id_mismatch", "asset_mismatch", "amount_mismatch", "duplicate_document", "injection_attempt", "unreadable"];
export const REPLY_KEYS = ["loan_hash", "binding", ...CHECK_KEYS.slice(0, 4), "duplicate_evidence_line", ...CHECK_KEYS.slice(4), "verdict", "anomalies"];
/** Fields of choices[0].message that may carry a value; any other field must be null. */
export const MESSAGE_KEYS = ["role", "content"];
export const MAX_EVIDENCE_LINE = 10000;

const isHashText = (s) => typeof s === "string" && /^[0-9a-f\s]{64,71}$/i.test(s) && s.replace(/\s+/g, "").length === 64;
const isBindingText = (s) => typeof s === "string" && s.length <= 160 && /^[A-Za-z0-9._|\-\s]+$/.test(s);

/** The model's JSON object inside the exact response body (code fences allowed), or null. */
export function replyObject(responseBody) {
  try {
    const msg = JSON.parse(responseBody).choices[0].message;
    const content = String(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return { msg, reply: JSON.parse(content) };
  } catch {
    return null;
  }
}

/** null when the reply is clean, otherwise the first problem found. */
export function replyProblem(responseBody) {
  let body;
  try {
    body = JSON.parse(responseBody);
  } catch {
    return "response is not JSON";
  }
  if (!Array.isArray(body.choices) || body.choices.length !== 1) return "response must have exactly one choice";
  const msg = body.choices[0] && body.choices[0].message;
  if (!msg || typeof msg !== "object") return "response has no message";
  for (const [k, v] of Object.entries(msg)) if (!MESSAGE_KEYS.includes(k) && v !== null) return `message field ${k} must be empty`;
  const parsed = replyObject(responseBody);
  if (!parsed || typeof parsed.reply !== "object" || parsed.reply === null || Array.isArray(parsed.reply)) return "reply is not one JSON object";
  const r = parsed.reply;
  for (const k of Object.keys(r)) if (!REPLY_KEYS.includes(k)) return `reply has a key outside the allowed list: ${k}`;
  if (!isHashText(r.loan_hash)) return "loan_hash is not a 64-hex hash";
  if (!isBindingText(r.binding)) return "binding is not a binding";
  for (const k of CHECK_KEYS) if (k in r && r[k] !== "ok" && r[k] !== "fail") return `${k} must be ok or fail`;
  if ("duplicate_evidence_line" in r) {
    const n = r.duplicate_evidence_line;
    if (!(n === "ok" || (Number.isInteger(n) && n >= 1 && n <= MAX_EVIDENCE_LINE))) return "duplicate_evidence_line must be a line number or ok";
  }
  if (r.verdict !== "pass" && r.verdict !== "flag") return "verdict must be pass or flag";
  if (!Array.isArray(r.anomalies) || !r.anomalies.every((a) => ANOMALY_CODES.includes(a))) return "anomalies must be known codes";
  return null;
}

/** The document as the model sees it: every line prefixed with its 1-based number. */
export const numberLines = (text) => text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
/** Line n (1-based) of the document, as numbered by numberLines. */
export const lineOf = (text, n) => text.split("\n")[n - 1];
