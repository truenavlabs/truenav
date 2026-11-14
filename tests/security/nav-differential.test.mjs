// Codex differential audit (14 Nov 2026): cases where the JS engine and the Rust v3 NAV port disagreed.
// The same fixture is checked against Rust in outlayer/engine-v3/tests/nav_differential.rs, so both engines
// must give the expected result. The spec decides (spec/nav/NAV_SPEC.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreFund, DEFAULT_MODEL } from "../../engine/src/score.mjs";

const fx = JSON.parse(readFileSync(new URL("../fixtures/nav-differential.json", import.meta.url), "utf8"));
const cents = (x) => Math.round(x * 100);

for (const c of fx.cases) {
  test(c.name, () => {
    const r = scoreFund(DEFAULT_MODEL, structuredClone(c.fund), { now: fx.now, certStore: {} });
    const e = c.expected;
    assert.equal(r.status, e.status);
    assert.equal(r.score, e.score);
    assert.equal(r.band, e.band);
    if ("freshness" in e) assert.equal(r.pillars.freshness, e.freshness);
    if ("listed_book" in e) assert.equal(cents(r.listedBook), cents(e.listed_book));
    if ("unverified_value" in e) assert.equal(cents(r.unverified.value), cents(e.unverified_value));
    if ("share_denominator" in e) assert.equal(cents(Math.max(r.headline, r.unverified.listedBook50)), cents(e.share_denominator));
  });
}
