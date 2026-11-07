// No-key check of every recorded loan fingerprint (owner decision D1): for each loan in tee/fixtures/fingerprints.json
// fetch the public OutLayer attestation of its run and check that the pinned wasm ran in the fingerprint project for
// the servicer, on the recorded input, with the recorded loan_hash as output, inside a verified Intel TDX worker; and
// that tee/loans.json uses exactly these fingerprints.    npm run verify:fingerprints
import { readFileSync } from "node:fs";
import { getCollateralAndVerify } from "@phala/dcap-qvl";
import { attestationOf, checkFingerprint, quoteFields } from "./fingerprint.mjs";
import { view, DEFAULT_RPC } from "../web/chain.mjs";

const root = new URL("../", import.meta.url);
const fp = JSON.parse(readFileSync(new URL("tee/fixtures/fingerprints.json", root), "utf8"));
const { loans } = JSON.parse(readFileSync(new URL("tee/loans.json", root), "utf8"));
// The OutLayer worker registry publishes the approved worker measurements (MRTD and RTMR0 to RTMR3).
const approved = await view(process.env.TRUENAV_OUTLAYER_WORKER || "worker.outlayer.testnet", "get_approved_measurements", {}, process.env.TRUENAV_RPC || DEFAULT_RPC);
const isApproved = (m) => approved.some((a) => ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"].every((k) => String(a[k]).toLowerCase() === m[k]));
let ok = true;
const verified = new Map(); // every distinct quote is checked with Intel collateral (7 Nov audit: not only the first two)
for (const rec of fp.records) {
  const att = await attestationOf(rec.call_id);
  const lines = await checkFingerprint(rec, att, async (quote) => {
    const k = quote.toString("base64");
    if (!verified.has(k)) verified.set(k, await getCollateralAndVerify(quote));
    return verified.get(k);
  });
  lines.push([isApproved(quoteFields(Buffer.from(att.tdx_quote, "base64"))), "worker measurements are on the approved list (worker.outlayer.testnet)"]);
  const pass = lines.every(([x]) => x);
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${rec.document_id} -> ${rec.loan_hash.slice(0, 16)}...${pass ? "" : "  " + lines.filter(([x]) => !x).map(([, l]) => l).join("; ")}`);
}
const byDoc = new Map(fp.records.map((r) => [`${r.asset_type}|${r.document_id}`, r.loan_hash]));
const mismatched = loans.filter((l) => byDoc.get(`${l.asset_type}|${l.document_id}`) !== l.loan_hash);
ok &&= mismatched.length === 0;
console.log(`${mismatched.length === 0 ? "PASS" : "FAIL"} tee/loans.json uses the attested fingerprints for all ${loans.length} loans${mismatched.length ? ": " + mismatched.map((l) => l.loan_id).join(", ") : ""}`);
console.log(`${verified.size} distinct TDX quotes verified with Intel collateral; ${approved.length} approved worker measurement sets read from chain`);
console.log(ok ? "Fingerprints verified: every loan_hash came from the attested OutLayer TEE." : "Fingerprints NOT verified.");
process.exitCode = ok ? 0 : 1;
