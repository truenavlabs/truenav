// Record the attestation evidence as a committed snapshot (web/data/recorded/attestation-evidence.json), the same way
// judge/run.mjs records web/data/recorded/judge-replay.json: the evidence is hashed, and the time it was generated is
// kept outside the hash so a re-run on the same evidence gives the same evidence_hash.
//
//   npm run record:attestation     runs npm run verify:fingerprints and npm run verify:attestation (network needed:
//                                  OutLayer, Intel collateral, NVIDIA, NEAR RPC), and writes the snapshot only if both
//                                  fully pass. A failing run writes nothing. A dirty tree is refused.
//
// The snapshot lists the commands, every check that ran, the recorded hashes recomputed from the committed files, and
// two fixed lists: what the checks prove and what they do not. Nothing here is typed by hand from a run.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonical } from "../judge/lib.mjs";

export const SNAPSHOT_SCHEMA = "truenav-attestation-evidence/v1";
export const SNAPSHOT_PATH = "web/data/recorded/attestation-evidence.json";
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");

/** What each recorded fingerprint check covers, in tee/fingerprint.mjs checkFingerprint and tee/verify-fingerprints.mjs. */
export const CHECKS_PER_RECORD = [
  "document id is canonical",
  "no unframed free fields in the task hash (RT3-01)",
  "the TDX quote's report_data commits to this run (wasm, input, output, caller, project)",
  "the pinned fingerprint wasm ran",
  "input hash matches the recorded input",
  "output hash matches the recorded loan_hash",
  "Intel TDX quote verified",
  "worker measurements are on the approved list (worker.outlayer.testnet)",
];

export const PROVES = [
  "For each of the 17 recorded loan fingerprints, the pinned fingerprint module ran inside an Intel TDX worker whose quote verifies against Intel collateral (TCB UpToDate), on the recorded input, and produced the recorded loan hash.",
  "Each worker's measurements are on the approved list that worker.outlayer.testnet publishes on chain.",
  "The published NEAR AI Cloud attestation report hashes to the value the registry stores for the TEE signer, and the attested signing key is that registered signer.",
  "In that report the Intel TDX quote verifies, debug mode is off, the signing key and our nonce are bound in the quote, MRCONFIGID and RTMR3 match the report's own compose file and event log, and the NVIDIA verdict read from NRAS is true.",
  "That signing key signed all 19 recorded verdicts.",
];

export const NOT_PROVES = [
  "That the underwriter model's judgment is right. A TEE shows which code ran on which hardware, not that the answer is correct.",
  "Which model image runs. MRTD, RTMR0 to RTMR2 and the compose hash of the NEAR AI Cloud report are not compared with published values (known limit N-06).",
  "The NVIDIA token's own signature, issuer, expiry and per-GPU tokens. Only the overall result is read (known limit N-05).",
  "That the report's TLS certificate matches the live HTTPS connection to NEAR AI Cloud.",
  "Which prompt the servicer sent. A signed pass shows that the attested model replied to a request with that hash.",
  "That the registry holds these fingerprints. The fingerprint check reads no pledge state from the chain; it shows where the recorded loan hashes came from.",
  "That the hardware itself is sound. Intel TDX and NVIDIA confidential computing, and the vendors' attestation services, are assumptions.",
  "That anything was re-run just now. This is a recorded run; repeat it with the two commands above.",
];

const PASS_FAIL = /^(PASS|FAIL) (.*)$/;

export function parseFingerprintOutput(text) {
  const out = { records: [], failures: [], distinctQuotes: null, approvedSets: null, loansChecked: null, loansOk: false, finalOk: false };
  for (const line of String(text).split(/\r?\n/)) {
    let m = /^(PASS|FAIL) ([A-Z0-9-]+) -> ([0-9a-f]{16})\.\.\./.exec(line);
    if (m) { out.records.push({ document_id: m[2], loan_hash_prefix: m[3], pass: m[1] === "PASS" }); if (m[1] === "FAIL") out.failures.push(line); continue; }
    m = /^(PASS|FAIL) tee\/loans\.json uses the attested fingerprints for all (\d+) loans/.exec(line);
    if (m) { out.loansChecked = Number(m[2]); out.loansOk = m[1] === "PASS"; continue; }
    m = /^(\d+) distinct TDX quotes verified with Intel collateral; (\d+) approved worker measurement sets read from chain$/.exec(line);
    if (m) { out.distinctQuotes = Number(m[1]); out.approvedSets = Number(m[2]); continue; }
    if (line === "Fingerprints verified: every loan_hash came from the attested OutLayer TEE.") out.finalOk = true;
    if (line.startsWith("FAIL ")) out.failures.push(line);
  }
  return out;
}

export function parseAttestationOutput(text) {
  const out = { contract: null, recordedSet: null, capturedAt: null, nonceMatch: null, signer: null, verdictsSigned: null, checks: [], failures: [], finalOk: false, reportShaPrefix: null };
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    let m = /^contract (\S+); recorded set (\S+) /.exec(line);
    if (m) { out.contract = m[1]; out.recordedSet = m[2]; continue; }
    m = /^Re-verifying the report \(nonce ([0-9a-f]+)\.\.\., captured (\S+)\)$/.exec(line);
    if (m) { out.nonceMatch = m[1]; out.capturedAt = m[2]; continue; }
    m = /^  (?!PASS|FAIL)(\S.*)$/.exec(line);
    if (m) {
      const sec = m[1].replace(/\s+signer (0x[0-9a-f]{40})$/, (_, a) => { out.signer = a; return ""; });
      section = sec; continue;
    }
    m = PASS_FAIL.exec(line);
    if (m) {
      const pass = m[1] === "PASS";
      const body = m[2];
      const indented = body.startsWith("  ");
      const check = { section: indented ? section : null, text: body.trim(), pass };
      const r = /^the attested model key signed all (\d+) recorded verdicts/.exec(check.text);
      if (r) out.verdictsSigned = Number(r[1]);
      const s = /^published report sha256 ([0-9a-f]{16})\.\.\./.exec(check.text);
      if (s) out.reportShaPrefix = s[1];
      out.checks.push(check);
      if (!pass) out.failures.push(line);
      continue;
    }
    if (line.startsWith("Attestation checks passed:")) out.finalOk = true;
  }
  return out;
}

export function snapshotHash(snapshot) {
  const { ephemeral, evidence_hash, ...hashed } = snapshot;
  return sha256hex(canonical(hashed));
}

/** Build the snapshot from the two outputs. Throws on anything that did not fully pass or does not tie to the committed files. */
export function buildSnapshot({ fingerprintOut, attestationOut, fingerprintExit, attestationExit, commit, treeClean, generatedAt, wallMs, node, root }) {
  const read = (p) => readFileSync(new URL(p, root), "utf8");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit is not a 40 hex sha: ${commit}`);
  if (fingerprintExit !== 0) throw new Error(`verify:fingerprints exit ${fingerprintExit}: nothing recorded`);
  if (attestationExit !== 0) throw new Error(`verify:attestation exit ${attestationExit}: nothing recorded`);
  const fpOut = parseFingerprintOutput(fingerprintOut);
  const attOut = parseAttestationOutput(attestationOut);
  if (fpOut.failures.length || !fpOut.finalOk || !fpOut.loansOk) throw new Error(`fingerprint check did not fully pass: ${fpOut.failures[0] || "no final success line"}`);
  if (attOut.failures.length || !attOut.finalOk) throw new Error(`attestation check did not fully pass: ${attOut.failures[0] || "no final success line"}`);
  const fp = JSON.parse(read("tee/fixtures/fingerprints.json"));
  if (fpOut.records.length !== fp.records.length) throw new Error(`records: the check printed ${fpOut.records.length}, tee/fixtures/fingerprints.json has ${fp.records.length}`);
  if (fpOut.distinctQuotes !== fp.records.length) throw new Error(`quotes: ${fpOut.distinctQuotes} distinct quotes verified for ${fp.records.length} records`);
  const records = fp.records.map((r, i) => {
    const p = fpOut.records[i];
    if (p.document_id !== r.document_id || !r.loan_hash.startsWith(p.loan_hash_prefix)) throw new Error(`records: line ${i + 1} (${p.document_id}) does not match tee/fixtures/fingerprints.json`);
    return { document_id: r.document_id, asset_type: r.asset_type, loan_hash: r.loan_hash, call_id: r.call_id, proof_url: `${fp.api}/attestations/by-call/${r.call_id}`, pass: true };
  });
  const status = JSON.parse(read("tee/status.json"));
  if (attOut.contract !== status.registry) throw new Error(`attestation checked ${attOut.contract}, tee/status.json names ${status.registry}`);
  const verdicts = JSON.parse(read(attOut.recordedSet));
  const raw = Buffer.from(read("tee/fixtures/attestation-report-368aa2.json.b64").replace(/\s+/g, ""), "base64");
  const reportSha = sha256hex(raw);
  if (!reportSha.startsWith(attOut.reportShaPrefix || "?") || reportSha !== verdicts.attestation.report_sha256) throw new Error("report: the published report hash does not match the committed file");
  if (!verdicts.attestation.nonce.startsWith(attOut.nonceMatch || "?")) throw new Error("nonce: the checked nonce does not match the recorded verdicts");
  if (attOut.verdictsSigned !== verdicts.results.length) throw new Error(`verdicts: the check covered ${attOut.verdictsSigned}, the recorded set has ${verdicts.results.length}`);
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    commit,
    tree_clean: !!treeClean,
    ok: true,
    commands: ["npm run verify:fingerprints", "npm run verify:attestation"],
    outlayer: {
      project: fp.project,
      wasm_sha256: fp.wasm_sha256,
      api: fp.api,
      worker_registry: "worker.outlayer.testnet",
      loans_checked: fpOut.loansChecked,
      distinct_quotes: fpOut.distinctQuotes,
      approved_measurement_sets: fpOut.approvedSets,
      checks_per_record: [...CHECKS_PER_RECORD],
      records,
    },
    near_ai: {
      contract: attOut.contract,
      recorded_set: attOut.recordedSet,
      model: verdicts.model,
      signer: attOut.signer,
      report_sha256: reportSha,
      nonce: verdicts.attestation.nonce,
      report_captured_at: attOut.capturedAt,
      verdicts_signed: attOut.verdictsSigned,
      checks: attOut.checks.map(({ section, text, pass }) => ({ section, check: text, pass })),
    },
    proves: [...PROVES],
    not_proves: [...NOT_PROVES],
    ephemeral: { generated_at: generatedAt, wall_ms: wallMs, node },
  };
  snapshot.evidence_hash = snapshotHash(snapshot);
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL("../", import.meta.url);
  const cwd = fileURLToPath(root);
  const git = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  const dirty = git("status", "--porcelain").stdout.trim();
  if (dirty && !process.argv.includes("--allow-dirty")) {
    console.error("refusing to record: the working tree has uncommitted changes, so the commit would not name the code that was checked. Commit first, or pass --allow-dirty and the snapshot says tree_clean false.");
    process.exit(2);
  }
  const t0 = Date.now();
  const run = (script) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8", timeout: 300_000 });
  const fp = run("tee/verify-fingerprints.mjs");
  const att = run("tee/verify-attestation.mjs");
  try {
    const snap = buildSnapshot({
      fingerprintOut: fp.stdout, attestationOut: att.stdout, fingerprintExit: fp.status, attestationExit: att.status,
      commit: git("rev-parse", "HEAD").stdout.trim(), treeClean: !dirty, generatedAt: new Date().toISOString(), wallMs: Date.now() - t0, node: process.version, root,
    });
    writeFileSync(new URL(SNAPSHOT_PATH, root), JSON.stringify(snap, null, 2) + "\n");
    console.log(`recorded ${SNAPSHOT_PATH}: ${snap.outlayer.records.length} OutLayer records, ${snap.near_ai.checks.length} NEAR AI checks, commit ${snap.commit.slice(0, 7)}, evidence_hash ${snap.evidence_hash}`);
  } catch (e) {
    console.error(`not recorded: ${e.message}`);
    process.exit(1);
  }
}
