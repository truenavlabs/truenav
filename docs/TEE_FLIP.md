# Flipping TEE to live for `registry.tnlab-368aa2.testnet`

Code and docs only. Nothing here calls NEAR AI Cloud, sends a transaction or needs a key. The chain steps (registering the TEE signer, submitting the verdicts) are TrueNav's own and happen outside this repository.

## Order

1. TrueNav records the verdict set (outside this repo) with `tee/underwrite.mjs`, registers the TEE signer and submits the verdicts on chain.
2. Drop the two files into the branch:
   - `tee/fixtures/verdicts-368aa2.json`
   - `tee/fixtures/attestation-report-368aa2.json.b64`
3. Dry run. Writes nothing:
   ```bash
   npm run tee:flip
   ```
   It validates the verdicts offline (`tee/verdicts-file.mjs`: binding, 30 day lifetime, 10 days left, every signature, the reply rule), checks the report sha256, prints the status it would write, and lists every doc line that must change.
4. Flip:
   ```bash
   npm run tee:flip -- --write
   ```
   This writes `tee/status.json` as live and regenerates `docs/TEE_STATUS.md`.
5. Edit by hand the `MUST` lines the script printed in `README.md`, `TRUST_MODEL.md` and `ARCHITECTURE.md`, and look at the `CHECK` lines (including the comment in `certify/check-chain-replies.mjs`). Until the `MUST` lines change, `npm run tee:status` and `npm test` fail, on purpose: the docs must not say TEE is pending once it is live.
6. Check against the chain, read only:
   ```bash
   npm run tee:chain-check
   ```
   It confirms on `registry.tnlab-368aa2.testnet` that the registered TEE signer is the file's signer with the file's model and report hash, that the binding and expiry are right, and that every verdict in the file is stored on chain with the same signer, model, request hash, verdict, anomalies, expiry and attestation hash. Exit 0 all pass, 1 a check failed, 2 usage or network error.

`npm run tee:chain-check` is an optional step of the judge path. It is not part of `npm run judge`, because it needs the network and the verdict set.

## Reviewing a step by transaction hash

After each chain step, anyone can confirm it from the transaction hash, read only:

```bash
npm run tee:tx-review -- <tx_hash> --sender <signer account> --expect-receiver registry.tnlab-368aa2.testnet --expect-method add_tee_signer
npm run tee:tx-review -- <tx_hash> --sender <signer account> --expect-method submit_verdict --verdicts tee/fixtures/verdicts-368aa2.json
```

It prints the final status, signer, receiver, block, each call with its deposit, and every receipt result. A verdict's reply body is shown as a sha256 and a length, never in full. For `add_tee_signer` and `submit_verdict` it compares the arguments with the verdicts file.

## Tests

`tee/test/tee-flip.test.mjs`, `tee/test/chain-check.test.mjs` and `tee/test/tx-review.test.mjs` (in `npm test`) use a synthetic signed set (`tee/test/synthetic-set.mjs`, a throwaway key derived from a label) and an in-memory fake chain. They need no real file.
