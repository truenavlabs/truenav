// RT2-01 (REDTEAM_R2): pin consistency. Every copy of the engine v3 pin and the receipts pin must agree, so a later
// vector or pin edit cannot drift silently. The deploy refuse path for stale dist wasm is tested in
// receipts/tests/deploy-args.test.mjs; this file does not repeat it and does not assert that dist is stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { V3_PIN } from "../../receipts/e2e/public-v3.mjs";

const R = (p) => new URL(`../../${p}`, import.meta.url);
const J = (p) => JSON.parse(readFileSync(R(p), "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(R(p))).digest("hex");
const pinned = J("receipts/pinned-builds.json"), v3b = J("receipts/v3-build.json");

test("engine v3 pin agrees across v3-build.json, the e2e pin and every derived vector", () => {
  assert.equal(v3b.engine.sha256, V3_PIN);
  const d = J("schema/vectors/engine-v3-derived.json");
  const keys = new Set();
  const walk = (v) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "engine_version_key" || k === "engine_code_sha256") keys.add(x); walk(x); } };
  walk(d);
  assert.deepEqual([...keys], [V3_PIN]);
});

test("receipts pin agrees between pinned-builds.json and v3-build.json", () => {
  assert.equal(pinned.receipts, v3b.receipts.sha256);
});

test("the dist note in pinned-builds.json matches the committed dist wasm bytes", () => {
  for (const c of ["receipts", "query"]) {
    const f = `receipts/dist/truenav_${c}.wasm`;
    assert.equal(sha(f), pinned.dist[f], `${c}: dist note matches the bytes`);
  }
});
