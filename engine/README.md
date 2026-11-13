# Score engine

`engine/src/score.mjs` implements rules R1 to R24, decided by owner 5 Nov 2026 (see `spec/nav/NAV_SPEC.md`). Plain Node, no dependencies, no network. The engine never throws on bad fund or loan data.

Run all tests from the repo root:

    npm test

This runs the engine tests (`node --test`) and the spec checker (`spec/nav/check.mjs`), which imports the engine and compares it to `spec/nav/fixtures.json`.

## Names

- TrueVal: what the fund's loans are worth after expected losses. Model estimate, not fair value.
- TrueRange: where TrueVal likely falls, assuming loans default independently. Demo estimate, "demo range (independent defaults)".
- TrueNav score: how far you can trust the fund's reported NAV, 0 to 100.

Labels and explainers are exported as `LABELS`; model labels as `MODEL_LABELS`.

## API

- `scoreFund(model, fund, { now, certStore })`: one fund, own attempts only. `certStore` is the verifier's certificate history `{ [fund_id]: [{ fund_id, signed_at }] }`; without it the result is flagged "no cert store: previously_certified not verifiable". Returns the NAV walk: headline, listed book, cash, liabilities, LIH, residual, Policy NAV, TrueVal, TrueRange (low, high), gap over and under with bound side, exclusions with reasons and totals, zero-marked unverified loans, 50% test share (raw and display), concentration, pillars, raw, score, band, status, status rank, warnings, no-green cap, penalty detail, derived previously_certified and manager_id with spoof flags.
- `scorePortfolio(model, funds, { now, certStore, attemptLog })`: applies the R10 manager-wide rules and the R12 yellow cap across funds that share a manager_id. `attemptLog` is the verifier's record per attempt `{ [fund_id]: { [action_id]: { attempting_status, attempting_policy_nav, largest_policy_nav, attempting_open_loans, manager_id } } }`. Shell size is read only from it; payload snapshots are ignored. A fund with no certificate takes manager_id from it.
- `passesMinScore(result, min)`: numeric filter that never passes a no-number status.
- Helpers: `gapPoints`, `coveragePoints`, `freshness`, `penalty`, `dedupeAttempts`, `attemptCost`, `roundHalfUp`, `bandOf`, plus `DEFAULT_MODEL`, `THRESHOLDS`, `STATUS_RANK`, `BUCKET_DPD`.

## Rules (decided by owner 5 Nov 2026)

Weights 40 / 40 / 20 and bands 85 / 60 on the rounded score. PD "demo, not calibrated"; LGD "inference from a corporate stress table; KBRA methodology does not address CRE CLOs". The 30 days, 50% and 10% thresholds are TrueNav's own policy, not agency figures. Coverage on max(LIH, L) (Q1) and LIH with attested cash only (Q2) ship together. Full rule text is in `spec/nav/NAV_SPEC.md` section 4.

Documented edges, tested and not tuned: X9 (50% line jump), X10 (single loan gets a wider range than 100 notes), X11 (max-of-sides gap).

Limits: see `engine/TRUST_MODEL.md`. Roadmap: correlated defaults; on-chain certificate history for previously_certified; binding manager_id to the live NEAR registry signer; liability oracle.

## Decided by owner 5 Nov 2026 (fix block on cb688fc)

- Unknown exposure: a non-finite repaid counts as principal + accrued in the 50% test; a non-finite principal or accrued on an unverified line disclaims the fund ("unverified line with unknown exposure").
- Shell size comes only from `opts.attemptLog`; payload snapshots are ignored (replaces old default 12).
- invalid_fund_fields is a shell status and ranks 0 with verification_failed (replaces old default 3).
- A fund with no certificate takes manager_id from its attempt records; with none it is flagged "attempts not attributable to a manager".
- Floor bind only on a scored fund with a penalty and raw at or below 0. It is read from the own-penalty pass, so sibling penalties do not chain (old default 11, kept).
- Negative cash: set to 0 and added to liabilities, flagged "negative cash treated as liability" (replaces old default 5).
- previously_certified: `opts.certStore` unioned with payload history, cutoff now. A certificate over data older than 30 days, or of unknown age, fails verification even if never certified before (R14 change).
- action_id is deduped across the whole manager (old default 9, extended).
- A missing or unparseable as-of gives `dataAgeHours: null`, freshness 0, and counts as stale (replaces old default 1).

## Decided by owner 6 Nov 2026 13:32 (fix block on db8139f)

- Hole 1: an nft_id that is verified in more than one fund counts as verified in neither. Every listing fund excludes the line ("nft_id listed by several funds") and is flagged, so it drops out of Policy NAV, TrueVal and coverage and counts as unverified in the 50% test.
- Hole 2: in the 50% test only, each verified loan counts at most its EAD in the listed book. TrueVal, Policy NAV and coverage are unchanged.
- Hole 4: attempts rank by age, then action_id. An attempt escalates on "2+ attempts in 90 days" only against strictly earlier attempts (older, or the same age with a lower action_id), so two same-day attempts give one first and one second. Listing order never changes the outcome.
- Hole 5: fund_id is chosen by the payload and keys both the cert store and the attempt log. Documented in `TRUST_MODEL.md` and pinned in a test; binding fund_id inside the signed certificate is contract work.
- Hole 6: an expired claimed cash attestation (past 168 h) is unattested cash. Its cash_asof stays out of the data age and the stale-certificate rule, freshness is 0, and the fund stays scored (same spirit as V4).

Plain fixes in the same block (no new rule): own-property lookups for buckets, assets and policy markdown, so names like "toString" or "__proto__" are "invalid bucket" and never throw (hole 3); "over 50%" is compared in integer cents (hole 7); a retry inside one fund keeps its youngest age (hole 8); a payload manager_id that matches the attempt log is not a spoof (hole 9); concentration uses the 50% test exposure when repaid is missing (hole 10) and groups loans without obligor_id by input position (hole 11); amounts that overflow or yield NaN make the fund invalid_fund_fields with reason "amounts overflow" (hole 12).

Result shape notes (6 Nov): `penaltyDetail.managerDedupedRetries` was removed in db8139f (shared action_id listings are grouped instead). `penaltyDetail.siblingAttempts[].from` is one fund_id, the youngest listing fund (ties by fund_id); `listedBy` lists every listing fund (I2). `unverified.overHalf` and `unverified.listedBook50` show the 50% test inputs. `verifiedNftIds` lists the fund's verified nft_ids.

## Decided by owner 5 Nov 2026 20:10 (fix block on 84de15b)

- One action_id listed by several funds of a manager is one attempt. Its age is the youngest listed age, and every listing fund pays it at that age as its own penalty, flagged "action_id listed by several funds". It is manager-wide if any listing fund is a shell, each judged on its own verifier record when it holds one. Non-listing funds take it as a sibling attempt. A listing fund gets the manager warning when the shared attempt age (the youngest listed age) is within 90 days and another fund lists it too (I1, 6 Nov).
- A fund with no certificate whose attempt records name two or more managers is flagged "conflicting manager_id in attempt log", has managerId null and a sorted managerIds list, and is a member of each named manager. Each attempt goes to the manager its own record names; an attempt whose record lacks manager_id is flagged "attempts not attributable to a manager".
- `opts.certStore` counts only as a plain object (prototype Object or null, not an array) whose every own value is an array. Anything else is ignored, the payload history is used, and the result is flagged "no cert store: previously_certified not verifiable".
- V4: a cash_asof 200 h old stays scored with freshness 0 (the cash is unattested for LIH and the 50% test).

## Decided by owner 6 Nov 2026 (TEE underwriter)

- `opts.teeStore` is the TEE verdict store read from the chain: `{ [loan_hash]: { pledged_at_ms, latest: { verdict, anomalies, at_ms } | null } }`. Each fund loan may carry `loan_hash`.
- A flag makes the loan unverified and excluded ("TEE flag: <codes>"). A verdict counts only when its `at_ms` is strictly after `pledged_at_ms`; equal times mean the verdict may belong to an earlier pledge of the same loan (NEW-05), so the loan is unverified and excluded ("pledge generation ambiguous"). No verdict: pending (unchanged) for 7 days after the pledge, then unverified and excluded ("TEE check overdue"). No loan_hash or no entry: "not checked", unchanged. No valid store: flagged "TEE verdicts not checked", unchanged.
- The result carries `tee: { checked, pass, flag, pending, overdue, notChecked, loans }`.
- Tests: `engine/test/tee.test.mjs`. Rule text: `spec/nav/NAV_SPEC.md` R25.

## Open (implemented default, proposed, pending owner)

Seven older defaults remain open.

1. Closed loans' servicer_asof still enters the oldest-of age (R8 says "every loan").
2. A present non-finite dpd, a present non-finite reported_value, or an invalid policy markdown makes the loan "incomplete data". dpd null counts as absent.
3. Zero open loans with a negative headline is not_rated "no loans in book".
4. Headline below book percent is measured against listed book + cash - liabilities.
5. Missing headline: pillars are computed with headline = listed book; the status already has no number.
6. Blocked attempts with no action_id each count, per fund; non-finite or negative age_days count as age 0.
7. Manager-wide on 2+ attempts applies from the 2nd attempt within any 90-day window, not to the first. This is the only reading that matches the X5 expected numbers.
