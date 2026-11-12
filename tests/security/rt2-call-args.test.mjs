// RT2-08 (REDTEAM_R2, info, not fixed): fail-closed checks on certify/call-args.mjs plainCallArgs beyond its own tests,
// and the getter TOCTOU it still allows. If plainCallArgs starts returning a re-serialized copy, update the second test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainCallArgs } from "../../certify/call-args.mjs";

test("plainCallArgs refuses cycles, Map, Set, Date, boxed values, functions and toJSON hooks", () => {
  const cyc = { a: 1 }; cyc.self = cyc;
  assert.throws(() => plainCallArgs(cyc));
  for (const v of [new Map(), new Set(), new Date(0), new String("x"), new Number(1), () => 1, Symbol("s")]) assert.throws(() => plainCallArgs({ v }), undefined, String(v?.constructor?.name));
  assert.throws(() => plainCallArgs({ a: { toJSON() { return "x"; } } }), /function/);
  assert.throws(() => plainCallArgs({ n: Infinity }), /finite/);
});

test("plainCallArgs: a getter is evaluated once by the guard and again by JSON.stringify (TOCTOU, harmless for literals)", () => {
  let n = 0;
  const o = { get k() { n += 1; return n === 1 ? "ok" : 5n; } };
  plainCallArgs(o);
  assert.throws(() => JSON.stringify(o), /BigInt/, "a getter can return a different value after the check");
});
