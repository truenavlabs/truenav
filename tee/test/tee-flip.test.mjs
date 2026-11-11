// tee/flip.mjs: one-command pending -> live flip. Runs on temporary trees with a synthetic signed set; no network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { planFlip, writeFlip, linesToEdit, liveStatus, DEFAULT_VERDICTS, DEFAULT_REPORT } from "../flip.mjs";
import { checkStatus, renderStatusDoc } from "../status.mjs";
import { syntheticSet, REGISTRY, SIGNED_AT, SIGNER, REPORT_B64, REPORT_SHA } from "./synthetic-set.mjs";
import { VERDICT_TTL_MS } from "../underwrite.mjs";

const NOW = SIGNED_AT + 86400000;
const TX = "9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE";
const PENDING = { registry: REGISTRY, tee: "pending", verdicts_file: null, report_file: null, earlier_instance: "registry.tnlab-718ca9.testnet" };

function tree({ withFiles = true, set = syntheticSet(), docs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tee-flip-"));
  mkdirSync(join(dir, "tee/fixtures"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "tee/status.json"), `${JSON.stringify(PENDING, null, 2)}\n`);
  if (withFiles) {
    writeFileSync(join(dir, DEFAULT_VERDICTS), JSON.stringify(set));
    writeFileSync(join(dir, DEFAULT_REPORT), REPORT_B64);
  }
  for (const [f, text] of Object.entries(docs)) writeFileSync(join(dir, f), text);
  return { dir, root: pathToFileURL(`${dir}/`), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("with the two files in place the flip plan is clean and the status is live for the same registry", () => {
  const t = tree();
  try {
    const plan = planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX });
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.status, {
      registry: REGISTRY, tee: "live", verdicts_file: DEFAULT_VERDICTS, report_file: DEFAULT_REPORT, earlier_instance: "registry.tnlab-718ca9.testnet",
      model: "synthetic/test-model", tee_signer: SIGNER, report_sha256: REPORT_SHA, add_tee_signer_tx: TX, expires_at_ms: SIGNED_AT + VERDICT_TTL_MS,
    });
    assert.equal(plan.summary.records, 3);
    assert.equal(plan.summary.traps, 1);
    // without the transaction hash the plan is refused: the files cannot give it
    assert.ok(planFlip({ root: t.root, nowMs: NOW }).problems.some((p) => p.includes("add_tee_signer_tx must be a NEAR transaction hash")));
  } finally { t.done(); }
});

test("writeFlip writes the live status and the doc that the status renders, and the result passes checkStatus", () => {
  const t = tree();
  try {
    const plan = planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX });
    writeFlip(plan, t.root);
    const written = JSON.parse(readFileSync(join(t.dir, "tee/status.json"), "utf8"));
    assert.equal(written.tee, "live");
    assert.equal(readFileSync(join(t.dir, "docs/TEE_STATUS.md"), "utf8"), renderStatusDoc(written, checkStatus(written, { root: t.root, nowMs: NOW }).verdicts));
    assert.deepEqual(checkStatus(written, { root: t.root, nowMs: NOW }).problems, []);
    // a second flip is refused: it is already live
    assert.ok(planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX }).problems.some((p) => /already live/.test(p)));
  } finally { t.done(); }
});

test("missing files, a set for another registry, a tampered signature and a stale set are all refused", () => {
  let t = tree({ withFiles: false });
  try {
    const p = planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX }).problems;
    assert.equal(p.length, 2); assert.match(p[0], /does not exist: put it in the branch first/);
  } finally { t.done(); }
  t = tree({ set: syntheticSet({ contract: "registry.tnlab-718ca9.testnet" }) });
  try { assert.ok(planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX }).problems.some((p) => /contract_id is registry\.tnlab-718ca9\.testnet, expected/.test(p))); } finally { t.done(); }
  const bad = syntheticSet();
  bad.results[0].onchain.response_body += " ";
  t = tree({ set: bad });
  try { assert.ok(planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX }).problems.some((p) => /signature does not recover/.test(p))); } finally { t.done(); }
  t = tree();
  try { assert.ok(planFlip({ root: t.root, nowMs: SIGNED_AT + 25 * 86400000, addSignerTx: TX }).problems.some((p) => /days left/.test(p))); } finally { t.done(); }
  t = tree();
  try {
    writeFileSync(join(t.dir, DEFAULT_REPORT), Buffer.from("another report").toString("base64"));
    assert.ok(planFlip({ root: t.root, nowMs: NOW, addSignerTx: TX }).problems.some((p) => /has sha256 .* but .* records/.test(p)));
  } finally { t.done(); }
});

test("linesToEdit lists the exact pending phrases (MUST) and the looser candidates (CHECK) with file and line", () => {
  const t = tree({ docs: {
    "README.md": "# t\nTEE verdicts pending (11 Harbor)\nplain line\n| claim | TEE verdicts for this contract are pending / not run. |\n",
    "TRUST_MODEL.md": "nothing here\nverdicts are not yet recorded for this registry\n",
    "ARCHITECTURE.md": "clean\n",
  } });
  mkdirSync(join(t.dir, "certify"), { recursive: true });
  writeFileSync(join(t.dir, "certify/check-chain-replies.mjs"), "// while the TEE status says pending, history lives elsewhere\n");
  try {
    const { exact, loose } = linesToEdit(t.root);
    assert.deepEqual(exact.map((h) => `${h.file}:${h.line}`), ["README.md:2", "README.md:4"]);
    assert.deepEqual(loose.map((h) => `${h.file}:${h.line}`), ["TRUST_MODEL.md:2", "certify/check-chain-replies.mjs:1"]);
  } finally { t.done(); }
});

test("the CLI on this repository (already live) refuses a second flip and never writes", () => {
  const cli = fileURLToPath(new URL("../flip.mjs", import.meta.url));
  const before = readFileSync(new URL("../status.json", import.meta.url), "utf8");
  // the repository is already live: a flip is refused and nothing is written
  const r = spawnSync(process.execPath, [cli, "--add-signer-tx", TX], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL tee\/status\.json is already live/);
  assert.equal(readFileSync(new URL("../status.json", import.meta.url), "utf8"), before);
  assert.equal(spawnSync(process.execPath, [cli, "--nope"], { encoding: "utf8" }).status, 2);
});
