# TrueNav red team, round 1

Scope: `lab/engine-v3` at `90eb18447dd84c6fa98f9364392a3c20ca1f0ce9`. Simulated data only. No production code was changed. No transaction was sent. No key material is recorded here.

Repro tests assert the property that should hold. They fail on the current code.

## Findings

| id | severity | area | file:line | description | repro test | suggested fix |
| --- | --- | --- | --- | --- | --- | --- |
| RT-01 | high | pledge | `outlayer/engine-v3/src/engine.rs:438` | A first-lien lock owned by another fund sets `pledge_conflict` and caps the score at 59 red. The same lock with `lien_rank >= 2` sets `pledge_result` to `unknown`, adds only `second_lien_unsupported`, and leaves the score uncapped. A temporal book that scores 97 stays at 97 when loan 5 is someone else's pledge labeled as a second lien. Lien rank is not part of the fingerprint, so the registry row is the same loan. | `redteam_r1_second_lien_of_another_funds_loan_must_cap_at_59` | Treat a completed foreign lock as `pledge_conflict` for every lien rank. |
| RT-02 | high | pledge | `engine/v3-core/src/source.rs:337` | Pledge identity is the MAC of the full canonical terms. Adding 1 cent to `principal_cents`, or splitting that principal across two borrower ids that share collateral, produces new hashes. The engine then treats the new hash as an incomplete pledge instead of a conflict, and the 97 score returns. The registry stores a bare 64-hex hash, so the second hash pledges cleanly. | `redteam_r1_one_cent_and_split_must_keep_one_pledge_identity`, `redteam_r1_one_cent_term_edit_must_not_escape_pledge_conflict` | Bind pledge identity to a stable collateral key and keep immaterial term edits on the original lock. |
| RT-03 | high | pledge | `outlayer/engine-v3/src/engine.rs:413` | NAV uses the servicer tape field `principal`. The fingerprint uses signed `terms.principal_cents`. Nothing checks that they are the same amount. Raising tape principal from 100000 to 200000 on an otherwise valid book is accepted. | `redteam_r1_tape_principal_must_match_signed_terms` | Reject a loan whose tape principal cents differ from the signed terms. |
| RT-04 | high | pledge | `engine/v3-core/src/source.rs:280` | `normalized_id` folds ASCII case and ASCII whitespace only. NBSP (`U+00A0`) and ideographic space (`U+3000`) survive, and non-ASCII case is not folded. Each variant is a second fingerprint for one borrower or collateral id. | `redteam_r1_unicode_space_and_case_must_not_fork_fingerprints` | Reject non-ASCII whitespace and case-fold the whole id, or fail closed on any character outside the canonical alphabet. |
| RT-05 | high | fund_id | `engine/v3-core/src/source.rs:47`, `receipts/attestation/match-core.mjs:40` | Signed source scope is `network`, `receipts_contract`, `fund_account`, `token_id`. The execution body and the TDX `output_hash` carry `token_id`, not registry `fund_id`. `matchWithCapabilities` ignores a caller-supplied `fund_id`. A proof for `harbor-credit-fund` still returns `attested` when the caller sets `context.fund_id` to `victim-credit-fund`. On chain, `accept_v3` does bind the pending `token_id`, so a runner cannot store that body under a second token. The gap is the off-chain label. | `redteam_r1_caller_fund_id_must_match_the_attested_token` | Put registry `fund_id` in the signed scope and the execution body, and reject a proof whose `fund_id` differs from the envelope. |
| RT-06 | high | pledge | `tee/fingerprint.mjs:4`, `engine/v3-core/src/source.rs:337` | v1 fingerprints are `HMAC(key, "truenav-fp-v1\|" + asset + "\|" + document id)`. v2 fingerprints are a MAC of canonical loan terms. The registry locks whichever 64-hex string it is given and does not record the scheme. The two hashes of one loan both pledge. Renaming the v1 document id also changes the hash. | `redteam_r1_v1_document_fingerprint_and_v2_terms_must_collide` | Record the scheme with the lock and refuse a second scheme or a renamed document for the same loan. |
| RT-07 | medium | attestation | `receipts/attestation/match-core.mjs:47` | The matcher accepts a quote only when Intel status is `UpToDate`, and it checks REPORTDATA, measurements, wasm, caller, project, and output hash. It does not apply an age or revocation window. A proof with `timestamp` 1600000000 and status `UpToDate` still returns `attested`. | `redteam_r1_stale_UpToDate_quote_must_expire` | Reject quotes older than the receipt window and treat a revoked TCB as unavailable. |
| RT-08 | medium | attestation | `receipts/src/attestations.rs:181` | The cap counts records whose `attester` is the current writer. Rotating the writer grants another 3 slots. Four distinct proof URLs were stored on one receipt after one rotation. Storage and the O(n) scan grow with every rotation. | `redteam_r1_rotation_cannot_exceed_three_records_per_receipt` | Cap records per receipt, independent of who the current writer is. |
| RT-09 | medium | attestation | `receipts/src/attestations.rs:184` | `publish_attestation` and `get_attestations` `expect` the index entry and the record. Deleting the record behind index 0 makes the next publish panic with `attestation record missing` instead of returning a clean rejection. | `redteam_r1_missing_attestation_record_must_not_panic` | Return a fixed error when an index or record is missing, and do not panic a payable call. |
| RT-10 | medium | gas | `receipts/src/lib.rs:416` | If the latest stored receipt is not a JSON object, `request_run` refunds the deposit and returns `{"error":"v3_receipt_corrupt"}` from a successful function result. Callers that treat a successful transaction as a requested run miss the refusal. Confirmed value: `{"error":"v3_receipt_corrupt"}`. | `redteam_r1_corrupt_head_must_not_return_success` | Fail the transaction with that code so the receipt status is a failure. |
| RT-11 | medium | privacy | `api/server.mjs:67`, `receipts/src/lib.rs:742` | v3 envelopes are banded. v2 receipts remain readable after migration through `get_receipt` and `get_history`, and `GET /fund/{token}/score` returns `uncapped_score` plus `collection.rate_bps`. The HONEST-CREDIT view still carries `parts_x100`, and the score route returns `uncapped_score` 100. | `redteam_r1_public_v2_views_must_not_expose_exact_cents`, `redteam_r1_public_v2_score_must_not_expose_exact_cents_or_parts` | Serve v2 history through the same public-field allowlist, or stop returning exact cents and uncapped parts. |
| RT-12 | medium | storage | `receipts/src/lib.rs:322`, `receipts/src/v3.rs:79` | Every `register_token` and `configure_v3_fund` scans every token for an ASCII case collision. There is no token cap and the contract pays the storage. Forty extra tokens register, and the next one still succeeds. `list_funds` (`v3.rs:171`) walks the whole map before applying `skip`. | `redteam_r1_token_registration_is_bounded` | Cap the token set, bill storage to the caller, and bound the case scan. |
| RT-13 | medium | refund | `receipts/src/lib.rs:589` | Any failed OutLayer promise adds `outlayer_deposit` to the callback refund. A panic after OutLayer has already refunded the payer is indistinguishable from an admission failure, so the contract pays the deposit again from its own balance. The in-code comment at `lib.rs:534` states this. | existing `admission_failure_refunds_the_outlayer_deposit_an_admitted_failure_does_not` covers only the admission path | Refund the OutLayer deposit only when the promise failed before admission. |
| RT-14 | low | integrity | `receipts/src/v3.rs:339` | A v3 envelope with JSON `score: null` is stored in the index as `score` 0. `get_latest` then reports a numeric zero. The agent special-cases null in the JSON. A client that reads only the index does not. | repro: store an unscored v3 envelope and read `get_latest().score` | Keep a tri-state score so null is not indexed as 0. |
| RT-15 | low | auth | `receipts/src/lib.rs:389`, `receipts/src/attestations.rs:128` | Admin and pauser calls require exactly 1 yoctoNEAR. `request_run` and `publish_attestation` do not. A function-call key with an allowance can request runs or publish proof locators. | repro: call either method with a function-call key and a non-1-yocto deposit | Require 1 yocto, or restrict those keys to the single method and a spend limit. |
| RT-16 | low | auth | `query/src/lib.rs:109` | `buy_query` respects pause. `redeem` does not, so a paused query contract still spends entitlements. | repro: `set_paused(true)`, then `redeem` as the redeemer | Check `paused` inside `redeem`. |
| RT-17 | info | keys | `TRUST_MODEL.md:18` | The contract account is documented to hold the owner's full-access key and an operator backup key. Either key can upgrade the wasm, call `migrate_v3` (`#[private]`), and replace the callback, pledge, and disclosure checks. Admin, registrar, and pauser sit on the owner account. The servicer is a separate operator account. | no key action taken | Remove the backup key and move upgrades to a multisig before any real value. |
| RT-18 | info | supply | `.github/workflows/ci.yml:222`, `.github/workflows/ci.yml:26` | Actions are SHA-pinned, the build image digest is pinned, Cargo.toml uses `=` versions, and both lockfiles are present. `gitleaks` is installed with `go install ...@v8.30.1` (module checksum, not a binary digest). `jsonschema==4.23.0` is installed from PyPI without a hash pin. `npm audit --omit=dev` reports the known low `elliptic` advisory through `@phala/dcap-qvl`, already accepted in `SECURITY.md`. | `npm audit --omit=dev --audit-level=high` exits 0 | Pin the gitleaks binary digest and the pip hash. |

## What was attacked and held

- Receipts admin, pauser, propose/accept admin, and `set_config` require the predecessor role and exactly 1 yoctoNEAR. Pause blocks `request_run` and `publish_attestation`.
- `on_run_result` and `migrate_v3` are `#[private]`. A predecessor other than the contract account cannot resume the callback or migrate.
- `accept_v3` stores a body only when method, network, contract, token, fund account, period, seq, previous hash, nonce, and engine hash match the context snapshotted at `request_run`. A worker cannot attach another token's body. Sequence and `prev_receipt_sha256` are checked again against `get_latest`.
- Attestation records are append-only, idempotent on the same proof URL, and bound to token, seq, receipt hash, and body hash. Proof URLs are canonical `https://testnet-api.outlayer.ai/attestations/by-request/{integer}` only. A URL for token A does not publish against token B.
- The matcher rejects a non-`UpToDate` TCB status, a wrong REPORTDATA, an unapproved measurement, and a substituted output, input, wasm, caller, or project. `output_hash` is checked against canonical body bytes. The parity helper covers the frozen goldens for `serde_json::to_string`.
- v3 validation selects the schema with `method_version`. After migration, `set_config` and `request_run` require `truenav-v3.0.1`. A v3.0.0 envelope does not satisfy a v3.0.1 pending context.
- v3 public envelopes use a closed schema. Exact NAV and `score_x100` stay in the salted private report. Guest failures collapse to `{"error":"run_failed","stage":"v3_closed"}` with no source text.
- Registry pledge, certificate, verdict, and role paths keep their 1 yocto and predecessor checks. NEP-171 transfer panics. Certificate messages bind `fund_id`, account, manager, and contract id. Verdicts bind loan hash, contract, network, and expiry.
- The API checks token ids, caps `/ask` at 4096 bytes, and does not proxy arbitrary URLs. `fetchPublicProof` allows only the OutLayer attestation prefix, refuses redirects, and stops at 256 KiB. No path traversal sink was found in `api/server.mjs`.
- Wasm pins match the request: receipts `b7fb827ac4d51cd2d92090fa5caea88b1e3a3a99c63103411303aa78eb7d1f47`, engine `0ffb3e314f2a3881bd28ab70cb9ba01a6f9b6f6fe41af8ef81b0455ce9ca8d38`. Image digest `sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e`. Workflow `run` scripts do not interpolate untrusted input. No `curl | bash` script was found.
- No `.env` file is in the tree. No secret value is included in this report.

## Keys, locations only

| use | where |
| --- | --- |
| NEAR account `private_key` | `~/.near-credentials`, read at `certify/testnet.mjs:57`, `certify/vault-demo.mjs:20`, `receipts/deploy-testnet.mjs:61`, `api/chain.mjs:12` |
| OutLayer payment key | env `PAYMENT_KEY`, `tee/fingerprint.mjs:54` |
| NEAR AI Cloud | env `NEAR_AI_CLOUD_API_KEY`, described in `SECURITY.md` |
| Sealed engine config | env `TRUENAV_DATA_TOKEN`, `TRUENAV_REPORT_STORE_TOKEN`, `TRUENAV_SOURCE_REGISTRY_JSON`, roster and URL vars in `outlayer/engine-v3/src/main.rs` |
| Contract full-access key and operator backup key | `TRUST_MODEL.md:18` |
| Query redeemer | function-call key intended for `redeem` only, `query/src/lib.rs:78` |
| Sandbox dev key | `near-sandbox` `DEFAULT_PRIVATE_KEY`, noted at `certify/sandbox.mjs:13` as the published sandbox key |
| Test source keys | public test keys in `engine/v3-core/tests/fixtures/source-registry.TEST.json`. The pipeline test seed is test-only. |

## Test results

Recorded on this machine after `npm ci`. The first `npm test` before install failed three files on missing packages (`@noble/curves`, `solc`, `viem`). After install:

- `npm test`: 303 passed, 0 failed.
- `npm audit --omit=dev --audit-level=high`: exit 0. Two low `elliptic` findings, production only.
- `cargo test --locked` in `contract/`: all suites passed (91 tests across the non-empty targets).
- `cargo test --locked` in `outlayer/engine-v3`, skipping `redteam_r1`: 18 passed.
- `cargo test --locked` in `engine/v3-core`, skipping `redteam_r1`: 11 passed, plus 2 pattern tests in the library build.
- `cargo test --locked --lib` in `receipts`, skipping `redteam_r1`: 25 passed.
- `cargo test --locked --test contract` in `receipts`, skipping `redteam_r1`: 24 passed.
- `cargo test --locked` in `query`: 8 passed.
- `cargo test --locked` in `vault`: 5 passed.
- `cargo test --locked` in `outlayer/engine-v2`: 21 passed.

Red team repros, all failing on current code:

- `engine/v3-core` `--test redteam_r1`: 0 passed, 3 failed.
- `outlayer/engine-v3` `redteam_r1`: 0 passed, 3 failed. Second lien stayed at score 97 `unknown`. One-cent edit returned score 97 `incomplete`. Inflated tape principal was accepted.
- `receipts` lib `redteam_r1`: 0 passed, 3 failed. Rotation stored a fourth record. Missing record panicked. Corrupt head returned `{"error":"v3_receipt_corrupt"}`.
- `receipts` `--test contract` `redteam_r1`: `redteam_r1_public_v2_views_must_not_expose_exact_cents` failed because `parts_x100` is on the view. `redteam_r1_token_registration_is_bounded` failed because token `CAP-40` still registered (`unbounded registration returned` empty, the call did not panic).
- `node --test receipts/attestation/redteam-r1.test.mjs api/test/redteam-r1.test.mjs`: 0 passed, 3 failed. Caller `fund_id` still attested. Stale `UpToDate` quote still attested. Public v2 score returned `uncapped_score` 100.
