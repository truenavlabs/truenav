// RT2-04: the CI wasm stamp binds the wasm bytes as well as the sources. Runs on a throwaway tree in the OS temp dir
// (copies of ensure-wasm.mjs, wasm-stamp.mjs and stamp-wasm.mjs plus fake crates), so no real target/ is touched,
// nothing is built, and the test sees the working-tree code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E2E = new URL("../e2e/", import.meta.url).pathname;
let TREE, mod;
const CRATES = [
  { crate: "receipts", artifact: "truenav_receipts", sandbox: true },
  { crate: "query", artifact: "truenav_query" },
  { crate: "receipts/mock-outlayer", artifact: "mock_outlayer" },
  { crate: "mirror/mock-signer", artifact: "truenav_mock_signer" },
];
const W = CRATES[0];
const destOf = (w) => join(TREE, w.crate, w.sandbox ? "target/near-sandbox" : "target/near", `${w.artifact}.wasm`);
const wasmBytes = (w, tag) => Buffer.from(`\0asm fake ${tag} ${w.sandbox ? "outlayer.test.near" : "default"}`);
function place(w, tag) {
  mkdirSync(join(destOf(w), ".."), { recursive: true });
  writeFileSync(destOf(w), wasmBytes(w, tag));
}
function inChild(code, env) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: TREE, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return (r.stdout + r.stderr).trim();
}
const ensureUnderCI = (w) => inChild(`import(${JSON.stringify(join(TREE, "receipts/e2e/ensure-wasm.mjs"))}).then(m=>{try{console.log("OK "+m.ensureContractWasm(${JSON.stringify(w)}))}catch(e){console.log("THROW "+e.message)}})`, { CI: "true" });

before(async () => {
  TREE = mkdtempSync(join(tmpdir(), "truenav-stamp-"));
  mkdirSync(join(TREE, "receipts/e2e"), { recursive: true });
  for (const f of ["ensure-wasm.mjs", "wasm-stamp.mjs", "stamp-wasm.mjs"]) copyFileSync(join(E2E, f), join(TREE, "receipts/e2e", f));
  for (const w of CRATES) {
    mkdirSync(join(TREE, w.crate, "src"), { recursive: true });
    writeFileSync(join(TREE, w.crate, "Cargo.toml"), `[package]\nname = "${w.artifact}"\n`);
    writeFileSync(join(TREE, w.crate, "src/lib.rs"), "// fake\n");
  }
  writeFileSync(join(TREE, "receipts/build-sandbox-wasm.sh"), "#!/bin/bash\necho fake\n");
  mod = await import(join(TREE, "receipts/e2e/ensure-wasm.mjs"));
});

after(() => rmSync(TREE, { recursive: true, force: true }));

test("RT2-04 a wasm swapped after stamping reads stale, and CI throws instead of using it", () => {
  place(W, "pinned-image");
  mod.stampContractWasm(W);
  assert.equal(mod.isFresh(W), true, "control: freshly stamped");
  // both sides of the match in one test: the stamp on disk and the one recomputed from the bytes now
  assert.equal(readFileSync(`${destOf(W)}.srchash`, "utf8"), mod.stampText(destOf(W), mod.wasmTarget(W).stamp));
  writeFileSync(destOf(W), wasmBytes(W, "SWAPPED"));
  assert.notEqual(readFileSync(`${destOf(W)}.srchash`, "utf8"), mod.stampText(destOf(W), mod.wasmTarget(W).stamp));
  assert.equal(mod.isFresh(W), false, "swapped bytes are stale");
  assert.match(ensureUnderCI(W), /^THROW .*missing or stale in CI/);
});

test("RT2-04 the sandbox build script is a stamp input; a .rs edit still is (control)", () => {
  const a = mod.wasmTarget(W).stamp;
  appendFileSync(join(TREE, "receipts/build-sandbox-wasm.sh"), "# a flag change\n");
  const b = mod.wasmTarget(W).stamp;
  assert.notEqual(b, a, "editing build-sandbox-wasm.sh changes the sandbox stamp");
  appendFileSync(join(TREE, "receipts/src/lib.rs"), "// edit\n");
  assert.notEqual(mod.wasmTarget(W).stamp, b);
  // the script is not an input of the default-path receipts build
  const d0 = mod.wasmTarget({ ...W, sandbox: false }).stamp;
  appendFileSync(join(TREE, "receipts/build-sandbox-wasm.sh"), "# again\n");
  assert.equal(mod.wasmTarget({ ...W, sandbox: false }).stamp, d0);
});

test("RT2-04 an older one-line stamp, an empty stamp and a source-only stamp all read stale", () => {
  place(W, "x");
  const { stamp } = mod.wasmTarget(W);
  for (const text of [`${stamp}\n`, "", `src ${stamp}\n`, `src ${stamp}\nwasm ${"0".repeat(64)}\n`]) {
    writeFileSync(`${destOf(W)}.srchash`, text);
    assert.equal(mod.isFresh(W), false, JSON.stringify(text.slice(0, 20)));
  }
});

test("fail closed: no stamp under CI throws for CI=1, true, false and 0", () => {
  place(W, "unstamped");
  rmSync(`${destOf(W)}.srchash`, { force: true });
  for (const v of ["1", "true", "false", "0"]) {
    const out = inChild(`import(${JSON.stringify(join(TREE, "receipts/e2e/ensure-wasm.mjs"))}).then(m=>{try{m.ensureContractWasm(${JSON.stringify(W)});console.log("OK")}catch(e){console.log("THROW "+e.message)}})`, { CI: v });
    assert.match(out, /^THROW .*missing or stale in CI/, `CI=${v}`);
  }
});

test("fail closed: a missing wasm cannot be stamped and a default build is refused in the sandbox path", () => {
  rmSync(destOf(W), { force: true });
  assert.throws(() => mod.stampContractWasm(W), /the wasm is missing/);
  mkdirSync(join(destOf(W), ".."), { recursive: true });
  writeFileSync(destOf(W), Buffer.from("\0asm default build"));
  assert.throws(() => mod.stampContractWasm(W), /not a sandbox-feature build/);
});

test("stamp-wasm.mjs stamps all 4 wasms, each passes the post-stamp freshness check, and CI then uses them as is", () => {
  for (const w of CRATES) place(w, "image");
  const out = inChild(`process.argv[1]=${JSON.stringify(join(TREE, "receipts/e2e/stamp-wasm.mjs"))};await import(${JSON.stringify(join(TREE, "receipts/e2e/stamp-wasm.mjs"))});`, {});
  assert.equal((out.match(/^stamped /gm) || []).length, 4, out);
  for (const w of CRATES) {
    assert.equal(mod.isFresh(w), true, w.crate);
    assert.equal(ensureUnderCI(w), `OK ${destOf(w)}`, w.crate);
  }
});
