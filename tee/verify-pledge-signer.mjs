// Re-check pledge-signer attestation evidence offline.
//
//   npm run verify:pledge-signer
//   node tee/verify-pledge-signer.mjs <evidence.json> <expected.json>
//
// What this checks: the sha256 of the evidence file equals expected.attestation_sha256, the recorded
// signing address matches, and tcb_status is UpToDate.
// What this does not check: it does not verify Intel hardware, it does not call OutLayer, it does not read
// the chain, and it does not prove the signer holds a loan. It works on local files only. Whether the registry
// stores this hash for the signer is a separate read (get_pledge_signers); this script does not make it.
// Anyone can repeat this script.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidencePath = process.argv[2] || `${root}tee/fixtures/pledge-signer/evidence.json`;
const expectedPath = process.argv[3] || `${root}tee/fixtures/pledge-signer/expected.json`;

const bytes = readFileSync(evidencePath);
const evidence = JSON.parse(bytes.toString("utf8"));
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const hash = createHash("sha256").update(bytes).digest("hex");
const problems = [];
if (hash !== expected.attestation_sha256) problems.push(`sha256 ${hash} != expected ${expected.attestation_sha256}`);
if (String(evidence.signing_address || "").toLowerCase() !== String(expected.signing_address || "").toLowerCase()) problems.push("signing_address does not match expected");
if (evidence.tcb_status !== "UpToDate") problems.push(`tcb_status is ${evidence.tcb_status}, want UpToDate`);
if (!evidence.signing_address) problems.push("signing_address missing");
if (problems.length) {
  console.log("verify:pledge-signer FAIL");
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log("verify:pledge-signer PASS");
console.log(`  evidence sha256 ${hash}`);
console.log(`  signing_address ${evidence.signing_address}`);
console.log("  checked: file hash, address, tcb_status UpToDate");
console.log("  not checked: hardware quote, module measurement, loan holding, the registry or any chain state");
console.log("  chain: not read. This script uses local files only; it does not confirm that the registry stores this hash.");
