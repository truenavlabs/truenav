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

## Open risks (known, not fixed)

- Single admin key (see TRUST_MODEL).
- The demo loan fingerprint is guessable for real identifiers.
- Engine inputs other than TEE verdicts (attempt list, cash attestation, liabilities) are fund supplied; see `engine/TRUST_MODEL.md`.
- A copycat fund listing someone else's nft_id can lower that fund's score (open scoring rule question; verifying nft_id ownership on chain would close it).
- The LLM underwriter can be wrong in either direction; T1 and T2 carry one extra anomaly code beside the expected one.
- Anyone may submit a TEE-signed verdict for any loan_hash. A rival can obtain a genuine TEE flag on another fund's loan with a fake document and submit it; the latest verdict counts, so the loan becomes unverified until a newer pass is submitted. Verdicts can also be added in bulk at low cost, with storage paid by the contract.
- Verdicts attach to the loan_hash, not to the current pledge: a verdict submitted before the pledge counts, and after release and re-pledge the previous holder's latest verdict still applies.
- A malformed, missing or future-dated cash attestation date is not penalized the way an honestly expired one is (a future date reads as fresh).
- Full-list views (get_certificate_history, get_attempts, get_alerts) can run out of view gas on long lists; use the paged views.
