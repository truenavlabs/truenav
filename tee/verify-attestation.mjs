// Check the TEE attestation yourself, no API key needed (owner instruction 6 Nov: "check it", not "trust us").
//
//   npm run verify:attestation                                   the current registry's recorded set (tee/status.json)
//   npm run verify:attestation -- --contract registry.tnlab-718ca9.testnet    the earlier instance's recorded set
//   (--verdicts <path> and --report <path> override the files; TRUENAV_CONTRACT, TRUENAV_VERDICTS and TRUENAV_REPORT still work)
//
// 1. Decodes the published NEAR AI Cloud attestation report (tee/fixtures/attestation-report-368aa2.json.b64) and checks
//    its sha256 equals the hash recorded with the verdicts, and the hash the live contract stores for its TEE
//    signer (get_tee_signers on the live contract, read over public RPC).
// 2. Re-verifies the report: Intel TDX quote and collateral (Phala PCCS), TCB status, debug off, the signing key
//    and the request nonce bound in the quote's report data, MRCONFIGID and RTMR3, NVIDIA GPU evidence (NRAS).
// 3. Checks the attested signing key is the key that signed every recorded verdict, and the key the contract
//    accepts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyReport } from "./attest.mjs";
import { view, DEFAULT_RPC } from "../web/chain.mjs";
import { resolveSet } from "./recorded-set.mjs";

const root = new URL("../", import.meta.url);
// Which recorded set follows the contract (tee/recorded-set.mjs): no environment variables are needed for the current registry.
let set;
try {
  set = resolveSet({ argv: process.argv.slice(2), env: process.env, root });
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exit(1);
}
const raw = Buffer.from(readFileSync(new URL(set.reportPath, root), "utf8").replace(/\s+/g, ""), "base64");
const sha = createHash("sha256").update(raw).digest("hex");
const tee = JSON.parse(readFileSync(new URL(set.verdictsPath, root), "utf8"));
const contract = set.contract;
console.log(`contract ${contract}; recorded set ${set.verdictsPath} (${set.which})`);
let ok = true;
const line = (pass, what) => {
  console.log(`${pass ? "PASS" : "FAIL"} ${what}`);
  ok &&= !!pass;
};

line(sha === tee.attestation.report_sha256, `published report sha256 ${sha.slice(0, 16)}... matches the recorded verdicts`);
let onchain = null;
try {
  onchain = (await view(contract, "get_tee_signers", {}, process.env.TRUENAV_RPC || DEFAULT_RPC)).find((t) => t.attestation_sha256 === sha) || null;
  line(!!onchain, `${contract} stores this report hash for TEE signer ${onchain ? onchain.address : "(none)"}`);
} catch (e) {
  line(false, `could not read ${contract}: ${e.message}`);
}

const body = JSON.parse(raw.toString("utf8"));
const nonce = tee.attestation.nonce;
console.log(`Re-verifying the report (nonce ${nonce.slice(0, 16)}..., captured ${tee.attestation.checked_at})`);
const res = await verifyReport(body, nonce, tee.model);
for (const s of res.sections) {
  console.log(`  ${s.name}${s.signer ? `  signer ${s.signer.signing_address}` : ""}`);
  for (const c of s.checks) line(c.pass, `  ${c.check}${c.detail ? "  " + c.detail : ""}`);
}
const signer = (res.signers[0] || {}).signing_address?.toLowerCase();
const verdictSigners = new Set(tee.results.map((r) => r.onchain.signer.toLowerCase()));
line(signer && verdictSigners.size === 1 && verdictSigners.has(signer), `the attested model key signed all ${tee.results.length} recorded verdicts`);
line(onchain && signer === onchain.address, "the contract accepts exactly that key");
console.log(ok ? "Attestation verified: the key that signs TrueNav verdicts runs in an attested NEAR AI Cloud TEE." : "Attestation NOT verified.");
process.exitCode = ok ? 0 : 1;
