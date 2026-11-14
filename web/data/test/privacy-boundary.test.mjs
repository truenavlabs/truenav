// Privacy boundary data (who sees what). Every row must name real code or a repo document that says it, and the
// honest leaks (hash guessing, singleton aggregates, v2 receipt granularity, metadata) must be present and listed in
// docs/KNOWN_LIMITS.md. No network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { PARTIES, LEVELS, ROWS, LEAKS } from "../../src/content/privacy-boundary.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const row = (id) => ROWS.find((r) => r.id === id);
const allText = () => JSON.stringify({ PARTIES, ROWS, LEAKS });

test("six parties in a fixed order, four levels", () => {
  assert.deepEqual(PARTIES.map((p) => p.id), ["public", "verifier", "lender", "fund", "tee_operator", "truenav_operator"]);
  assert.deepEqual(Object.keys(LEVELS), ["sees", "partial", "assumed", "hidden"]);
  for (const p of PARTIES) assert.ok(p.label.length > 3 && p.who.length > 20, p.id);
});

test("every row has a cell for every party, each with a valid level and a real note", () => {
  assert.ok(ROWS.length >= 12, `only ${ROWS.length} rows`);
  const ids = new Set();
  for (const r of ROWS) {
    assert.ok(!ids.has(r.id), `duplicate row ${r.id}`);
    ids.add(r.id);
    assert.ok(r.item.length > 5 && r.lives.length > 10, r.id);
    assert.ok(["live", "design", "mixed"].includes(r.status), `${r.id} status`);
    assert.deepEqual(Object.keys(r.cells).sort(), PARTIES.map((p) => p.id).sort(), `${r.id} cells`);
    for (const [p, c] of Object.entries(r.cells)) {
      assert.ok(c.level in LEVELS, `${r.id}/${p} level ${c.level}`);
      assert.ok(c.note.length >= 12, `${r.id}/${p} note is too short`);
    }
  }
});

test("every row is sourced: the file exists and holds the quoted text", () => {
  for (const r of ROWS) {
    assert.ok(r.sources.length >= 1, `${r.id} has no source`);
    for (const s of r.sources) {
      assert.ok(existsSync(new URL(s.file, ROOT)), `${r.id}: ${s.file} does not exist`);
      assert.ok(s.needle.length >= 12, `${r.id}: needle too short`);
      assert.ok(read(s.file).includes(s.needle), `${r.id}: ${s.file} does not contain "${s.needle}"`);
    }
  }
});

test("the honest leaks are all present, each tied to a row, a whitepaper section and docs/KNOWN_LIMITS.md", () => {
  const need = ["hash_guessing", "document_holder_link", "singleton_aggregates", "v2_receipt_granularity", "metadata", "operators_see_inputs", "history_stays_public"];
  assert.deepEqual(LEAKS.map((l) => l.id).sort(), [...need].sort());
  const known = read("docs/KNOWN_LIMITS.md");
  for (const l of LEAKS) {
    assert.match(l.whitepaper, /^(8\.4 item [1-7]|12\.[1-4])$/, l.id);
    assert.ok(l.text.length > 60, l.id);
    assert.ok(known.includes(l.title), `docs/KNOWN_LIMITS.md does not list "${l.title}"`);
    assert.ok(ROWS.some((r) => r.leaks.includes(l.id)), `${l.id} is not attached to any row`);
  }
  for (const r of ROWS) for (const id of r.leaks) assert.ok(LEAKS.some((l) => l.id === id), `${r.id} names unknown leak ${id}`);
});

test("specific honest rows: guessing, singleton aggregates and v2 granularity are stated where they bite", () => {
  assert.ok(row("request_hash").leaks.includes("hash_guessing"));
  assert.ok(row("request_hash").leaks.includes("document_holder_link"));
  assert.ok(row("loan_hash").leaks.includes("hash_guessing"));
  assert.ok(row("certificates").leaks.includes("singleton_aggregates"));
  assert.ok(row("receipt_v2").leaks.includes("v2_receipt_granularity"));
  assert.ok(row("receipt_v2").leaks.includes("history_stays_public"));
  assert.ok(row("reply_metadata").leaks.includes("metadata"));
  assert.ok(row("fingerprint_request").leaks.includes("operators_see_inputs"));
});

test("never claims more than the code gives: documents and keys are not shown to outsiders, operators are not called blind", () => {
  for (const id of ["loan_documents", "fingerprint_key", "receipt_private_report", "certificate_key"]) {
    for (const p of ["public", "verifier", "lender"]) assert.equal(row(id).cells[p].level, "hidden", `${id}/${p}`);
  }
  // the servicer builds the request and the operator submits fingerprint requests: both see the inputs
  assert.equal(row("loan_documents").cells.truenav_operator.level, "sees");
  assert.equal(row("fingerprint_request").cells.truenav_operator.level, "sees");
  // hardware isolation is an assumption, never shown as a hard guarantee
  assert.equal(row("loan_documents").cells.tee_operator.level, "assumed");
  assert.equal(row("fingerprint_key").cells.tee_operator.level, "assumed");
  assert.equal(row("receipt_private_report").cells.tee_operator.level, "assumed");
  // public chain data is shown as seen by everyone
  for (const id of ["loan_hash", "verdict", "certificates", "attempts_alerts"]) {
    for (const p of ["public", "verifier", "lender"]) assert.equal(row(id).cells[p].level, "sees", `${id}/${p}`);
  }
  // the certificate key is a test key held by the operator
  assert.equal(row("certificate_key").cells.truenav_operator.level, "sees");
});

test("v3 rows say they are designed and not deployed; the live v2 row says no receipt is stored", () => {
  const v3 = ROWS.filter((r) => r.status === "design");
  assert.ok(v3.length >= 2);
  for (const r of v3) assert.match(JSON.stringify(r), /not deployed/i, r.id);
  assert.match(JSON.stringify(row("receipt_v2")), /no receipt is stored on chain/i);
  const live = JSON.parse(read("web/data/recorded/receipts-live.json"));
  assert.ok(live.list_tokens.every((t) => t.receipts === 0), "the recorded live capture has a stored receipt: update the v2 row");
});

test("plain text only: no em or en dashes, no markup", () => {
  const t = allText();
  assert.doesNotMatch(t, /[\u2013\u2014]/);
  const shown = JSON.stringify({ PARTIES, LEAKS, ROWS: ROWS.map(({ item, lives, cells }) => ({ item, lives, cells })) });
  assert.doesNotMatch(shown, /<\/?[a-z][^>]*>/i);
});
