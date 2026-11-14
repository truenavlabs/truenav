// SPEC_RECEIPT_V3.md must state its real status. The owner froze the v3 spec at rc3 on 9 Nov 2026 at 16:07 Bangkok
// and approved the v3.0.1 amendment the same day (decision log entries of that date), so it is not "pending the
// owner's final read". The v3 design is not deployed on the live testnet account, and the spec must say so.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("../SPEC_RECEIPT_V3.md", import.meta.url), "utf8");
const head = spec.split("\n").slice(0, 12).join("\n");

test("the spec no longer says it is pending the owner's final read", () => {
  assert.doesNotMatch(spec, /pending the owner/i);
  assert.doesNotMatch(spec, /final read/i);
});

test("the status line says frozen at rc3 on 9 Nov 2026 16:07 Bangkok, names the v3.0.1 amendment and says not deployed", () => {
  assert.match(head, /^Status: FROZEN v3\.0\.0-rc3, frozen by the owner on 9 Nov 2026 at 16:07 Bangkok\./m);
  assert.match(head, /SPEC_RECEIPT_V3_0_1\.md/);
  assert.match(head, /not deployed/i);
  assert.doesNotMatch(head, /[\u2013\u2014]/);
});
