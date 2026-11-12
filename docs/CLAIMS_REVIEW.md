# Claims review, 11 Nov 2026

Scope of this pass: clippy over every Rust crate, a read of the root `README.md` for statements that have no test or command behind them, and a re-check of the counts in `receipts/README.md`. The root `README.md` is not edited here. Statements the owner may want to soften are listed in section 3.

Labels: **verified** means a command was run in this pass and the output was seen. **CI** means read from a named CI run, not re-run here. **unverified** means not checked.

## 1. Clippy

`cargo clippy --locked --all-targets -- -D warnings`, run from each crate directory.

| Crate | Toolchain | Result |
| --- | --- | --- |
| `contract` | 1.97.0 (CI toolchain) and 1.99.0 | 0 warnings, exit 0 on both (verified) |
| `vault` | 1.97.0 (CI toolchain) and 1.99.0 | 0 warnings, exit 0 on both (verified) |
| `engine/v3-core` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `mirror/mock-signer` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `outlayer/engine-v2` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `outlayer/engine-v3` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `outlayer/fingerprint` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `outlayer/quote-check` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `query` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `receipts` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `receipts/mock-outlayer` | 1.99.0 | 0 warnings, exit 0 (verified) |
| `receipts/tests/outlayer-output-parity` | 1.99.0 | 0 warnings, exit 0 (verified) |

No warning needed a fix, so no Rust source is changed in this pass. Two crates, `outlayer/fingerprint` and `outlayer/quote-check`, are not clippy-checked by `ci.yml` today; they are clean as of this pass but nothing stops that changing. Adding them to CI is a separate, small change.

## 2. Counts in `receipts/README.md` (Tests section)

| Line | Was | Now | How |
| --- | --- | --- | --- |
| `cargo test` in `receipts` | 36 | 96 pass, 1 ignored (55 unit, 29 contract, 12 mirror; the wasm test is ignored) | verified locally, Rust 1.99.0 |
| `cargo test` in `query` | 8 | 8 | verified locally |
| `node --test api/test/api.test.mjs` | 7 | 12 | verified locally |
| `npm run e2e:receipts` | 67 checks | 109 `PASS` lines | CI: run 43075427743, job `receipts`, step "End to end on the sandbox". Not run locally (needs Docker). |

The description text after each count lists examples only. It was not rewritten.

### Fingerprints: 18 `PASS` lines live, "19 of 19" in judge S9

Both numbers are right and count different things.

- `tee/loans.json` has **19 rows**: 16 honest loans and 3 tampered variants (T1, T2, T3).
- `tee/fixtures/fingerprints.json` has **17 records**, one per distinct document id. T1 and T2 are altered copies of the documents for H-RE-01 and H-RE-02, so they reuse those two fingerprints. T3 has its own document id (`TITLE-DEMO-HRE09`) and its own record.
- `npm run verify:fingerprints` prints one `PASS` line per record (**17**) plus one `PASS` line for the whole of `tee/loans.json` (**1**): 18 lines. That last line says "for all 19 loans".
- Judge S9 runs the same row check offline and reports it per row: "19 of 19 hashes match ... (17 records ...)".

No code or text change is needed. If the README should say it, the owner can add: "17 records, 19 rows".

## 3. Statements with no test or command behind them

Each is in the root `README.md`. I did not change the README. A softer wording is suggested where it would help.

| Statement | Where | What is missing | Suggested handling |
| --- | --- | --- | --- |
| "TrueNav does not move or block funds." / "It does not block any transfer." | top section; How it works step 5; Security and limits | No test. The contracts hold no fund assets and no transfer hook was found by reading, but nothing checks that. | Soften to "The contracts in this repository do not custody or transfer fund assets", or leave as a design statement. |
| "The API in this repo stores no loan document." | Security and limits | No test. `api/spend-store.mjs` writes spend and entitlement state to disk; I read it and saw no loan document, but that is a reading, not a check. | Soften to "stores only entitlement and spend state", or add a test that lists the files the store writes. |
| "Pledges, verdicts, attempts, alerts and certificates ... do not name the other fund or show a loan." | Security and limits | The refusal text `already pledged elsewhere` is asserted (`contract/tests/registry.rs`), so a refusal does not name the other fund. Nothing asserts the same for attempts, alerts or certificates. | Narrow to what is tested: "a refused pledge says `already pledged elsewhere` and does not name the other fund." |
| "Per the deploy records, one is the owner's key and one is an operator backup key." | Roles and keys | The deploy records are not in the repository. | Already labelled as a record; keep, or cite where the records are. |
| "Outside models ... gave second opinions ... Every finding was checked by running code." | Hackathon disclosures | `AUDIT_FINDINGS.md` lists findings, but the claim that every one was checked by running code has no per-finding command. | Soften to "findings are listed in `AUDIT_FINDINGS.md` with what happened to each". |
| "first commit is `4874363` on 5 Nov 2026 ... no `pre-hackathon` tag" | Hackathon disclosures | Verified locally with `git log --reverse` (first commit `4874363`, 2026-11-05). Not a CI check: Actions checks out a shallow clone, so a test would fail there. | Keep. It is true; it just cannot be a CI test. |

## 4. Claims that now have a test (added in this pass)

| Claim | Test |
| --- | --- |
| The demo agent refuses the master, `receipts.`, `query.`, `runner.` and `api.` accounts when run with `--execute`. | `agent/test/shared-accounts.test.mjs` (3 tests; removing `api.` from the list in `agent/run.mjs` made it fail) |
| The library versions in "Libraries and tools" equal the lockfiles and the CI pin (near-api-js, near-sandbox, noble curves and hashes, dcap-qvl, ganache, solc, viem, near-sdk in four Cargo.lock files, jsonschema, the build image name). | `tests/readme-pins.test.mjs` (5 tests; changing one README version made it fail) |

Both are in `npm test`.

## 5. Found while checking, not changed

- `agent/run.mjs` still defaults `TRUENAV_MASTER` to `tnlab-718ca9.testnet`. That is the earlier master. The agent only reads, or signs with its own account, so no money is at risk, but it is the same stale default the deploy script had. Left alone: changing it alters agent behaviour and is outside this pass.
- Root `README.md` says `added 506 packages` for `npm ci`; a fresh clone added 505 (PR #1 already corrects this).
- `outlayer/fingerprint` and `outlayer/quote-check` are not in the clippy steps of `ci.yml` (section 1).
