// A02: newRequestId must keep its random suffix for every legal token length (tokens go up to 64 characters), and
// every id must fit the query contract's rule (query/src/lib.rs is_request_id: 8 to 64 of [A-Za-z0-9_-]).
// The contract rejects a reused id forever, so an id that loses its random part blocks later purchases of that token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newRequestId } from "../agent.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lib = readFileSync(`${root}query/src/lib.rs`, "utf8");
const GRAMMAR = /^[A-Za-z0-9_-]{8,64}$/;
const R1 = "0123456789ab";
const R2 = "ba9876543210";
const token = (n) => "T".repeat(n);

test("A02: the contract rule this test assumes is still the rule in query/src/lib.rs", () => {
  assert.match(lib, /\(8\.\.=64\)\.contains\(&s\.len\(\)\)/);
  assert.match(lib, /is_ascii_alphanumeric\(\) \|\| c == b'-' \|\| c == b'_'/);
  assert.match(lib, /request_id already used/);
});

test("A02: two calls with a 64 character token and different random parts give different ids", () => {
  const a = newRequestId(token(64), R1);
  const b = newRequestId(token(64), R2);
  assert.notEqual(a, b);
  assert.ok(a.includes(R1) && b.includes(R2), "the whole random suffix survives");
});

test("A02: for every legal token length 1 to 64, ids differ by random part, fit the limit and match the contract grammar", () => {
  for (let n = 1; n <= 64; n++) {
    const a = newRequestId(token(n), R1);
    const b = newRequestId(token(n), R2);
    assert.notEqual(a, b, `token length ${n}`);
    assert.ok(a.endsWith(R1) && b.endsWith(R2), `token length ${n}: suffix kept`);
    for (const id of [a, b]) {
      assert.ok(id.length <= 64, `token length ${n}: ${id.length} chars`);
      assert.match(id, GRAMMAR, `token length ${n}`);
    }
  }
});

test("A02: the real shape, a kebab token with letters digits and hyphens, at 57 to 64 characters", () => {
  for (const n of [56, 57, 58, 63, 64]) {
    const t = ("loan-0a1b2c3d-" + "9f".repeat(40)).slice(0, n);
    assert.notEqual(newRequestId(t, R1), newRequestId(t, R2), `length ${n}`);
    assert.match(newRequestId(t, R1), GRAMMAR);
  }
});

test("A02 guard: a short token gives the same id as before, agent-TOKEN-RAND", () => {
  assert.equal(newRequestId("HONEST-RENTAL", R1), `agent-HONEST-RENTAL-${R1}`);
  assert.equal(newRequestId("A", R1), `agent-A-${R1}`);
});

test("A02 guard: a token that exactly fits (45 characters with a 12 character random part) is unchanged", () => {
  assert.equal(newRequestId(token(45), R1), `agent-${token(45)}-${R1}`);
  assert.equal(newRequestId(token(45), R1).length, 64);
});

test("A02 guard: an oversized random part is still capped at 64 characters and the id stays valid", () => {
  const id = newRequestId("HONEST-RENTAL", "x".repeat(80));
  assert.equal(id.length, 64);
  assert.match(id, GRAMMAR);
});

test("A02: two different long tokens with the same first 45 characters still give different ids for different random parts", () => {
  const a = newRequestId(token(45) + "A".repeat(19), R1);
  const b = newRequestId(token(45) + "B".repeat(19), R2);
  assert.notEqual(a, b);
});
