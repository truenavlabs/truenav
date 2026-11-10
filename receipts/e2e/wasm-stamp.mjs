// Hash of everything a contract wasm build depends on. A missing or different stamp means rebuild.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function walk(dir, files) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "target" || name === "node_modules") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, files);
    else if (name.endsWith(".rs") || name === "Cargo.toml" || name === "Cargo.lock" || name.endsWith(".json") || name === "rust-toolchain.toml") files.push(path);
  }
}

function pathDeps(cargoToml, crateDir) {
  const text = readFileSync(cargoToml, "utf8");
  const deps = [];
  for (const match of text.matchAll(/path\s*=\s*"([^"]+)"/g)) {
    deps.push(resolve(crateDir, match[1]));
  }
  return deps;
}

function includeStrs(crateDir) {
  const out = [];
  const files = [];
  walk(crateDir, files);
  for (const file of files) {
    if (!file.endsWith(".rs")) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/include_str!\(\s*"([^"]+)"\s*\)/g)) {
      out.push(resolve(dirname(file), match[1]));
    }
  }
  return out;
}

export function sourceStamp(crateDir, tag) {
  const files = new Set();
  const queue = [crateDir];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const found = [];
    walk(dir, found);
    for (const file of found) files.add(file);
    const cargo = join(dir, "Cargo.toml");
    if (existsSync(cargo)) {
      for (const dep of pathDeps(cargo, dir)) queue.push(dep);
    }
    for (const inc of includeStrs(dir)) if (existsSync(inc)) files.add(inc);
    const tool = join(dir, "rust-toolchain.toml");
    if (existsSync(tool)) files.add(tool);
    const rootTool = join(resolve(dir, ".."), "rust-toolchain.toml");
    if (existsSync(rootTool)) files.add(rootTool);
  }
  const list = [...files].sort();
  const hash = createHash("sha256");
  hash.update(String(tag));
  for (const path of list) {
    hash.update(path);
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}
