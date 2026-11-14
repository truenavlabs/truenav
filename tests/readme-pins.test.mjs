// README claim (Hackathon disclosures, "Libraries and tools"): the listed versions are the ones pinned in the lockfiles.
// Read-only check of README.md against package-lock.json and the Cargo.lock files. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const readme = read("README.md").replace(/`/g, "");
const bullet = readme.split("\n").find((l) => l.includes("Libraries and tools (Q-005)"));

test("README names the library bullet", () => {
  assert.ok(bullet, "the Libraries and tools (Q-005) bullet is missing from README.md");
});

test("README npm library versions equal package-lock.json", () => {
  const lock = JSON.parse(read("package-lock.json")).packages;
  for (const name of ["near-api-js", "near-sandbox", "@noble/curves", "@noble/hashes", "@phala/dcap-qvl", "ganache", "solc", "viem"]) {
    const v = lock[`node_modules/${name}`]?.version;
    assert.ok(v, `${name} is not in package-lock.json`);
    assert.ok(bullet.includes(`${name} ${v}`), `README says a different version of ${name}; package-lock.json has ${v}`);
  }
});

test("README near-sdk version equals every Cargo.lock that has near-sdk", () => {
  const said = /near-sdk (\d+\.\d+\.\d+)/.exec(bullet)?.[1];
  assert.ok(said, "README does not give a near-sdk version");
  for (const crate of ["contract", "receipts", "query"]) {
    const m = /name = "near-sdk"\nversion = "([^"]+)"/.exec(read(`${crate}/Cargo.lock`));
    assert.equal(m?.[1], said, `${crate}/Cargo.lock near-sdk`);
  }
});

test("README jsonschema version equals the one CI installs", () => {
  const said = /jsonschema (\d+\.\d+\.\d+)/.exec(bullet)?.[1];
  assert.ok(said);
  const ci = read(".github/workflows/ci.yml");
  const pins = [...ci.matchAll(/jsonschema==(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 1);
  for (const p of pins) assert.equal(p, said);
});

test("README build image equals the pinned cargo-near image name used by CI", () => {
  const image = /sourcescan\/cargo-near:[0-9.]+-rust-[0-9.]+/.exec(bullet)?.[0];
  assert.ok(image, "README does not name the build image");
  assert.ok(read(".github/workflows/ci.yml").includes(image), `${image} is not in ci.yml`);
});
