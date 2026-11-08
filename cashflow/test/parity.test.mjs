// Raw-data parity fixtures: the JS reference must still turn each fixture's input into exactly its expected
// canonical output. The Rust/WASM port (build step 3) runs against the same files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { runFund } from "../run.mjs";
import { canonical } from "../fixtures/canonical.mjs";

const dir = new URL("../fixtures/parity/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.startsWith("cashflow-parity-") && f.endsWith(".json")).sort();

test("there is one parity fixture per synthetic fund", () => {
  assert.deepEqual(files, ["cashflow-parity-DEMO-CREDIT.json", "cashflow-parity-DEMO-RENTAL.json", "cashflow-parity-HONEST-CREDIT.json", "cashflow-parity-HONEST-RENTAL.json"]);
});

for (const f of files) {
  test(`${f}: reference output is byte-identical`, () => {
    const fx = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    const r = runFund(fx.input.dataset, { key: fx.input.pseudonym_seed, ...fx.input.options });
    const got = canonical({ token_id: r.token_id, kind: r.kind, method: r.method, match: r.match, metrics: r.metrics, public_metrics: r.public_metrics, passport: r.passport, score: r.score });
    assert.equal(got, fx.expected_output);
  });
}

test("canonical JSON sorts keys, drops undefined, refuses floats", () => {
  assert.equal(canonical({ b: 1, a: [true, null, "x"], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonical({ x: 1.5 }));
});
