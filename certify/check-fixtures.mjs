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
process.exitCode = ok ? 0 : 1;
