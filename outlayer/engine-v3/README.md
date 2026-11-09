# TrueNav engine v3

Local implementation of `truenav-v3.0.1`, the approved pledge-conflict amendment to frozen `truenav-v3.0.0` at ecf179c. Historical v3.0.0 envelopes and artifacts stay unchanged. All parties and data in tests are simulated. There is no live deployment or TEE attestation claim.

## Local gates

Use Docker, Rust 1.99.0, its wasm32-wasip2 target, Node and Python jsonschema. From the repository root:

```sh
npm ci
npm test
node outlayer/engine-v3/check-local.mjs
cargo +1.99.0 clippy --locked --all-targets --manifest-path outlayer/engine-v3/Cargo.toml -- -D warnings
cargo +1.99.0 clippy --locked --target wasm32-wasip2 --manifest-path outlayer/engine-v3/Cargo.toml -- -D warnings
```

The gate builds the WASI component with the digest-pinned image and fixed paths in `build-pinned.mjs`, checks `receipts/v3-build.json`, then verifies committed `schema/vectors/engine-v3-derived.json`. CI never regenerates vectors. A second clean target can be checked with `node outlayer/engine-v3/build-pinned.mjs --recheck`. A source change requires an explicit TEST-vector regeneration using the freshly built file's SHA256 as TRUENAV_TEST_ENGINE_SHA256 and TRUENAV_WRITE_DERIVED_VECTORS=1. Tests generate TEST signing material only in memory. No native production runner exists. The frozen four goldens are serialization conformance vectors; they are not regenerated.

## Authenticated inputs

The receipt contract reserves context: fund/account, period, next sequence, previous receipt hash, correction, request ID/nonce, source-registry hash and engine build. The WASI entry point fetches four scoped source documents from the sealed data service:

`GET /v3/funds/{token_id}/{servicer|bank|fund_admin|custodian}?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD`

Every response requires `X-Synthetic-Data: true` and the frozen SignedSource framing. Every payload is authenticated before its financial fields are used. Source IDs, roles, fund, period, revision, validity, revocation and payload hash are checked. Unknown or forged keys reject the financial claim. Unknown key IDs terminate without a public body, so untrusted identifiers cannot be echoed into provenance. A signature failure in the pure pipeline produces a nonnumeric verification_failed receipt with the closed source hold. The production host can stop earlier with a fixed v3_closed failure, without printing financial data.

Payload contracts for this backend:

| Role | Private payload |
| --- | --- |
| servicer | `loans`: legacy NAV loan rows plus `terms` and `lien_rank`; `cashflow`: existing credit servicer adapter document with loans, payments, schedule and as_of |
| bank | Existing bank-feed document; its signed data_as_of is the coverage time. Optional payload as_of can only make coverage older. An attested cash balance additionally needs balance_cents and balance_as_of |
| fund_admin | `fund`: NAV fund fields and certificate metadata; `issuer`: existing credit issuer claims document |
| custodian | `loan_terms`: one `{loan_id, terms, lien_rank}` per servicer row |

`terms` is canonical loan-terms-v2: borrower_namespace/id, origination_date, principal_cents, USD, collateral_namespace/ref. It must occur identically in the servicer-signed row and custodian-signed terms. IDs use NFC, trim/collapse ASCII whitespace, ASCII upper-case unless the trusted namespace policy declares case sensitivity. Dates are Gregorian UTC dates; principal is canonical integer cents, not float or exponent. The fingerprint is the OutLayer common project/predecessor MAC of the frozen framed term digest, with the loan-terms-v2 key path. File names are irrelevant. Rank >=2 is explicitly unknown and unverified, with second_lien_unsupported. A proven rank-1 conflict elsewhere in that book remains conflict; an unsupported second lien cannot hide it.

Finalized NEAR views provide ownership and attempt history at one block hash. A lock must name both the correct registered token and fund account. A failed/incomplete read cannot become verified coverage. Registry read coverage counts distinct completed reads; value coverage is R7 and is separate. R10 uses a sealed complete fund roster, authenticated sibling documents and the registry's manager identities. R10 historical event snapshots are not exposed by the existing registry; the frozen current-state fallback applies when no authenticated historical snapshot exists. Operator roster completeness is an additional trust assumption. Both v3 key declarations explicitly use bind=project and caller=predecessor. The predecessor is the receipts contract for every fund, so changing the original authorized runner cannot change loan identities or make a previous report undecryptable. OutLayer attestation caller_account_id is a different identity: the original proven NEAR signer, checked against the execution request by the off-chain matcher.

## Private report and public output

The old cashflow-v2.1.0 implementation supplies cash caps and collection holds only. The 40/40/20 NAV method supplies the unrounded total. Public score is whole-number round-half-up; private precision is independently committed. No fourth weight is added. In v3.0.1 a confirmed active first-lien conflict also adds pledge_conflict, caps the score at 59 and makes the band red. R7/R13 still apply; a nonnumeric status stays nonnumeric. Unsupported rank >=2 adds a visible hold only, without a conflict cap unless another first-lien conflict is proven.

Public NAV uses the fixed integer 1-2-5 ladder. All exact money, cash matches, individual positions, precision parts and the fresh random 32-byte salt stay in the private report. Late share follows the existing >60 DPD cashflow signal. Positive cohort counts below five use lt_5; complementary cells are suppressed. Public cash has bands only and no dollar denominator.

The host encrypts the complete private report with the OutLayer truenav-report-v3 key path, with AAD binding network, contract, token, nonce and full_report commitment. An authenticated store must acknowledge both the commitment and ciphertext digest before public output is emitted. POST the ciphertext object to the sealed store URL; GET that URL plus `/{full_report}` returns the ciphertext_hex for a prior report. Buyer authorization, payment and re-encryption are the separate report-service lane, not implemented here. The raw salt/report never goes to stdout. A previous v3 report is decrypted and checked against its public salted commitment before its cash passport is used for carry-forward checks.

The guest emits execution body B only. The contract adds issued_at, attestation_ref and receipt_sha256. attestation_ref stays null permanently under option 3. Separate append-only contract records link the exact body hash to public proof locators; readers verify them off chain. Private salts and exact values are absent from every public receipt and the Base score/hash mirror.

## Sealed host configuration

Names only; never paste values into source, terminal logs or chat:

- TRUENAV_DATA_URL and TRUENAV_DATA_TOKEN: read-only simulated source service.
- TRUENAV_SOURCE_REGISTRY_JSON: public registry, JCS-hash pinned by the reserved request.
- TRUENAV_SOURCE_MIN_REVISIONS_JSON and TRUENAV_CASE_SENSITIVE_NAMESPACES_JSON: trusted revision and namespace policy.
- TRUENAV_FUND_ROSTER_JSON: complete registered fund roster for manager attribution.
- TRUENAV_TESTNET_RPC_URL: only the two explicit testnet endpoints in main.rs are accepted.
- TRUENAV_REPORT_STORE_URL and TRUENAV_REPORT_STORE_TOKEN: private encrypted report storage.

No signer key is needed by this read-only engine. Any secrets/profile creation, OutLayer upload/run or testnet transaction requires a later, separate yes. The public TEST registry is at `engine/v3-core/tests/fixtures/source-registry.TEST.json`; it must never be selected as a production trust root.

## Source registry selection

Fixture keys are publicly derivable test keys for reproducibility. The live demo uses fresh runtime keys.

The local public TEST registry exactly snapshots sim/fixtures/source-key-registry.json at lab/sim-data e6f45eb. The WASI host accepts only one explicitly live registry pinned by the contract context. Live IDs use role:live_<run-id>:v1, which fits the frozen schema. Duplicate IDs, mixed fixture/live roots and an ID rebound to different public-key bytes reject. The shared JS SourceRegistrySession under receipts/attestation/ gives the verifier lane the same public trust boundary without editing verifier/. Its integration and the sim lane's live-ID fix remain external gates.
