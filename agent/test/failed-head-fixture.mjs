// Shared fixture for the failed-head tests (agent and API). Not a test file.
import { createHash } from "node:crypto";
import { canonical } from "../../api/receipt.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// The row the receipt contract stores in stamp_failure (receipts/src/lib.rs), for a v3 or a v2 token.
export function failedHead(token, { v3 = true, bodyToken = token, recordToken = token } = {}) {
  const method = v3 ? "truenav-v3.0.1" : "cashflow-v2.1.0";
  const body = {
    receipt_version: v3 ? "3" : "2", token_id: bodyToken, seq: v3 ? "2" : 2, head_status: "failed", failure_code: "engine_error",
    score: null, band: "red", caps: [], holds: [], method_version: method, method, engine_version_key: "ab".repeat(32),
    valuation_time: "2026-11-01T00:00:00Z", as_of: "2026-11-01T00:00:00Z", prev_receipt_sha256: "cd".repeat(32),
  };
  const receipt = canonical(body);
  return { token_id: recordToken, seq: 2, request_id: 2, method, version_key: "ab".repeat(32), score: 0, band: "red", period: "2026-10-01/2026-10-31", as_of: body.as_of, caps: [], holds: [], receipt_sha256: sha(receipt), receipt, requested_ns: 1, stored_ns: 2, block_height: 100 };
}
