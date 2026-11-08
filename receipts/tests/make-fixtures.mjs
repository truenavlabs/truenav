// Writes receipts/tests/fixtures/engine-receipts.json: what the engine module prints (outlayer/engine-v2,
// examples/native.rs runs the same tee::execute as the wasm) for the 4 synthetic parity funds, so the contract tests
// check real receipts. Needs: cd outlayer/engine-v2 && cargo build --example native
//   node receipts/tests/make-fixtures.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_AS_OF, BANK_FETCHED_AT } from "../../cashflow/demo/data.mjs";

const root = new URL("../../", import.meta.url).pathname;
const bin = join(root, "outlayer/engine-v2/target/debug/examples/native");
const dir = mkdtempSync(join(tmpdir(), "truenav-fixtures-"));
const out = {};
try {
  for (const id of ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"]) {
    const fx = JSON.parse(readFileSync(join(root, `cashflow/fixtures/parity/cashflow-parity-${id}.json`)));
    const ds = join(dir, `${id}.json`);
    writeFileSync(ds, JSON.stringify(fx.input.dataset));
    const input = { token_id: id, run_nonce: "0".repeat(64), as_of: RUN_AS_OF };
    out[id] = { kind: fx.input.dataset.kind, input, output: execFileSync(bin, [ds, BANK_FETCHED_AT], { input: JSON.stringify(input) }).toString() };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const note = "Receipts printed by outlayer/engine-v2 (examples/native.rs, the same tee::execute as the wasm) for the 4 synthetic parity funds, run_nonce 64 zeros, run as of 2026-11-08T09:00:00Z with the bank fetched at 08:30. Regenerate: receipts/tests/make-fixtures.mjs";
writeFileSync(join(root, "receipts/tests/fixtures/engine-receipts.json"), JSON.stringify({ note, receipts: out }, null, 1) + "\n");
for (const [id, r] of Object.entries(out)) console.log(id, r.output.length, "bytes");
