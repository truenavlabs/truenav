// Fail if the sandbox-only account is compiled into a pinned wasm or a default (non-sandbox) build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const needle = Buffer.from("outlayer.test.near");
const dirs = [
  "receipts/dist",
  "query/dist",
  "contract/dist",
  "vault/dist",
  "receipts/target/near",
  "query/target/near",
  "contract/target/near",
  "vault/target/near",
  "mirror/mock-signer/target/near",
  "receipts/mock-outlayer/target/near",
];
let failed = false;
let seen = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".wasm")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    seen += 1;
    if (readFileSync(path).includes(needle)) {
      console.error(`FAIL ${path} contains outlayer.test.near`);
      failed = true;
    } else {
      console.log(`ok ${path}`);
    }
  }
}
if (seen === 0) console.log("no pinned or default-build wasm was present to scan");
if (failed) process.exit(1);
