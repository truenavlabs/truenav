# TEE status

Generated from `tee/status.json` by `npm run tee:status -- --write`. Do not edit by hand: `npm test` fails if this file differs from what the status file renders.

Registry: `registry.tnlab-368aa2.testnet`
TEE status: **live**

A verdict set bound to `registry.tnlab-368aa2.testnet` is recorded in `tee/fixtures/verdicts-368aa2.json`: model `Qwen/Qwen3-VL-30B-A3B-Instruct`, TEE signer `0x2665cce942fa427ef30d87f4b0bff67fb7645462`, 19 records (16 pass, 3 flag), signed 2026-11-11, expires 2026-12-11. The published attestation report is `tee/fixtures/attestation-report-368aa2.json.b64` (sha256 `05d451cc07311890cda19795b31e06e61111ddf70385e1ff99cd24a095d92657`).

The TEE signer was registered in transaction `9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE`. 16 of the 19 records are honest loans, submitted on chain; 3 are trap records (a tampered document each) that are in the file and were deliberately not submitted.

The files cannot show what is on chain, so check it against the chain (read only, no environment variables; add `-- --contract registry.tnlab-718ca9.testnet` to `verify:attestation` and `check:chain-replies` for the earlier instance):

```bash
npm run chain:read                  # loans no longer pending
npm run check:chain-replies         # every submit_verdict reply within the allowed keys
npm run verify:attestation          # the signer is the attested model key
npm run tee:chain-check             # every honest verdict in the file is on chain, signer and expiry match
```

A TEE proves which code ran, not that the model's judgment is right. Limits: `tee/eval/REPORT.md`. The earlier instance `registry.tnlab-718ca9.testnet` keeps its own recorded set.
