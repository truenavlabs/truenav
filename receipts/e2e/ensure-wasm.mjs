// Build a contract wasm when it is missing or older than its sources.
// Sandbox receipts wasm goes to target/near-sandbox and is built with --features sandbox.
// Other contracts stay in target/near and are built without that feature.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { sourceStamp } from "./wasm-stamp.mjs";

const root = new URL("../../", import.meta.url).pathname;

function fresh(dest, stamp) {
  const side = `${dest}.srchash`;
  if (!existsSync(dest) || !existsSync(side)) return false;
  return readFileSync(side, "utf8").trim() === stamp;
}

// The one place that names a contract wasm's path and its source stamp. stamp-wasm.mjs uses it too, so a stamp
// written in CI after the pinned-image build is the one ensureContractWasm checks.
export function wasmTarget({ crate, artifact, sandbox = false }) {
  const crateDir = join(root, crate);
  const stamp = sourceStamp(crateDir, sandbox ? "sandbox" : "default");
  const destDir = join(crateDir, sandbox ? "target/near-sandbox" : "target/near");
  return { crateDir, stamp, destDir, dest: join(destDir, `${artifact}.wasm`) };
}

export function isFresh(opts) {
  const { dest, stamp } = wasmTarget(opts);
  return fresh(dest, stamp);
}

// Record that the wasm at the target path was built from the current sources (CI calls this right after the
// pinned-image build). Refuses a missing file and a sandbox or default build in the wrong path.
export function stampContractWasm(opts) {
  const { dest, stamp } = wasmTarget(opts);
  if (!existsSync(dest)) throw new Error(`cannot stamp ${dest}: the wasm is missing`);
  const hasSandbox = readFileSync(dest).includes("outlayer.test.near");
  if (opts.sandbox && !hasSandbox) throw new Error(`cannot stamp ${dest}: not a sandbox-feature build`);
  if (!opts.sandbox && hasSandbox) throw new Error(`cannot stamp ${dest}: a sandbox build in the default path`);
  writeFileSync(`${dest}.srchash`, `${stamp}\n`, { mode: 0o644 });
  return { dest, stamp };
}

export function ensureContractWasm({ crate, artifact, sandbox = false }) {
  const { stamp, destDir, dest } = wasmTarget({ crate, artifact, sandbox });
  if (fresh(dest, stamp)) {
    const bytes = readFileSync(dest);
    const hasSandbox = bytes.includes("outlayer.test.near");
    if (sandbox && !hasSandbox) throw new Error(`${dest} is not a sandbox-feature build`);
    if (!sandbox && hasSandbox) throw new Error(`${dest} is a sandbox build in the default path`);
    return dest;
  }
  // In CI the wasm must come from the pinned image and be stamped by receipts/e2e/stamp-wasm.mjs. A host rebuild
  // would use another toolchain and no wasm-opt, so the run would test a different (and larger) wasm.
  if (process.env.CI) throw new Error(`${dest} is missing or stale in CI (no matching ${dest}.srchash). Build it in the pinned image and run node receipts/e2e/stamp-wasm.mjs; CI does not rebuild contract wasm on the host.`);
  mkdirSync(destDir, { recursive: true });
  if (sandbox) {
    execFileSync("bash", [join(root, "receipts/build-sandbox-wasm.sh")], { stdio: "inherit" });
    if (!existsSync(dest)) throw new Error(`sandbox wasm was not written to ${dest}`);
    const built = readFileSync(dest);
    if (!built.includes("outlayer.test.near")) throw new Error(`${dest} is not a sandbox-feature build`);
    writeFileSync(`${dest}.srchash`, `${stamp}\n`, { mode: 0o644 });
    return dest;
  }
  const cargoDir = join(crateDir, "target/default-cargo");
  execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown"], {
    cwd: crateDir,
    env: { ...process.env, CARGO_TARGET_DIR: cargoDir, RUSTFLAGS: "--cfg near" },
    stdio: "inherit",
  });
  copyFileSync(join(cargoDir, "wasm32-unknown-unknown", "release", `${artifact}.wasm`), dest);
  try { execFileSync("wasm-opt", ["-Oz", dest, "-o", dest], { stdio: "inherit" }); } catch { /* cargo-near output is already optimized */ }
  if (readFileSync(dest).includes("outlayer.test.near")) throw new Error(`${dest} is a sandbox build in the default path`);
  writeFileSync(`${dest}.srchash`, `${stamp}\n`, { mode: 0o644 });
  return dest;
}
