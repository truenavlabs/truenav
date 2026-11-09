# Receipts v3 gated upgrade

Status: local candidate only. No deploy, transaction, key change, secret setup, OutLayer upload or run has been executed for this task. the owner must approve each later live action separately. Testnet only. The production receipts account and the other shared accounts stay untouched until their specific approval.

## Evidence and frozen boundary

Base: frozen ecf179c, method truenav-v3.0.0. No frozen spec, schema, method artifact, golden or observer is edited. The four frozen goldens remain exact serialization conformance vectors for envelope/execution bytes and receipt_sha256 only. Their opaque commitments and unbuilt engine placeholder are not claims of financial execution.

`schema/vectors/engine-v3-derived.json` is separate TEST evidence from actual Rust execution: fixed labelled TEST seed/salts, runtime-generated signing material, real built engine hash, private 9917/4284, public 99/43, correction and cap variants, plus consecutive receipts where a loan becomes unverified. No private signing key is committed. The same unchanged all-public-field observer checks these outputs against the frozen bounds. Production uses fresh host entropy and encrypted private storage, never TEST salts.

The new public TEST source registry matches the IDs, roles, scopes and windows in lab/verifier a17b1c3. Its usable public keys differ from that lane's repeated-byte placeholders. Verifier files are unchanged. The verifier/feed lane must select the actual public TEST registry to recheck derived TEST signatures. This is an integration mismatch, not an attestation.

## Public interface and migration

The original Receipts Borsh root and collection prefixes are unchanged. Versioned raw sidecars record the migration, immutable fund bindings, reserved request contexts, per-period heads and first v3 sequence. Mirror recovery/date fixes already in the frozen base remain in the one candidate wasm.

1. Pause and drain all pending runs. Migration refuses an unpaused state or an in-flight run. Keep a state/code snapshot and hash before changing code.
2. Deploy code and call private migrate_v3 in one transaction batch signed by that receipts account. The migration is one-time, keeps the account paused, preserves every v2 byte and disables v2 configuration/writes thereafter.
3. Bind v3 credit funds, registry hash and period; set the real v3 engine pin; verify views; unpause only after approval and dry-run success.

For each existing token let N be its last stored v2 seq, captured before the upgrade. The v2 range is 1..N. Its first accepted v3 receipt is N+1 and prev_receipt_sha256 is the exact stored v2 receipt digest, including the v2 outer-byte digest convention. A new fund starts at 1 with a null previous digest. `get_first_v3_seq(token_id)` returns null until that first v3 receipt, then its decimal string. Record N and this returned boundary per token in the upgrade evidence, not one invented global boundary.

`get_receipt(token_id, seq)` is explicitly version-tagged:

- receipt_version "2": every old storage-wrapper field unchanged, including the original receipt string and digest, plus this explicit version field.
- receipt_version "3": the complete frozen public envelope itself.
- unknown sequence/token: null.

The verifier/feed adapter MUST check the tag and reject v2 wrappers as v3 envelopes. That adapter belongs to lab/verifier and is not edited here. `get_latest`, `get_history`, token/config views and historical v2 bytes remain available. Their compatibility wrapper's numeric score is not an interpretation of a nonnumeric v3 status; v3 consumers must use the envelope/status. A nonnumeric v3 cannot request a numeric mirror update.

New feed views: get_latest_receipt (highest appended v3 sequence, including corrections), inclusive ascending get_receipt_history (version-tagged, page <=100) and list_funds. A correction must supersede the current v3 head for the same fund/period; it appends a new sequence and previous hash rather than mutating old data. Fresh duplicate fund/period receipts are rejected. Corrections to an older period can therefore become the latest appended receipt; consumers also inspect the period.

The DEMO-CREDIT test replays the existing cash dataset through the new engine, checks cohort suppression and rejects old metrics/late_share_bps/cohort-dollar fields in the contract. The former 850M-cent denominator plus 1500-bps reconstruction is absent from new v3 receipts. Historical public data cannot be erased from chain history. Do not claim retroactive privacy for it.

## Local reproducible checks

```sh
npm ci
npm test
node outlayer/engine-v3/check-local.mjs
cargo +1.99.0 clippy --locked --all-targets --manifest-path receipts/Cargo.toml -- -D warnings
cargo +1.99.0 clippy --locked --all-targets --manifest-path outlayer/engine-v3/Cargo.toml -- -D warnings
cargo +1.99.0 clippy --locked --target wasm32-wasip2 --manifest-path outlayer/engine-v3/Cargo.toml -- -D warnings
gitleaks git --redact --log-opts="--all"
```

Pinned build image: sourcescan/cargo-near:0.22.0-rust-1.99.0 at sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e. Contract command: cargo near build non-reproducible-wasm --locked. Engine command: cargo +1.99.0 build --release --locked --target wasm32-wasip2. Build hashes are recorded in receipts/v3-build.json. The normal receipts hash is ece3cde2f08c8216590bd61f1803a762ac4e555065509cab1049bc842c8e5fb9; the local WASI engine hash is c3299ccf5414c351bc3e8fc773ca2bccddeedc1b71974e36a21bfebaee092fb2. Use image user 0, /home/near/code/receipts and its default target path for the canonical receipts build, as in CI; scratch target paths produce different embedded build metadata. The engine hash is an actual local artifact, not a claim of cross-environment binary reproducibility. They are build evidence only, not deployed-code claims.

Sandbox/e2e suites are skipped locally under the owner's open-file-limit instruction. CI must run them, including a wasm-metered v3 migration/callback on an old-state snapshot, before the live upgrade. Native mocked-chain tests do not prove wasm gas adequacy. Candidate callback budget starts at 80 Tgas, OutLayer request 200 Tgas, subject to the dev measurement and the owner approving config.

## Fresh dev-account rehearsal, before the shared account

Each numbered live action below needs its own yes. These are the exact intended operations, not commands executed by this task. Never run the legacy D1/D2 deploy script for this v3 migration: it is a v2 fresh-deploy path and can create keys/accounts.

1. Approve creation/funding of receipts-v3-dryrun.codex.tnlab-718ca9.testnet, controlled only by the existing Codex dev account. Approve any new dev key file separately; no credentials are generated here. The original roughly 2 testnet NEAR is insufficient for a 469966-byte contract's storage. Measure storage_byte_cost and code size first; budget at least code_bytes * storage_byte_cost plus state/run/gas margin, roughly 4.700 testnet NEAR for code alone at 1e19 yocto per byte; allow at least 6 testnet NEAR including state and margin. Request testnet faucet funds only after approval. No real funds.
2. Approve deployment of the exact retained pre-v3 wasm on that dev account, initialization with isolated dev admin/pauser/runner, and local synthetic v2 state seeding via a separately approved dev run. Shared accounts are never test-write targets. Export v2 views and raw code/state snapshots to local ignored output files. If seeding needs an OutLayer run, obtain that yes separately.
3. Build a separate TEST ONLY receipts artifact with `--features dry-run-tests`. It loads receipts/tests/deploy-context.dryrun.json only under that explicit build flag. The sole schema-context change is the receipts account; network remains testnet. It cannot be a default, judge or verifier build. Envelopes made for it must fail normal frozen validation. Run the core overlay test with `cargo +1.99.0 test --manifest-path engine/v3-core/Cargo.toml --features dry-run-tests`. Test output must say DRY_RUN. Use a separate explicitly flagged engine artifact for dev context. Hash both separately and never promote either to production pins.
4. Approve pause: receiver dev receipts, method pause, args {}, exactly 1 yocto, 30 Tgas. Read every token's pending status. Wait for callbacks or obtain a separate yes for each clear_pending(token_id), exactly 1 yocto; record late-callback refunds. Require no pending runs.
5. Approve one batch to the dev receipts account: DeployContract(exact TEST candidate bytes), then FunctionCall(migrate_v3, {}, 0 yocto, 100 Tgas). The dev receipts account signs so the private method is self-only. Confirm paused and every v2 wrapper/string/digest is unchanged. Unknown get_receipt seq must return null. Confirm get_first_v3_seq still null.
6. Approve configure_v3_fund(token_id, context), exactly 1 yocto, 50 Tgas. Context fields: fund_account, period_start, period_end, judge_valuation_time (pinned benchmark value or null), source_registry_sha256 (JCS public registry digest), supersedes_seq null, correction_reason_code null. Only credit is accepted. The fund-account binding cannot later change. Choose existing registered simulated fund scopes for read-only registry checks; never mint or alter registry pledges as part of this rehearsal.
7. Separately approve the v3 OutLayer upload/project/profile, any sealed service credentials/configuration and any private report-store setup. Pin the real wasm SHA and source registry. Source registry and namespace/revision/roster settings are trusted inputs. Verify source-adapter documents and encrypted-store acknowledgement using the locally tested interfaces. No source key or report salt appears in public output.
8. Approve set_config(config), exactly 1 yocto, 50 Tgas: method truenav-v3.0.0, version_key the approved real engine SHA, dev project/profile/owner, max_instructions 10000000000, max_memory_mb 128, max_execution_seconds initially 180, outlayer_deposit 0.01 testnet NEAR, storage_deposit 0.25, outlayer_tgas 200, callback_tgas 80. The account's actual resource/funding sufficiency and OutLayer limits must be confirmed first. Keep that config as a reviewed local JSON file without secrets.
9. Approve unpause {}, exactly 1 yocto, 30 Tgas; approve request_run(token_id) from the isolated runner separately, with configured run/storage deposit and 300 Tgas. This is a testnet transaction and an OutLayer run, each needing yes. Capture only redacted public results. If loan-terms-v2 locks do not exist, require unverified evidence rather than treating the old fingerprints as matches; the benchmark pins are proven locally, not asserted for absent live locks. Check first v3 seq=N+1, previous v2 digest, public/private pins where the authenticated registry evidence supports them, salted private commitments, normal-schema rejection of the dev context, unknown seq behavior, correction chaining, privacy guard, and source-key failure behavior. Check actual callback gas/storage/refunds before approving any shared upgrade. A live TEE proof must be verified against the build and execution body before any attestation claim.

## Shared upgrade on Wednesday 11 Nov

Only after successful rehearsal, CI sandbox gates, explicit budget approval and the owner's distinct shared-account upgrade yes:

- Capture finalized view_code and view_state locally, hash the old wasm, and record code hash, config, pause state, all token heads, mirror lane state/attempts and pending requests. Never export access-key secrets. This task has not queried or verified the currently deployed code hash.
- Approve pause/drain on receipts.tnlab-718ca9.testnet. Do not change registry, query, runner, api or mirror accounts as a side effect.
- Deploy the NORMAL candidate bytes and private migrate_v3 in one self-signed batch, as in the dev rehearsal. No dry-run feature or overlay is present. Verify the old v2 bytes, sequence boundaries and mirror state unchanged.
- Obtain separate yes for fund/context configuration, the production v3 build/profile/secret bindings, config switch, unpause, each first run, a correction, and any later Base Sepolia mirror transaction/funding/finality confirmation. Reuse the new backend bytes in this one receipts upgrade; do not first deploy c19fc647 separately.
- Have the verifier/feed lane confirm tag handling and the actual public source registry before enabling reads of v3. Do not claim TEE attestation while attestation_ref is null. The proof-to-envelope reference flow and live service wiring are an integration gate before publication.

## Rollback

Before first v3 receipt, an approved rollback may restore the exact captured old code/config while paused, after the dev rehearsal proves the state is compatible. No storage-data deletion is necessary; old root layout is preserved. Retain migration sidecars for forensic continuity.

After any v3 receipt, do not return to a v2 writer or delete sequences. Pause, preserve both histories, pin the last approved compatible v3 build, and forward-fix under a new reviewed build. The v3 marker prevents set_config/request_run from re-enabling a v2 writer in v3 code. An older binary does not enforce that marker, so old-code redeployment after v3 is not a safe writable rollback. Every rollback, config switch, unpause and corrective run requires its own yes.

## Remaining integration evidence

Not verified here: live source adapters, registry loan-terms-v2 lock population, sealed roster completeness, report store/buyer delivery, OutLayer execution/proof, wasm-metered callback/storage cost, RPC timing, fresh dev dry run, shared deployment or Base operations. The registry is read-only in this task; no old filename-based fingerprint is silently treated as a new terms fingerprint. Missing new locks become unverified, never a green assumption.

No code is changed in sim/ or verifier/. The shared CI workflow adds real engine-output gates and a local-only old-wasm migration/callback replay. The receipts deploy helper funding estimate increases to 5.5 testnet NEAR for its larger candidate code; it is not executed. Root package.json, README and other agent-owned interface implementations are unchanged. The registry TEST keys and get_receipt version tag require coordination with lab/verifier. The 307 claim is not supported by the available tree: npm reports 290 Node tests here; 9e4469c contains 16 Q&A tests, which totals 306, not 307. The separate NAV worked-example command passes, but is not an additional Node test. There is no identified missing 17th QA test; do not invent one or label 307 verified. The local Q&A commit and protected branches remain untouched.
