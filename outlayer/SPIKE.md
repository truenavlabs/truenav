# OutLayer spike: private loan fingerprints (owner decision D1, 7 Nov 2026)

Question: can the guessable demo fingerprint `sha256("truenav-demo-v1|" + asset + "|" + document id)` be replaced by an HMAC whose key nobody holds, computed in a TEE, on NEAR testnet, before 10 Nov? Go/no-go is the owner's call on 10 Nov, 21:00 Bangkok.

## What was tested (testnet, 7 Nov)

| # | Test | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `outlayer/fingerprint` builds for `wasm32-wasip2` (OutLayer's target) | pass, 131 KB | `cargo build --release --target wasm32-wasip2` |
| 2 | Deployed as project `servicer.tnlab-22cfb2.testnet/truenav-fingerprint` (wasm on FastFS, sha256 checked on deploy) | pass | v1 `eff11e4b98dc6c34...`, v2 `f2a880319fa2cf99...` |
| 3 | HMAC over HTTPS: `mac("loan-fingerprint", "truenav-fp-v1|real_estate|SPIKE-TITLE-001")` with a key derived inside the TEE for this project and the caller | pass: `b0efdc00...2690` | call `091662d7-8d22-404f-bd3a-7e47d35e159c` |
| 4 | Deterministic: the same input gives the same fingerprint (needed for double pledges to collide) | pass, 3 runs | v1 runs, v2 call `a0c77be4-8275-442f-99f6-ca0ff0ec0239` |
| 5 | A different document id gives a different fingerprint | pass: `30aeaa9b...0dac` for SPIKE-TITLE-002 | v1 run |
| 6 | The key survives a new code version (project key, not wasm key) | pass: v2 gives the same `b0efdc00...` | v2 call `a0c77be4-...` |
| 7 | On-chain calls are refused, because on-chain input is public | pass: the module answers an error | testnet txs `G21tgbCr...`, `83NaNz7T...`, `3Dw6pp7T...` (fictional demo ids only) |
| 8 | Per-run attestation is public (`/attestations/by-call/<id>`): Intel TDX quote, worker measurement, `wasm_hash` = our build, `input_hash` = sha256(input), `output_hash` = sha256(output) | pass, both hashes recomputed | `fp-att` of call `091662d7-...` |
| 9 | The OutLayer TDX quote verifies with dcap-qvl (the library we already use) | pass: UpToDate, 0 advisories | `@phala/dcap-qvl` 0.7.0 |
| 10 | dcap-qvl 0.7.0 builds for `wasm32-wasip2` and verifies a real Intel TDX quote inside OutLayer (the NEAR AI Cloud quote from our published attestation report) | pass: UpToDate, 0 advisories, 156M instructions, 1.3 s | project `truenav-quote-check`, call `1c6e52cb-a29e-4a0b-9476-503e78f53db5`; native control run gives the same |
| 11 | `storage_account` syntax | documented as `"storage_account": "predecessor"` in the manifest (OutLayer encryption-keys guide); not needed by this design, which keeps no storage | docs only, not deployed |

## Findings that change the design

- **The key belongs to the caller.** OutLayer derives each key from the project and the calling account. One shared key, so that fingerprints from different funds collide, needs one caller: the servicer, which already sees every document for the TEE underwriter. Funds ask the servicer for fingerprints; nobody else can compute them.
- **HTTPS only.** On-chain `request_execution` publishes its input. Over HTTPS the input does not go on chain. Payment keys on testnet use `usdc.fakes.testnet` (fake test USDC, minted to the servicer: tx `FrAv5ANX...`); each run cost 1000 units of the test balance.
- **The attestation's input hash leaks without a nonce.** `input_hash = sha256(input)` is public. With only `{asset_type, document_id}` it is as guessable as the old fingerprint. Version 2 requires a random `nonce` (at least 32 hex characters) that the MAC ignores: the fingerprint stays deterministic, the input hash does not.
- **Who can check what.** Anyone can check, from the public attestation, that a fingerprint is the output of this exact wasm in an attested TDX worker. Nobody outside can recompute a fingerprint from a document id, which is the point. Linking a fingerprint to a given document needs the servicer or the TEE.

## Not done in the spike

- Wiring the new fingerprint into the demo (new loan hashes, new pledges, re-signed TEE verdicts, a new instance or new pledges on the live one): waits for the owner's go.
- Checking the attestation's REPORTDATA binding (task hash) and `is_measurements_approved` on `worker.outlayer.testnet`: for the verify script after a go.
- A second caller account, to show that another account gets another key (documented by OutLayer, not tested here).
