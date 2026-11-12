// tee:attest and tee:underwrite default to the model the live verdicts are signed by; the environment can override it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODEL, modelFromEnv } from "../attest.mjs";

test("the default model is Qwen, the model of the recorded 368aa2 verdict set", () => {
  assert.equal(MODEL, "Qwen/Qwen3-VL-30B-A3B-Instruct");
  assert.equal(modelFromEnv(undefined, {}), MODEL);
  const set = JSON.parse(readFileSync(new URL("../fixtures/verdicts-368aa2.json", import.meta.url), "utf8"));
  assert.equal(set.model, MODEL);
});

test("NEAR_AI_MODEL, then TRUENAV_ATTEST_MODEL, override the default", () => {
  assert.equal(modelFromEnv(undefined, { NEAR_AI_MODEL: "a/b" }), "a/b");
  assert.equal(modelFromEnv(undefined, { TRUENAV_ATTEST_MODEL: "c/d" }), "c/d");
  assert.equal(modelFromEnv(undefined, { NEAR_AI_MODEL: "a/b", TRUENAV_ATTEST_MODEL: "c/d" }), "a/b");
});

test("no glm default is left in the attestation or underwriting code", () => {
  for (const f of ["../attest.mjs", "../underwrite.mjs"]) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /glm/i, f);
});
