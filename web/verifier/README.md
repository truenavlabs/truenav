# Verifier panel data layer

Framework-free ES modules, no layout or CSS. Runs in the browser (bundle `@noble/curves` and `@noble/hashes`) and in Node 22.

```js
import { loadEvidence, fetchText, runVerifierChecks, summarize } from "./web/verifier/index.mjs";
const evidence = await loadEvidence(fetchText("/"));   // tee/status.json, certify/live-registry.json, the verdicts file, the report
const checks = await runVerifierChecks({ evidence });   // public testnet RPC, read-only view calls
const { counts, green } = summarize(checks);
```

Each check is `{ id, label, state, detail, source, evidenceDate? }`, frozen.

| state | meaning |
|---|---|
| `live` | read from the live registry now, or a signature or hash computed now from the published files |
| `recorded` | from a committed evidence file; `evidenceDate` is when it was captured |
| `unchecked` | not checked here; `detail` says why. A chain read that fails gives `unchecked`, never `live` |
| `fail` | a comparison failed, or the check could not complete |

Show a green summary only when `summarize(checks).green` is true: nothing failed and every chain check was read live.
Tests: `web/verifier/test/verifier-data.test.mjs` (RPC cut, HTTP 500, flipped signature byte, changed reply, changed report byte, expiry boundary).
