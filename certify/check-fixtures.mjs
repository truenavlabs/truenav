// CI guard (owner decision 6 Nov): fail if any recorded TEE verdict set expires within 10 days, so an expired
// fixture cannot silently break a judge's run. Re-sign with: node tee/underwrite.mjs --contract <id> --out <file>
import { readFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
const MIN_DAYS = 10;
let ok = true;
for (const f of ["tee/fixtures/verdicts.json", "tee/fixtures/verdicts-sandbox.json", "tee/fixtures/verdicts-unit.json", "contract/tests/fixtures/tee-verdicts.json"]) {
  const d = JSON.parse(readFileSync(new URL(f, root), "utf8"));
  const days = (d.expires_at_ms - Date.now()) / 86400000;
  const pass = Number.isFinite(days) && days >= MIN_DAYS;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${f}: ${Number.isFinite(days) ? days.toFixed(1) : "no expiry"} days left (minimum ${MIN_DAYS})`);
}
// The published attestation report must be the one the live verdict set was signed under.
{
  const live = JSON.parse(readFileSync(new URL("tee/fixtures/verdicts.json", root), "utf8"));
  const raw = Buffer.from(readFileSync(new URL("tee/fixtures/attestation-report.json.b64", root), "utf8").replace(/\s+/g, ""), "base64");
  const sha = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
  const pass = sha === live.attestation.report_sha256;
  ok &&= pass;
  console.log(`${pass ? "PASS" : "FAIL"} published attestation report is the one tee/fixtures/verdicts.json was signed under`);
}
process.exitCode = ok ? 0 : 1;
