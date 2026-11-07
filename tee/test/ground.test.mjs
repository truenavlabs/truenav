// Owner decision 7 Nov: a duplicate flag without a valid evidence line counts as ok at the eval level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groundVerdict, evidenceHolds } from "../eval/ground.mjs";

const doc = "DEMO\nDocument id: TITLE-1\nOriginal principal: USD 1.00\nStamp: CERTIFIED COPY of TITLE-0\nNote: re-issued after loss\nDEMO\n";
const dup = (line, extra = []) => ({ verdict: "flag", anomalies: ["duplicate_document", ...extra], duplicate_evidence_line: line });

test("a duplicate flag pointing at a line with the phrase stays a flag", () => {
  assert.deepEqual(groundVerdict(dup(4), doc), { verdict: "flag", anomalies: ["duplicate_document"], dropped: false });
  assert.equal(groundVerdict(dup(5), doc).verdict, "flag");
});

test("a duplicate flag without a quoted line counts as ok", () => {
  for (const line of [undefined, null, "ok", 0, -1, 2.5, "4"]) {
    assert.deepEqual(groundVerdict(dup(line), doc), { verdict: "pass", anomalies: [], dropped: true }, `line ${line}`);
  }
});

test("a duplicate flag pointing at a line without the phrase counts as ok", () => {
  assert.equal(groundVerdict(dup(3), doc).verdict, "pass"); // "Original principal" is not a duplicate marker
  assert.equal(groundVerdict(dup(99), doc).verdict, "pass"); // no such line
});

test("other codes are kept when an ungrounded duplicate code is dropped", () => {
  assert.deepEqual(groundVerdict(dup(3, ["amount_mismatch"]), doc), { verdict: "flag", anomalies: ["amount_mismatch"], dropped: true });
});

test("verdicts without a duplicate code are untouched", () => {
  const v = { verdict: "flag", anomalies: ["injection_attempt"], duplicate_evidence_line: "ok" };
  assert.deepEqual(groundVerdict(v, doc), { verdict: "flag", anomalies: ["injection_attempt"], dropped: false });
  assert.deepEqual(groundVerdict({ verdict: "pass", anomalies: [] }, doc), { verdict: "pass", anomalies: [], dropped: false });
});

test("the phrases match exactly as the prompt defines them", () => {
  assert.equal(evidenceHolds("certified copy furnished\n", 1), false);
  assert.equal(evidenceHolds("RE-ISSUED\n", 1), false);
  assert.equal(evidenceHolds("a CERTIFIED COPY\n", 1), true);
});
