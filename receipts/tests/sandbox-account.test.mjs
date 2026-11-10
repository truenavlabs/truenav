import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsSandboxAccount, listWasm, scanRoot } from "../check-sandbox-account.mjs";
import { sourceStamp } from "../e2e/wasm-stamp.mjs";
import { canonical } from "../../api/receipt.mjs";
import { writeFileSync as writeStamp } from "node:fs";

const text = "outlayer.test.near";

test("sandbox account scan rejects case, utf16 and nul-split forms and skips the sandbox tree", () => {
  const root = mkdtempSync(join(tmpdir(), "truenav-scan-"));
  assert.equal(listWasm(root).length, 0);
  const forms = {
    "plain.wasm": Buffer.from(`xx${text}yy`),
    "upper.wasm": Buffer.from(`xx${text.toUpperCase()}yy`),
    "utf16le.wasm": Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le")]),
    "utf16be.wasm": Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le").swap16()]),
  };
  const nul = Buffer.alloc(text.length * 2 - 1);
  for (let i = 0; i < text.length; i++) {
    nul[i * 2] = text.charCodeAt(i);
    if (i + 1 < text.length) nul[i * 2 + 1] = 0;
  }
  forms["nul.wasm"] = Buffer.concat([Buffer.from([1, 2]), nul, Buffer.from([3])]);
  for (const [name, bytes] of Object.entries(forms)) {
    assert.equal(containsSandboxAccount(bytes), true, name);
    writeFileSync(join(root, name), bytes);
  }
  const scanned = scanRoot(root);
  assert.equal(scanned.files.length, 5);
  assert.equal(scanned.hits.length, 5);
  const hidden = join(root, "target", "near-sandbox");
  mkdirSync(hidden, { recursive: true });
  writeFileSync(join(hidden, "truenav_receipts.wasm"), Buffer.from(text));
  const cargo = join(root, "receipts", "target", "sandbox-cargo");
  mkdirSync(cargo, { recursive: true });
  writeFileSync(join(cargo, "truenav_receipts.wasm"), Buffer.from(text));
  const again = scanRoot(root);
  assert.equal(again.files.length, 5);
  assert.equal(again.hits.length, 5);
  writeFileSync(join(root, "clean.wasm"), Buffer.from("outlayer.testnet"));
  const clean = scanRoot(root);
  assert.equal(clean.hits.length, 5);
  assert.equal(clean.files.length, 6);
  const empty = mkdtempSync(join(tmpdir(), "truenav-scan-empty-"));
  const child = spawnSync(process.execPath, [new URL("../check-sandbox-account.mjs", import.meta.url).pathname, "--expect"], { cwd: empty, encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /no wasm/);
});

test("canonical public form matches the rust golden", () => {
  assert.equal(canonical({ b: 1, a: "x", nested: { z: true, m: [2, 1] } }), '{"a":"x","b":1,"nested":{"m":[2,1],"z":true}}');
});

test("wasm stamp changes when a path dep, schema, lock, or toolchain file changes", () => {
  const root = mkdtempSync(join(tmpdir(), "truenav-stamp-"));
  const crate = join(root, "receipts");
  const core = join(root, "engine", "v3-core", "src");
  mkdirSync(crate, { recursive: true });
  mkdirSync(core, { recursive: true });
  writeStamp(join(crate, "Cargo.toml"), 'truenav-v3-core = { path = "../engine/v3-core" }\n');
  writeStamp(join(crate, "Cargo.lock"), "lock-a\n");
  writeStamp(join(crate, "lib.rs"), 'const S: &str = include_str!("../engine/v3-core/src/schema.json");\n');
  writeStamp(join(core, "schema.json"), '{"a":1}\n');
  writeStamp(join(root, "rust-toolchain.toml"), "channel-a\n");
  const base = sourceStamp(crate, "sandbox");
  writeStamp(join(core, "schema.json"), '{"a":2}\n');
  assert.notEqual(sourceStamp(crate, "sandbox"), base);
  writeStamp(join(core, "schema.json"), '{"a":1}\n');
  writeStamp(join(crate, "Cargo.lock"), "lock-b\n");
  assert.notEqual(sourceStamp(crate, "sandbox"), base);
  writeStamp(join(crate, "Cargo.lock"), "lock-a\n");
  writeStamp(join(root, "rust-toolchain.toml"), "channel-b\n");
  assert.notEqual(sourceStamp(crate, "sandbox"), base);
  writeStamp(join(root, "rust-toolchain.toml"), "channel-a\n");
  writeStamp(join(core, "lib.rs"), "fn changed() {}\n");
  assert.notEqual(sourceStamp(crate, "sandbox"), base);
});
