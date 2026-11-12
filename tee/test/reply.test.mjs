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

test("shared reply cases: the JS rule gives the expected verdict on every case (same file as the contract test)", () => {
  const { cases } = JSON.parse(readFileSync(new URL("../../contract/tests/fixtures/reply-cases.json", import.meta.url), "utf8"));
  for (const c of cases) assert.equal(replyProblem(c.body) === null, c.accept, `${c.name}: ${replyProblem(c.body)}`);
});

// N-03: the NEAR AI Cloud response around the reply has a fixed shape. Client side only; the contract is unchanged.
const wrapped = (edit) => { const b = JSON.parse(body(clean)); edit(b); return JSON.stringify(b); };

test("N-03 an unknown top-level field is refused, whatever its value", () => {
  for (const [k, v] of [["system_fingerprint", "fp_1"], ["prompt_logprobs", null], ["kv_transfer_params", {}], ["service_tier", "default"], ["debug", "Original principal: USD 355,500"]]) {
    assert.match(replyProblem(wrapped((b) => { b[k] = v; })), new RegExp(`response has a field outside the allowed list: ${k}`), k);
  }
  assert.match(replyProblem(JSON.stringify([JSON.parse(body(clean))])), /not a JSON object/);
});

test("N-03 an unknown field in the choice is refused", () => {
  for (const [k, v] of [["stop_reason", null], ["reasoning", "the title says USD 1"], ["matched_stop", 1]]) {
    assert.match(replyProblem(wrapped((b) => { b.choices[0][k] = v; })), new RegExp(`choice has a field outside the allowed list: ${k}`), k);
  }
});

test("N-03 logprobs must be present and null", () => {
  assert.match(replyProblem(wrapped((b) => { delete b.choices[0].logprobs; })), /logprobs must be null/);
  for (const v of [{ content: [{ token: "USD", logprob: -0.1 }] }, [], 0, "", false]) {
    assert.match(replyProblem(wrapped((b) => { b.choices[0].logprobs = v; })), /logprobs must be null/, JSON.stringify(v));
  }
});

test('N-03 finish_reason must be "stop"', () => {
  for (const v of ["length", "tool_calls", "content_filter", null, "STOP", " stop"]) {
    assert.match(replyProblem(wrapped((b) => { b.choices[0].finish_reason = v; })), /finish_reason must be "stop"/, JSON.stringify(v));
  }
  assert.match(replyProblem(wrapped((b) => { delete b.choices[0].finish_reason; })), /finish_reason must be "stop"/);
});

test("N-03 every allowed field may be present: the clean reply carries all of them and passes", () => {
  const b = JSON.parse(body(clean));
  assert.deepEqual(Object.keys(b).sort(), ["choices", "created", "id", "model", "object", "usage"]);
  assert.deepEqual(Object.keys(b.choices[0]).sort(), ["finish_reason", "index", "logprobs", "message"]);
  assert.equal(replyProblem(JSON.stringify(b)), null);
});

// N-04: a pass is accepted only if all six checks are present and ok.
test("N-04 a pass with 5 of 6 checks ok and one failed is refused, for each check", () => {
  for (const k of ["id_mismatch", "asset_mismatch", "amount_mismatch", "duplicate_document", "injection_attempt", "unreadable"]) {
    assert.match(replyProblem(body({ ...clean, [k]: "fail" })), new RegExp(`a pass needs all six checks ok; ${k} is "fail"`), k);
  }
});

test("N-04 a pass with a check missing is refused; a flag with a failed check still passes", () => {
  for (const k of ["id_mismatch", "unreadable"]) {
    const { [k]: _gone, ...rest } = clean;
    assert.match(replyProblem(body(rest)), new RegExp(`${k} is missing`), k);
  }
  assert.equal(replyProblem(body({ ...clean, amount_mismatch: "fail", verdict: "flag", anomalies: ["amount_mismatch"] })), null);
});
