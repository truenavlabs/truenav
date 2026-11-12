// tee/tx-review.mjs: the pure review of a `tx` RPC result, and the CLI's argument handling. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewTx } from "../tx-review.mjs";
import { syntheticSet, REGISTRY, SIGNER, REPORT_SHA } from "./synthetic-set.mjs";

const call = (method_name, args, deposit = "1") => ({ FunctionCall: { method_name, args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 30000000000000, deposit } });
const tx = ({ actions, status = { SuccessValue: "" }, receiver = REGISTRY, receipts = [{ id: "ReceiptId1111111111", outcome: { executor_id: REGISTRY, logs: [], status: { SuccessValue: "" } } }] }) => ({
  final_execution_status: "FINAL", status,
  transaction: { hash: "H".repeat(44), signer_id: "servicer.testnet", public_key: "ed25519:xyz", receiver_id: receiver, actions },
  transaction_outcome: { block_hash: "B".repeat(44) }, receipts_outcome: receipts,
});

test("a successful submit_verdict matching a record in the file passes, and the reply body is not printed", () => {
  const file = syntheticSet();
  const r0 = file.results[0];
  const res = tx({ actions: [call("submit_verdict", { loan_hash: r0.loan_hash, model_id: file.model, request_sha256: r0.onchain.request_sha256, response_body: r0.onchain.response_body, signature: r0.onchain.signature })] });
  const out = reviewTx(res, { file, expectReceiver: REGISTRY, expectMethod: "submit_verdict" });
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
  const text = out.lines.join("\n");
  assert.match(text, /SUCCESS/); assert.match(text, /matches verdicts file record S-0 \(pass\)/);
  assert.ok(!text.includes("chatcmpl-synthetic"), "the response body must not be printed");
});

test("a failed transaction, a wrong receiver or method, and a record that is not in the file are reported", () => {
  const file = syntheticSet();
  const r0 = file.results[0];
  const args = { loan_hash: r0.loan_hash, model_id: file.model, request_sha256: r0.onchain.request_sha256, response_body: r0.onchain.response_body, signature: r0.onchain.signature };
  let out = reviewTx(tx({ actions: [call("submit_verdict", args)], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: TEE signer not registered" } } } } } }), { file });
  assert.equal(out.ok, false); assert.match(out.lines[0], /FAILED/); assert.ok(out.problems.includes("the transaction did not succeed"));
  out = reviewTx(tx({ actions: [call("pause", {})], receiver: "registry.other.testnet" }), { expectReceiver: REGISTRY, expectMethod: "submit_verdict" });
  assert.equal(out.problems.length, 2);
  out = reviewTx(tx({ actions: [call("submit_verdict", { ...args, response_body: "{}" })] }), { file });
  assert.ok(out.problems.includes("no record in the verdicts file has this response body"));
  out = reviewTx(tx({ actions: [call("submit_verdict", { ...args, signature: "0x00" })] }), { file });
  assert.ok(out.problems.includes("signature differs from the file record"));
  out = reviewTx(tx({ actions: [call("pause", {})], receipts: [{ id: "R2222222222222", outcome: { executor_id: REGISTRY, logs: [], status: { Failure: { x: 1 } } } }] }), {});
  assert.ok(out.problems.some((p) => /a receipt on .* failed/.test(p)));
});

test("add_tee_signer is compared with the file's signer, model and report hash", () => {
  const file = syntheticSet();
  const good = { address: SIGNER, model_id: file.model, attestation_ref: "ref", attestation_sha256: REPORT_SHA };
  assert.deepEqual(reviewTx(tx({ actions: [call("add_tee_signer", good)] }), { file }).problems, []);
  const out = reviewTx(tx({ actions: [call("add_tee_signer", { ...good, address: "0x" + "3".repeat(40), model_id: "x", attestation_sha256: "0".repeat(64) })] }), { file });
  assert.equal(out.problems.length, 3);
});

test("the CLI needs a transaction hash and a sender, and exits 2 otherwise, before any network access", () => {
  const cli = fileURLToPath(new URL("../tx-review.mjs", import.meta.url));
  for (const argv of [[], ["abc"], ["H".repeat(44)], ["H".repeat(44), "--sender", "a.testnet", "--nope"], ["--sender", "a.testnet"]]) {
    const r = spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, JSON.stringify(argv)); assert.match(r.stderr, /usage: npm run tee:tx-review/);
  }
});
