# TEE status

Generated from `tee/status.json` by `npm run tee:status -- --write`. Do not edit by hand: `npm test` fails if this file differs from what the status file renders.

Registry: `registry.tnlab-368aa2.testnet`
TEE status: **pending**

No TEE verdict set is recorded for `registry.tnlab-368aa2.testnet`: no TEE signer is registered on it and it holds no `submit_verdict` calls. `npm run chain:read` shows its loans as pending.

The recorded TEE verdicts, the published attestation report and the `submit_verdict` history belong to the earlier instance `registry.tnlab-718ca9.testnet` (`tee/fixtures/verdicts.json`). The live attestation, fingerprint and chain-reply checks read that instance.

To move to live: record a verdict set bound to this registry, validate it (`node tee/verdicts-file.mjs <file> --contract <registry>`), submit it on chain, then set `tee` to `live` and fill `verdicts_file` and `report_file` in `tee/status.json`.
