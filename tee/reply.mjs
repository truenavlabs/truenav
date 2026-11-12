// What a TEE verdict reply may contain (owner decision 7 Nov). The full response body is public transaction data
// once submitted, so a reply with anything else is rejected, never rewritten: by the client before submitting
// (tee/underwrite.mjs retries), by the contract (parse_verdict), and by the CI check of the live contract
// (certify/check-chain-replies.mjs). The same rule is mirrored in contract/src/lib.rs (reply_problem).

export const ANOMALY_CODES = ["amount_mismatch", "asset_mismatch", "id_mismatch", "injection_attempt", "duplicate_document", "unreadable"];
export const CHECK_KEYS = ["id_mismatch", "asset_mismatch", "amount_mismatch", "duplicate_document", "injection_attempt", "unreadable"];
export const REPLY_KEYS = ["loan_hash", "binding", ...CHECK_KEYS.slice(0, 4), "duplicate_evidence_line", ...CHECK_KEYS.slice(4), "verdict", "anomalies"];
/** The only top-level fields a NEAR AI Cloud chat completion may have (every recorded reply has exactly these). */
export const TOP_KEYS = ["id", "object", "created", "model", "choices", "usage"];
/** The only fields of choices[0]. logprobs must be null and finish_reason "stop". */
export const CHOICE_KEYS = ["index", "message", "finish_reason", "logprobs"];
/** Fields of choices[0].message that may carry a value; any other field must be null. */
export const MESSAGE_KEYS = ["role", "content"];
export const MAX_EVIDENCE_LINE = 10000;

// ASCII only, a plain space as the only separator, so JS and the contract (Rust) agree byte for byte.
const isHashText = (s) => typeof s === "string" && s.length <= 71 && /^[0-9A-Fa-f ]+$/.test(s) && s.replace(/ /g, "").length === 64;
const isBindingText = (s) => typeof s === "string" && s.length <= 160 && /^[A-Za-z0-9._| -]+$/.test(s);

/**
 * First duplicate object key anywhere in a JSON text (escapes decoded), or null. JSON.parse and serde_json both
 * keep the LAST value of a duplicated key, while the earlier value stays in the public transaction data, so a
 * duplicate could carry document text past every other check. The text must already be valid JSON.
 */
export function duplicateKey(text) {
  const stack = []; // per container: a Set of keys for an object, null for an array
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { stack.push(new Set()); expectKey = true; }
    else if (ch === "[") { stack.push(null); expectKey = false; }
    else if (ch === "}" || ch === "]") { stack.pop(); expectKey = false; }
    else if (ch === ",") { expectKey = stack.length > 0 && stack[stack.length - 1] !== null; }
    else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        const keys = stack[stack.length - 1];
        if (keys.has(key)) return key;
        keys.add(key);
        expectKey = false;
      }
      i = j;
    }
  }
  return null;
}

/** The model's JSON object inside the exact response body (code fences allowed), or null. */
export function replyObject(responseBody) {
  try {
    const msg = JSON.parse(responseBody).choices[0].message;
    const content = String(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return { msg, content, reply: JSON.parse(content) };
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
  const dupOuter = duplicateKey(responseBody);
  if (dupOuter !== null) return `response has a duplicate key: ${dupOuter}`;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "response is not a JSON object";
  for (const k of Object.keys(body)) if (!TOP_KEYS.includes(k)) return `response has a field outside the allowed list: ${k}`;
  if (!Array.isArray(body.choices) || body.choices.length !== 1) return "response must have exactly one choice";
  const choice = body.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return "response has no message";
  for (const k of Object.keys(choice)) if (!CHOICE_KEYS.includes(k)) return `choice has a field outside the allowed list: ${k}`;
  if (!("logprobs" in choice) || choice.logprobs !== null) return "choice logprobs must be null";
  if (choice.finish_reason !== "stop") return 'choice finish_reason must be "stop"';
  const msg = choice.message;
  if (!msg || typeof msg !== "object") return "response has no message";
  for (const [k, v] of Object.entries(msg)) if (!MESSAGE_KEYS.includes(k) && v !== null) return `message field ${k} must be empty`;
  const parsed = replyObject(responseBody);
  if (!parsed || typeof parsed.reply !== "object" || parsed.reply === null || Array.isArray(parsed.reply)) return "reply is not one JSON object";
  const r = parsed.reply;
  const dupInner = duplicateKey(parsed.content);
  if (dupInner !== null) return `reply has a duplicate key: ${dupInner}`;
  for (const k of Object.keys(r)) if (!REPLY_KEYS.includes(k)) return `reply has a key outside the allowed list: ${k}`;
  if (!isHashText(r.loan_hash)) return "loan_hash is not a 64-hex hash";
  if (!isBindingText(r.binding)) return "binding is not a binding";
  for (const k of CHECK_KEYS) if (k in r && r[k] !== "ok" && r[k] !== "fail") return `${k} must be ok or fail`;
  if ("duplicate_evidence_line" in r) {
    const n = r.duplicate_evidence_line;
    // The number must be written as a plain integer (12, not 12.0 or 1.2e1): the contract reads it as u64.
    const raw = /"duplicate_evidence_line"\s*:\s*(-?[0-9][0-9.eE+-]*)/.exec(parsed.content);
    const plain = !raw || /^[1-9][0-9]*$/.test(raw[1]);
    if (!(n === "ok" || (plain && Number.isInteger(n) && n >= 1 && n <= MAX_EVIDENCE_LINE))) return "duplicate_evidence_line must be a line number or ok";
  }
  if (r.verdict !== "pass" && r.verdict !== "flag") return "verdict must be pass or flag";
  // A pass needs all six checks present and ok: a pass beside a failed or missing check is a contradiction.
  if (r.verdict === "pass") for (const k of CHECK_KEYS) if (r[k] !== "ok") return `a pass needs all six checks ok; ${k} is ${k in r ? JSON.stringify(r[k]) : "missing"}`;
  if (!Array.isArray(r.anomalies) || !r.anomalies.every((a) => ANOMALY_CODES.includes(a))) return "anomalies must be known codes";
  return null;
}

/** The document as the model sees it: every line prefixed with its 1-based number. */
export const numberLines = (text) => text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
/** Line n (1-based) of the document, as numbered by numberLines. */
export const lineOf = (text, n) => text.split("\n")[n - 1];
