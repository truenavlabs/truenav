// The reply rule (owner decision 7 Nov): a signed TEE reply with anything beyond the allowed keys and value types
// is rejected, never rewritten, because the whole response body is public transaction data once submitted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { replyProblem, REPLY_KEYS, numberLines, lineOf } from "../reply.mjs";

const HASH = "35dc13ed 5a80fc57 2ef03276 6416d30d 67083674 f4b31371 73171a6f 7f7c8dcc";
const clean = {
  loan_hash: HASH, binding: "truenav-verdict-v1|registry.x.testnet|testnet|1796574097740",
  id_mismatch: "ok", asset_mismatch: "ok", amount_mismatch: "ok", duplicate_document: "ok", duplicate_evidence_line: "ok",
  injection_attempt: "ok", unreadable: "ok", verdict: "pass", anomalies: [],
};
const body = (reply, message = {}) => JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: typeof reply === "string" ? reply : JSON.stringify(reply), ...message }, finish_reason: "stop", logprobs: null }], model: "m", created: 1, usage: {} });

test("a clean reply passes, in fences too", () => {
  assert.equal(replyProblem(body(clean)), null);
  assert.equal(replyProblem(body("```json\n" + JSON.stringify(clean) + "\n```")), null);
  assert.equal(replyProblem(body({ ...clean, duplicate_document: "fail", duplicate_evidence_line: 12, verdict: "flag", anomalies: ["duplicate_document"] })), null);
});

test("the allowed list is exactly the prompt's keys", () => {
  assert.deepEqual(REPLY_KEYS, Object.keys(clean));
});

test("a reply echoing document_id, asset or amount is rejected (the 6 Nov leak)", () => {
  for (const k of ["document_id", "asset", "amount"]) assert.match(replyProblem(body({ ...clean, [k]: "TITLE-EVAL-132" })), /outside the allowed list/);
});

test("text smuggled in an allowed key's value is rejected", () => {
  assert.match(replyProblem(body({ ...clean, id_mismatch: "fail: Document id: TITLE-X" })), /must be ok or fail/);
  assert.match(replyProblem(body({ ...clean, duplicate_evidence_line: "line 4: CERTIFIED COPY of TITLE-1" })), /line number or ok/);
  assert.match(replyProblem(body({ ...clean, duplicate_evidence_line: 0 })), /line number or ok/);
  assert.match(replyProblem(body({ ...clean, anomalies: ["Borrower: Demo LLC"] })), /known codes/);
  assert.match(replyProblem(body({ ...clean, verdict: "pass, amount USD 1" })), /pass or flag/);
  assert.match(replyProblem(body({ ...clean, binding: "truenav-verdict-v1|x|testnet|1 Original principal: USD 5" })), /not a binding/);
  assert.match(replyProblem(body({ ...clean, loan_hash: "TITLE-EVAL-132" })), /64-hex/);
});

test("a non-empty provider field beside content is rejected; empty ones are fine", () => {
  assert.match(replyProblem(body(clean, { reasoning_content: "the document says USD 355,500" })), /must be empty/);
  assert.equal(replyProblem(body(clean, { reasoning_content: null, tool_calls: null })), null);
});

test("prose around the JSON, two choices or a non-object reply are rejected", () => {
  assert.match(replyProblem(body("Here is the verdict: " + JSON.stringify(clean))), /not one JSON object/);
  assert.match(replyProblem(body(JSON.stringify([clean]))), /not one JSON object/);
  const two = JSON.parse(body(clean));
  two.choices.push(two.choices[0]);
  assert.match(replyProblem(JSON.stringify(two)), /exactly one choice/);
});

test("the real 6 Nov TEE reply that echoed document fields is caught; the re-signed demo sets are clean", () => {
  const leaky = JSON.parse(readFileSync(new URL("../fixtures/leaky-reply-sandbox.json", import.meta.url), "utf8")).record;
  assert.match(replyProblem(leaky.response_body), /outside the allowed list/);
  for (const f of ["verdicts.json", "verdicts-sandbox.json", "verdicts-unit.json"]) {
    const v = JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
    assert.deepEqual(v.results.map((r) => replyProblem(r.onchain.response_body)).filter(Boolean), [], f);
  }
});

test("line numbers as the model sees them", () => {
  const doc = "A\nB stamp: CERTIFIED COPY\nC\n";
  assert.equal(numberLines(doc).split("\n")[1], "2: B stamp: CERTIFIED COPY");
  assert.equal(lineOf(doc, 2), "B stamp: CERTIFIED COPY");
});
