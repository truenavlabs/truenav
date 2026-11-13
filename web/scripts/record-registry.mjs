// Record one full read of the live registry into web/data/recorded/registry-368aa2.json. Read only (view calls).
// The app shows this file only when the chain cannot be read, tagged "recorded" with its read time, never as live.
// Run: node web/scripts/record-registry.mjs
import { writeFileSync } from "node:fs";
import { loadRegistry } from "../data/registry.mjs";

const reg = await loadRegistry();
if (reg.state !== "live") {
  console.error(`read was ${reg.state}: ${reg.errors.map((e) => `${e.call}: ${e.message}`).join("; ")}`);
  process.exit(1);
}
const out = new URL("../data/recorded/registry-368aa2.json", import.meta.url);
writeFileSync(out, JSON.stringify({ note: "Recorded read of the live registry, for offline fallback and tests. Not live data.", ...reg }, null, 1) + "\n");
console.log(`recorded ${reg.loans.length} loans, ${reg.funds.length} funds at block ${reg.block && reg.block.height}, read ${reg.readAt}`);
