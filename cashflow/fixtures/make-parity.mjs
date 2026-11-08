// Writes the raw-data parity fixtures cashflow/fixtures/parity/cashflow-parity-<token>.json for the 4 synthetic
// funds: the exact raw inputs (dataset and run options) and the reference output as canonical JSON. The frozen
// spec score cases (spec/v2/fixtures/score-cases.json) are separate and are not touched here. Regenerate only on a
// method change, never to chase a headline number:   node cashflow/fixtures/make-parity.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { datasets, AS_OF, PERIOD, DAYS_IN_PERIOD } from "../demo/data.mjs";
import { runFund } from "../run.mjs";
import { METHOD } from "../../spec/v2/score.mjs";
import { canonical } from "./canonical.mjs";

export const PARITY_OPTIONS = { asOf: `${AS_OF}T00:00:00Z`, period: PERIOD, daysInPeriod: DAYS_IN_PERIOD, bankFetchedAt: "2026-10-31T22:00:00Z" };
// A fixed, public test seed for the pseudonyms (inside the TEE the key is OutLayer's derived key and never known).
export const PARITY_PSEUDONYM_SEED = "parity-fixture-pseudonym-seed-0001";

export function parityOutput(ds) {
  const r = runFund(ds, { key: PARITY_PSEUDONYM_SEED, ...PARITY_OPTIONS });
  return canonical({ token_id: r.token_id, kind: r.kind, method: r.method, match: r.match, metrics: r.metrics, public_metrics: r.public_metrics, passport: r.passport, score: r.score });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("./parity/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const ds of datasets()) {
    const fixture = { name: `cashflow-parity-${ds.id}`, method: METHOD, note: "Synthetic raw-data parity fixture. The Rust/WASM build must turn input into exactly expected_output (canonical JSON bytes).", input: { dataset: ds, options: PARITY_OPTIONS, pseudonym_seed: PARITY_PSEUDONYM_SEED }, expected_output: parityOutput(ds) };
    writeFileSync(new URL(`cashflow-parity-${ds.id}.json`, dir), JSON.stringify(fixture, null, 1) + "\n");
    console.log(`wrote cashflow-parity-${ds.id}.json (${fixture.expected_output.length} bytes of expected output)`);
  }
}
