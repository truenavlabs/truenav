// The Trust page shows the privacy boundary table, the attestation evidence with its last verified time, and the
// evidence ledger, from the recorded data, with existing components and existing CSS only. Rendered on the server;
// skipped when web/node_modules is absent (the root CI job installs only the root package).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canRender, renderPage, sectionById, textOf, WEB } from "./helpers/render-page.mjs";
import { PARTIES, LEVELS, ROWS, LEAKS } from "../src/content/privacy-boundary.ts";
import { lastVerifiedLine } from "../src/content/attestation-evidence.ts";

const skip = !canRender && "web/node_modules is not installed";
const read = (p) => readFileSync(join(WEB, p), "utf8");
const json = (p) => JSON.parse(read(p));
let html;
const page = async () => (html ??= await renderPage("src/pages/Trust.tsx"));

test("privacy boundary section: every party, every row, every cell level, every source and every leak", { skip }, async () => {
  const sec = sectionById(await page(), "t-privacy-boundary");
  assert.ok(sec, "no section with id t-privacy-boundary");
  const t = textOf(sec);
  for (const p of PARTIES) assert.ok(t.includes(p.label), p.label);
  for (const r of ROWS) {
    assert.ok(t.includes(r.item), r.item);
    for (const s of r.sources) assert.ok(t.includes(s.file), `${r.id}: source ${s.file} not shown`);
    for (const [pid, cell] of Object.entries(r.cells)) assert.ok(t.includes(cell.note), `${r.id}/${pid} note not shown`);
  }
  for (const label of Object.values(LEVELS)) assert.ok(t.includes(label), label);
  for (const l of LEAKS) assert.ok(t.includes(l.title) && t.includes(l.text), l.id);
  assert.match(t, /not deployed/i);
});

test("attestation evidence section shows the last verified time, the hash, both commands, what it proves and what it does not", { skip }, async () => {
  const s = json("data/recorded/attestation-evidence.json");
  const sec = sectionById(await page(), "t-attestation-evidence");
  assert.ok(sec, "no section with id t-attestation-evidence");
  const t = textOf(sec);
  assert.ok(t.includes(lastVerifiedLine(s)), "the last verified line is not shown");
  assert.ok(t.includes(s.evidence_hash));
  for (const c of s.commands) assert.ok(t.includes(c), c);
  for (const x of [...s.proves, ...s.not_proves]) assert.ok(t.includes(x), x.slice(0, 50));
  for (const r of s.outlayer.records) assert.ok(t.includes(r.document_id) && sec.includes(r.proof_url), r.document_id);
  assert.ok(t.includes(String(s.outlayer.distinct_quotes)) && t.includes(String(s.outlayer.approved_measurement_sets)));
  for (const c of s.near_ai.checks) assert.ok(t.includes(c.check.replace(/\s+/g, " ")), c.check);
  assert.ok(t.indexOf("What these checks do not prove") > t.indexOf("What these checks prove"));
  assert.doesNotMatch(t, /guarantee|trustless|zero.knowledge|fully verified/i);
});

test("evidence ledger section shows every transaction with a full hash, an explorer link and the block time in UTC", { skip }, async () => {
  const l = json("data/recorded/evidence-ledger.json");
  const sec = sectionById(await page(), "t-evidence-ledger");
  assert.ok(sec, "no section with id t-evidence-ledger");
  const t = textOf(sec);
  for (const e of l.entries) {
    assert.ok(t.includes(e.tx_hash), `${e.id}: the full hash is not shown`);
    assert.ok(sec.includes(`href="${e.explorer_url}"`), `${e.id}: no explorer link`);
    assert.ok(t.includes(e.block_time_utc.slice(0, 19).replace("T", " ") + " UTC"), `${e.id}: UTC time`);
    assert.ok(t.includes(String(e.block_height)) && t.includes(e.label) && t.includes(e.outcome.result), e.id);
  }
  assert.ok(t.includes(l.evidence_hash));
});

test("the new sections use only CSS classes that already exist, and are marked for the UI pass in the source", { skip }, async () => {
  const css = read("src/styles.css") + read("src/shell/app.css");
  const defined = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
  for (const id of ["t-privacy-boundary", "t-attestation-evidence", "t-evidence-ledger"]) {
    const sec = sectionById(await page(), id);
    for (const m of sec.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) assert.ok(defined.has(c), `${id}: class "${c}" is not in any stylesheet`);
  }
  const src = read("src/pages/trust/PrivacyProof.tsx");
  assert.equal((src.match(/UI PASS:/g) || []).length, 3, "each of the three sections carries a UI PASS note");
  assert.ok(read("src/pages/Trust.tsx").includes("PrivacyProof"));
});

test("sections appear in the order boundary, attestation, ledger and keep the existing Trust content", { skip }, async () => {
  const h = await page();
  const at = (id) => h.indexOf(`id="${id}"`);
  assert.ok(at("t-privacy-boundary") > 0 && at("t-privacy-boundary") < at("t-attestation-evidence") && at("t-attestation-evidence") < at("t-evidence-ledger"));
  const t = textOf(h);
  for (const must of ["What is true today", "Known limits", "This site", "Storage headroom (N-01)"]) assert.ok(t.includes(must), must);
});

test("plain text only: no em or en dashes on the rendered Trust page", { skip }, async () => {
  assert.doesNotMatch(textOf(await page()), /[\u2013\u2014]/);
});
