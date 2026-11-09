// Build a contract wasm if the expected file is missing.
// Sandbox receipts wasm goes to target/near-sandbox and is built with --features sandbox.
// Other contracts stay in target/near and are built without that feature.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;

export function ensureContractWasm({ crate, artifact, sandbox = false }) {
  const destDir = join(root, crate, sandbox ? "target/near-sandbox" : "target/near");
  const dest = join(destDir, `${artifact}.wasm`);
  if (existsSync(dest)) {
    const bytes = readFileSync(dest);
    const hasSandbox = bytes.includes("outlayer.test.near");
    if (sandbox && !hasSandbox) throw new Error(`${dest} is not a sandbox-feature build`);
    if (!sandbox && hasSandbox) throw new Error(`${dest} is a sandbox build in the default path`);
    return dest;
  }
  if (sandbox) {
    execFileSync("bash", [join(root, "receipts/build-sandbox-wasm.sh")], { stdio: "inherit" });
    if (!existsSync(dest)) throw new Error(`sandbox wasm was not written to ${dest}`);
    return dest;
  }
  mkdirSync(destDir, { recursive: true });
  const cargoDir = join(root, crate, "target/default-cargo");
  execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown"], {
    cwd: join(root, crate),
    env: { ...process.env, CARGO_TARGET_DIR: cargoDir, RUSTFLAGS: "--cfg near" },
    stdio: "inherit",
  });
  copyFileSync(join(cargoDir, "wasm32-unknown-unknown", "release", `${artifact}.wasm`), dest);
  try { execFileSync("wasm-opt", ["-Oz", dest, "-o", dest], { stdio: "inherit" }); } catch { /* cargo-near output is already optimized */ }
  return dest;
}
