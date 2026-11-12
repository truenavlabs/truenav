# Flipping TEE to live for `registry.tnlab-368aa2.testnet`

Code and docs only. Nothing here calls NEAR AI Cloud, sends a transaction or needs a key. The chain steps (registering the TEE signer, submitting the verdicts) are TrueNav's own and happen outside this repository.

## State

TEE is live on `registry.tnlab-368aa2.testnet` (12 Nov 2026, about 02:20 Bangkok). `tee/status.json` records it:

- the TEE signer `0x2665cce942fa427ef30d87f4b0bff67fb7645462`, registered in `add_tee_signer` transaction `9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE`;
- the model `Qwen/Qwen3-VL-30B-A3B-Instruct` and the report sha256 `05d451cc07311890cda19795b31e06e61111ddf70385e1ff99cd24a095d92657`;
- the verdict set `tee/fixtures/verdicts-368aa2.json` (19 records: 16 honest loans, all pass and all submitted on chain; 3 trap records T1 to T3 that are in the file and deliberately not submitted) and the report `tee/fixtures/attestation-report-368aa2.json.b64`;
- the binding expiry, 11 Dec 2026 19:15 UTC (12 Dec 02:15 Bangkok).

`docs/TEE_STATUS.md` is generated from that file. `npm test` checks that every one of those values equals what the verdicts file says.

## Defaults

With no environment variable, `npm run verify:attestation`, `npm run check:chain-replies`, `npm run chain:read` and `npm run tee:chain-check` read the current registry and, where they need a recorded set, the one named in `tee/status.json`. The earlier instance `registry.tnlab-718ca9.testnet` is reached with a flag:

```bash
npm run verify:attestation -- --contract registry.tnlab-718ca9.testnet
npm run check:chain-replies -- --contract registry.tnlab-718ca9.testnet
```

`TRUENAV_CONTRACT`, `TRUENAV_VERDICTS` and `TRUENAV_REPORT` still work. A named file that does not exist is an error (exit 1), never a silent fallback. The set follows the contract (`tee/recorded-set.mjs`).

## How the flip was done, for the next registry

1. TrueNav records the verdict set outside this repository, registers the TEE signer and submits the verdicts on chain.
2. Drop `tee/fixtures/verdicts-368aa2.json` and `tee/fixtures/attestation-report-368aa2.json.b64` (or the paths for the new registry) into the branch.
3. Dry run, writes nothing:
   ```bash
   npm run tee:flip -- --add-signer-tx <add_tee_signer tx hash>
   ```
   It validates the set offline (binding, 30 day lifetime, 10 days left, every signature, the reply rule, the report sha256), shows the status it would write, and lists the doc lines that must change.
4. `npm run tee:flip -- --write --add-signer-tx <hash>` writes `tee/status.json` as live and regenerates `docs/TEE_STATUS.md`.
5. Edit by hand the `MUST` lines it printed, then `npm run tee:status` and `npm test`.
6. Check against the chain, read only: `npm run tee:chain-check`. Every honest verdict in the file must be on chain with the same signer, model, request hash, verdict, anomalies, expiry and attestation hash; a trap record that is on chain fails the check unless `--allow-traps` is given.

`npm run tee:chain-check` runs in the `judge-path` CI job. It is not part of `npm run judge`, because it needs the network.

## Reviewing a step by transaction hash

After each chain step, anyone can confirm it from the transaction hash, read only:

```bash
npm run tee:tx-review -- 9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE --sender tnlab-368aa2.testnet --expect-receiver registry.tnlab-368aa2.testnet --expect-method add_tee_signer --verdicts tee/fixtures/verdicts-368aa2.json
npm run tee:tx-review -- <tx_hash> --sender <signer account> --expect-method submit_verdict --verdicts tee/fixtures/verdicts-368aa2.json
```

It prints the final status, signer, receiver, block, each call with its deposit, and every receipt result. A verdict's reply body is shown as a sha256 and a length, never in full. For `add_tee_signer` and `submit_verdict` it compares the arguments with the verdicts file.

## Tests

`tee/test/tee-flip.test.mjs`, `chain-check.test.mjs`, `tx-review.test.mjs`, `recorded-set.test.mjs` and the live cases in `tee-status.test.mjs` (in `npm test`) use a synthetic signed set (`tee/test/synthetic-set.mjs`, a throwaway key derived from a label) and an in-memory fake chain. They need no real file.
