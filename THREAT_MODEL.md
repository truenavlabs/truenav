# Threat model

Attacker goals against TrueNav and what stops each one today. "Test" names the test or command that shows it.

| # | Attack | Mitigation | Test |
| --- | --- | --- | --- |
| 1 | Pledge the same loan to a second fund | lock per loan_hash; refusal returns "already pledged elsewhere", counts an attempt, alerts the holder | `second_fund_is_refused_counted_and_holder_alerted`; `npm run e2e:testnet` |
| 2 | Move a pledge token to another fund | `nft_transfer` and `nft_transfer_call` always panic | `pledge_tokens_cannot_be_transferred` |
| 3 | Forge or edit a score certificate | EIP-191 signature from a registered signer over every field | `tampered_certificate_fails_the_signature_check` |
| 4 | Replay a certificate on another deployment or an older one | contract id inside the message; `signed_at` must increase per fund | `replayed_or_older_certificate_is_rejected` |
| 5 | Two certificates with the same signed bytes | `|` banned in free-text fields of the pipe-joined message | `audit_pipe_*` |
| 6 | Rename a fund to escape its history | fund_id bound to account and manager | `renamed_fund_id_is_rejected_hole_5` |
| 7 | Submit a tampered document as clean | TEE compares document with claim; flags amount, asset, id mismatches, copies | `npm run tee:demo` |
| 8 | Prompt injection inside a document | system prompt treats the document as data and reports injection_attempt | T2 in `npm run tee:demo` |
| 9 | Edit a TEE verdict from flag to pass | contract hashes the reply itself; any edit changes the recovered signer | `edited_response_fails_the_tee_signature`; e2e "edited TEE verdict rejected" |
| 10 | Reuse a pass verdict for another loan | the reply must name the same loan_hash | `verdict_cannot_be_moved_to_another_loan` |
| 11 | Replay a signed verdict | each signed reply accepted once | `the_same_signed_verdict_is_accepted_once` |
| 12 | Hide a flag behind a later pass | latest counts, but the history and flag count stay public | `latest_verdict_counts_and_history_keeps_the_flag` |
| 13 | Never get checked | no verdict 7 days after the pledge makes the loan unverified | `engine/test/tee.test.mjs` |
| 14 | Admin call from a leaked function-call key | admin, servicer and pledge calls require exactly 1 yoctoNEAR (full-access key) | `*_without_one_yocto_is_refused` |
| 15 | Grief the registry storage with refused pledges | only admin-registered fund accounts can pledge; each call costs gas | `audit_2_*` (contract pays storage, owner decision) |
| 16 | Exhaust gas on long lists | paged views capped at 100 | `audit_3_*` |
| 17 | Deploy different code than the source | reproducible build, code hash on chain | README "Verify the deployed code" |
| 18 | Leak keys through the repo | gitleaks over full history in CI; keys only in `~/.near-credentials` and gitignored `.keys/` | CI `secrets` job |
| 19 | Supply-chain swap of CI actions | actions pinned to commit SHAs; gitleaks checksum pinned | `.github/workflows/ci.yml` |

| 20 | A rival submits a genuine TEE flag on another fund's loan | only the servicer submits verdicts | `a_rival_fund_cannot_submit_a_verdict`; live: rival flag rejected |
| 21 | A rival lists another fund's nft_id to lower its score | with chain data, only the on-chain pledge holder's line verifies | `engine/test/ownership6a.test.mjs` |
| 22 | Replay a signed verdict on another contract or network, or after it is stale | binding with contract, network, version and a 30-day expiry | binding tests in `tee_verdicts.rs` |
| 23 | Pre-load or inherit a verdict across pledges | a verdict counts only since the current pledge; unpledged loans refused | `verdict_counts_only_for_the_current_pledge` |
| 24 | Skip the cash expiry rule with a malformed or future date | all invalid attestations are unattested, each flagged | `engine/test/cash6b.test.mjs` |
| 25 | A leaked key of one role takes over the contract | separate admin, registrar, pauser and servicer roles; pause switch | `contract/tests/roles.rs` |
| 26 | "Trust us" on the TEE key | published attestation report, re-checkable by anyone | `npm run verify:attestation` |
| 27 | Read document text out of the public `submit_verdict` arguments (the model echoing fields or quoting evidence) | reply holds only fixed keys and value types; evidence is a line number, never a quote; client, contract and CI reject anything else | `tee/test/reply.test.mjs`, `a_real_tee_signed_reply_from_6_nov_that_echoed_document_fields_is_refused`, sandbox e2e, `npm run check:chain-replies` |

## Open risks (known, not fixed)

- The servicer and a backup contract-account key are held by the operator on testnet; admin, registrar and pauser are the owner's account (see TRUST_MODEL).
- The demo loan fingerprint is guessable for real identifiers; real use needs salted commitments (an HMAC with a key kept in a TEE).
- Engine inputs other than chain data (attempt list, cash attestation, liabilities) are fund supplied; see `engine/TRUST_MODEL.md`.
- The LLM underwriter can be wrong in either direction. With the 7 Nov prompt it flagged no honest document in 60 and missed no tampered one in 66 (one run each, synthetic documents; on 6 Nov it flagged 3 of 40 honest ones); see `tee/eval/REPORT.md`.
- The servicer chooses which verdicts to submit and can re-run the TEE; an independent servicer is assumed.
- The contract pays for storage on testnet; mainnet needs storage deposits.
