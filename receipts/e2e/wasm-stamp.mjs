// Hash of the crate sources that a wasm build must match. A wasm without this stamp, or with a
// different stamp, is stale and must be rebuilt.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function sourceStamp(crateDir, tag) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "target" || name === "node_modules") continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.endsWith(".rs") || name === "Cargo.toml" || name === "Cargo.lock") files.push(path);
    }
  };
  walk(crateDir);
  files.sort();
  const hash = createHash("sha256");
  hash.update(String(tag));
  for (const path of files) {
    hash.update(path.slice(crateDir.length));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}
