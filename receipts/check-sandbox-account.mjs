// Fail if the sandbox-only account is compiled into any wasm except the sandbox build tree.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TEXT = "outlayer.test.near";

export function sandboxNeedles() {
  const lower = Buffer.from(TEXT, "utf8");
  const upper = Buffer.from(TEXT.toUpperCase(), "utf8");
  const utf16le = Buffer.from(TEXT, "utf16le");
  const utf16be = Buffer.from(TEXT, "utf16le").swap16();
  const nul = Buffer.alloc(TEXT.length * 2 - 1);
  for (let i = 0; i < TEXT.length; i++) {
    nul[i * 2] = TEXT.charCodeAt(i);
    if (i + 1 < TEXT.length) nul[i * 2 + 1] = 0;
  }
  return [lower, upper, utf16le, utf16be, nul];
}

export function containsSandboxAccount(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const folded = Buffer.from(buf.toString("latin1").toLowerCase(), "latin1");
  if (folded.includes(Buffer.from(TEXT))) return true;
  for (const needle of sandboxNeedles()) if (buf.includes(needle)) return true;
  return false;
}

function skipped(rel) {
  const norm = rel.split("\\").join("/");
  return norm === "target/near-sandbox" || norm.startsWith("target/near-sandbox/")
    || norm === "target/sandbox-cargo" || norm.startsWith("target/sandbox-cargo/")
    || norm.includes("/target/near-sandbox/") || norm.includes("/target/sandbox-cargo/")
    || norm === "node_modules" || norm.startsWith("node_modules/") || norm.includes("/node_modules/")
    || norm === ".git" || norm.startsWith(".git/");
}

export function listWasm(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (skipped(rel)) continue;
      let st;
      try { st = statSync(path); }
      catch { continue; }
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && name.toLowerCase().endsWith(".wasm")) out.push(path);
    }
  };
  walk(root);
  return out;
}

export function scanRoot(root) {
  const hits = [];
  const files = listWasm(root);
  for (const path of files) {
    if (containsSandboxAccount(readFileSync(path))) hits.push(path);
  }
  return { files, hits };
}

const isMain = process.argv[1] && process.argv[1].endsWith("check-sandbox-account.mjs");
if (isMain) {
  const expect = process.argv.includes("--expect");
  const root = process.cwd();
  const { files, hits } = scanRoot(root);
  for (const path of files) {
    if (hits.includes(path)) console.error(`FAIL ${path} contains outlayer.test.near`);
    else console.log(`ok ${path}`);
  }
  if (hits.length) process.exit(1);
  if (expect && files.length === 0) {
    console.error("FAIL no wasm found to scan");
    process.exit(1);
  }
  if (!expect && files.length === 0) console.log("no wasm was present to scan");
}
