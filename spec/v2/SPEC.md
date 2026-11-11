# TrueNav spec v2: is the yield real?

Status: draft for owner review, 7 Nov 2026 (Bangkok). Replaces the pledge-registry scope (owner reset, 7 Nov). Where this conflicts with `spec/nav/NAV_SPEC.md`, older docs, this file wins. Revision 2 after owner review of 7 Nov (red-flag caps, freshness by source as-of, request pinning, re-sign path). All names, funds, properties, borrowers, tenants and numbers are fictional and synthetic.

TrueNav privately checks whether the cash behind a tokenized fund or tokenized rental property is actually coming in. It compares what the issuer says it was paid with cash a bank actually settled, without exposing borrower or tenant files, and publishes a verifiable score and a signed checks receipt. **TrueNav reports and scores only. It never holds, moves or controls investment or fund money.** The only money it receives is small testnet service fees from agents for paid queries.

## 1. Names and tooltips

Tooltip strings below were approved by the owner on 7 Nov. Every demo value in the UI carries a "synthetic" chip. The engine exports them as one `LABELS` table so the UI, the API and the docs read from one source.

| Name | Definition | Tooltip |
| --- | --- | --- |
| TrueNav score | 0 to 100, how well bank-settled cash supports what the issuer reports (section 6). | "How well the cash that actually arrived supports what the issuer reports, 0 to 100. A trust score, not a credit rating." |
| TrueVal | Credit only. Model-based value of the loans: sum over open loans of EAD x (1 - PD x LGD), with PD taken from the bank-verified late-payment cohort. | "What the loans are worth after expected losses, using payments the bank actually settled. A model estimate: not cash collected, not an audited NAV." |
| TrueRange | Credit only. The assumption band around TrueVal: plus or minus 1.96 x sqrt(sum EAD^2 x LGD^2 x PD x (1 - PD)). | "Where TrueVal could fall if the model's assumptions hold (loans default independently). An assumption band, not a guarantee." |
| Cash yield | Annualized interest cash actually settled, over average outstanding principal (section 5.2). | "Interest that actually arrived in the bank, as a yearly rate. Accrued interest and interest added to the loan are not cash." |
| Reported yield | The yield the issuer publishes for the same period. | "The yield the issuer reports for this period." |
| Rental coverage | Rental only. Net operating cash over distributions paid (section 5.3). | "Rent collected, minus expenses and reserves, divided by what was paid out to holders. Below 1.00 means payouts exceed what the property earned." |
| Collection rate | Rental only. Rent settled over rent due. | "Share of rent due that actually arrived. Not the same as occupancy." |
| Late-payment cohorts | current, 30, 60, 90+ days past due, by bank-verified cash (section 5.4). | "How far behind payers are, judged by cash the bank settled, not by the manager's records." |
| Evidence passport | Per-source tier, independence, freshness, coverage and method version (section 7). | "Where each piece of evidence came from, how independent and how fresh it is." |
| Checks receipt | The signed record of one run (section 8). | "What was checked, what was found, what was missing, and when. Anyone can verify it on NEAR and on Base Sepolia." |

TrueVal and TrueRange are not computed for rental tokens. Rental tokens report rental coverage and collection rate instead.

## 2. Methods and versions

| Method id | Use | Status |
| --- | --- | --- |
| `legacy-nav-v1` | The 5 Nov NAV engine (`engine/src/score.mjs`). Kept only as regression tests: Harbor raw 99.17 (shown 99, green), Meridian raw 42.84 (shown 43, red), at 2 decimals. Its pledge-attempt, ownership and overclaim rules are not used by any v2 path. | frozen |
| `cashflow-v2.0.0` | Three-way match, cash yield, rental coverage, cohorts, freshness, passport, score. Kept as regression: `spec/v2/fixtures/score-cases.json` is scored as v2.0.0 (`score(m, "cashflow-v2.0.0")`) and must keep its expected values. | frozen |
| `cashflow-v2.1.0` | v2.0.0 plus collection (5.7): red-flag cap `collection_shortfall` and the two not-green holds. Weights 40/25/15/20 unchanged. Owner decision 8 Nov. | current |

Rules: a receipt names its method id. A receipt is never rescored under a newer method; a new run under a new method writes a new receipt. Patch versions (2.0.x) may only fix bugs that do not change any fixture's output; any output change is a minor version (2.x.0) with new fixtures. The Rust/WASM port and the JS reference must give identical outputs on every fixture for the method id they claim (section 10).

## 3. Shared due/received schema

One engine for loans and leases. Every record is pseudonymous: `unit_ref` and `counterparty_ref` are keyed hashes computed inside the TEE (OutLayer `mac`); no name, address, tax id or account number ever leaves the enclave.

### 3.1 Due (what was owed)

| Field | Type | Notes |
| --- | --- | --- |
| `due_id` | string | stable id within the source |
| `kind` | `loan` or `lease` | |
| `unit_ref` | string | pseudonymous loan or lease id |
| `component` | `interest`, `principal`, `fee`, `rent`, `other` | |
| `due_date` | date (UTC) | |
| `amount_due_cents` | integer | > 0 |
| `period` | `YYYY-MM` | reporting period the amount belongs to |

### 3.2 Claimed (servicer or property-manager records)

| Field | Type | Notes |
| --- | --- | --- |
| `claim_id` | string | |
| `due_id` | string or null | null when the manager did not link it |
| `unit_ref` | string | |
| `paid_date` | date | |
| `amount_cents` | integer | > 0; a reversal is a separate claim with `status: reversed` |
| `status` | `paid`, `partial`, `reversed` | |
| `batch_ref` | string or null | manager's deposit batch id, if any |

### 3.3 Settled (bank transactions, fetched by the TEE)

| Field | Type | Notes |
| --- | --- | --- |
| `txn_id` | string | bank's id; duplicates are dropped and counted |
| `posted_date` | date | |
| `amount_cents` | integer | signed: credits > 0, debits < 0 |
| `counterparty_ref` | string | pseudonymous payer or payee |
| `kind_hint` | `rent`, `loan_payment`, `security_deposit`, `owner_transfer`, `loan_proceeds`, `refund`, `expense`, `distribution`, `unknown` | from the bank's categorization; a hint, never proof |
| `reversal_of` | string or null | `txn_id` of the reversed credit |

### 3.4 Issuer claims (public)

| Field | Type |
| --- | --- |
| `token_id`, `period`, `as_of` | string, `YYYY-MM`, timestamp |
| `reported_yield_bps` | integer |
| `distributions_paid_cents` | integer |
| `accrued_interest_cents`, `capitalized_interest_cents` | integer (credit) |
| `principal_outstanding_cents` | integer (credit) |
| `occupancy_bps`, `expenses_cents`, `reserves_cents` | integer (rental) |

## 4. Three-way match

Inputs: due (3.1), claimed (3.2), settled (3.3). Output per due item, plus exception counts. The matcher never invents a match: anything it cannot tie is shown as an evidence gap.

**M1 Normalize.** Drop exact duplicate `txn_id`s (count them: exception `duplicate_bank_txn`). Drop exact duplicate claims (same `unit_ref`, `paid_date`, `amount_cents`, `status`): exception `duplicate_claim`. Apply reversals: a debit with `reversal_of` cancels that credit; a debit of the same amount from the same `counterparty_ref` within 30 days of an unmatched-reversal credit cancels it as `probable_reversal`. A reversed credit counts as not received.

**M2 Claim to due.** A claim with `due_id` links to it. Without `due_id`, it links to the oldest open due item of the same `unit_ref` whose amount it does not exceed. A claim that links to nothing is exception `claim_without_due`.

**M3 Claim to bank.** A claim is settled when a bank credit (after M1) has the same `counterparty_ref` (mapped to the `unit_ref` inside the TEE) and the same amount, posted within -2 to +5 days of `paid_date`. Batched deposits: one credit may settle several claims of the same `batch_ref` (or the same `paid_date`) when its amount equals their sum exactly; otherwise none of them are settled by it (exception `batch_mismatch`). Each credit settles at most its own amount once.

**M4 Partials.** A due item is `paid_full` when settled amounts linked to it reach `amount_due_cents`, `paid_partial` when some but not all of it is settled, `unpaid` when none is. Overpayments above the due amount stay as `unapplied_credit`, never as income for another unit.

**M5 Classify unlinked bank credits.** A credit that settles no claim is not rent or interest. It is classified from `kind_hint` as `security_deposit`, `owner_transfer` (issuer or sponsor top-up), `loan_proceeds`, `refund` or `unattributed`, and none of these count as cash received. A credit from a payer mapped to a unit that settles no claim is `settled_not_claimed`: it settles no due item and counts neither as cash received nor as collected rent. An owner transfer that funds a distribution is exception `distribution_funded_by_sponsor`.

**M6 Exceptions** (counted, never individually identified in public output): `claimed_not_settled` (the manager says paid, the bank shows no cash), `settled_not_claimed`, `duplicate_claim`, `duplicate_bank_txn`, `probable_reversal`, `batch_mismatch`, `claim_without_due`, `unapplied_credit`, `distribution_funded_by_sponsor`, `stale_source`, `carried_forward`, `missing_source`.

## 5. Metrics

All money is integer cents, all rates integer basis points, rounding per section 10.

### 5.1 Cash received and cash match

Two separately labelled views (owner decision 8 Nov), as in servicer remittance reporting, where collections are reported by the period they were received and delinquency by aging from the due date:

- **Cash match (by period of receipt).** The claim cohort is every non-reversed claim the manager reports as paid in the period (by `paid_date`) that is linked to a due item. `claimed_cash` = sum of that cohort; `cash_match_bps` = the part of the same cohort the bank settled (M3) / claimed_cash, so numerator and denominator come from the same claims. Clamped to at most 10,000 (10,000 when nothing is claimed). `claimed_not_settled` is measured on the same cohort. Cash the bank shows but the manager did not record is reported (`settled_not_claimed`), not rewarded.
- **Collection and arrears (by due period).** `cash_received` for a period = bank-settled amounts linked to due items of that period (M3, M4), net of reversals (M1). Unlinked credits (M5) and non-income credits (security deposits, owner transfers, loan proceeds, refunds) never count. Late-payment cohorts (5.4) age from the due date.

### 5.2 Credit: reported yield vs cash yield

- `cash_interest` = cash received on `interest` due items for the period.
- `accrued_interest` and `capitalized_interest` (interest added to the loan, PIK) come from the issuer claim and are shown next to cash, never added to it.
- `cash_yield_bps` = cash_interest x (365 / days in period) / average `principal_outstanding` over the period, in bps.
- `yield_gap_bps` = max(0, reported_yield_bps - cash_yield_bps).

### 5.3 Rental: coverage and collection

- `rent_due`, `rent_collected` = due and settled amounts on `rent` items for the period.
- `collection_rate_bps` = rent_collected / rent_due. Occupancy is shown separately and never used in place of collection.
- `net_operating_cash` = rent_collected - expenses - reserves (expenses and reserves from bank debits tagged `expense` where present, else from the issuer claim, flagged `expenses_self_reported`).
- `distributions_paid` = bank debits tagged `distribution` for the period. Only when the bank shows none is the issuer claim used, flagged `distributions_self_reported`.
- `rental_coverage_bps` = net_operating_cash / distributions_paid (shown as a ratio, 1.00 = 10,000 bps). Below 10,000 is exception `payout_exceeds_net_cash`.

### 5.4 Late-payment cohorts

Per `unit_ref` (loan or lease), days past due = days from the `due_date` of the oldest due item not `paid_full` (by bank-settled cash) to the run's as-of date. Cohorts (owner decision 7 Nov): `current` (0 to 29 days), `30` (30 to 59), `60` (60 to 89), `90+` (90 or more). Each cohort reports count and outstanding cents. Cohorts with fewer than 5 units are suppressed in every public or Q&A output (section 9).

### 5.5 TrueVal and TrueRange (credit)

Reuses the `legacy-nav-v1` loss math with bank-verified days past due: EAD = principal outstanding (including capitalized interest, flagged) + accrued interest not yet settled. PD, "demo, not calibrated". The four reported cohorts are unchanged; the PD table splits `current` into on time and 1 to 29 days late:

| Bank-verified days past due | Cohort | PD |
| --- | --- | --- |
| 0 or less (on time) | current | 2% |
| 1 to 29 | current | 10% |
| 30 to 59 | 30 | 25% |
| 60 to 89 | 60 | 45% |
| 90 or more | 90+ | 100% |

Why the split (owner review 7 Nov): aligning PD strictly to the cohorts would give a loan 1 to 29 days late the on-time PD of 2%, down from 10% under `legacy-nav-v1`, which makes TrueVal more lenient exactly on early lates, the first sign of the trouble TrueNav exists to show. Keeping 10% for 1 to 29 days costs nothing in reporting (the cohorts stay 0-29 / 30-59 / 60-89 / 90+) and keeps TrueVal at least as strict as v1 for early lates. Late days are measured from bank-settled cash, and the matcher's settlement window (-2 to +5 days, M3) already absorbs ordinary payment-processing delay, so a loan is not counted late for a slow transfer. The legacy pins are unchanged.

LGD: real-estate-secured 31%, unsecured 67% (v1 inference, labeled as such). TrueVal and TrueRange use the v1 formulas in section 1.

### 5.6 Freshness

Per source, age = run as-of minus the source's own as-of: the export timestamp for an upload or manager export, the fetch time for a bank fetch made by the TEE. Never the latest record date inside it (a monthly statement's last transaction can be weeks old while the statement is current).

Before anything is matched, every source is checked: the bank feed, the servicer or manager records and the issuer claims must all be present, each with an `as_of`. A missing source, a missing or null `as_of`, or one that is not a valid timestamp fails the run closed with a named code (`source_missing_<source>`, `as_of_missing_<source>`, `as_of_invalid_<source>`); nothing is scored. Every timestamp (run as-of, fetch time, source as-of, previous as-of) is normalized to UTC before a date is taken from it or two are compared. Accepted forms: `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:MM:SS[.mmm]` with `Z` or a `+HH:MM` / `-HH:MM` offset, years 1970 to 9999; the same instant written with `Z` or with an offset gives the same result.

Every issuer- or source-supplied value that reaches the public metrics is checked for type and range before anything runs (owner review 8 Nov). Issuer: `occupancy_bps` (rental, required) and `reported_yield_bps` (credit, required) integers 0 to 10,000; `principal_outstanding_cents` (credit, required) and the optional `accrued_interest_cents`, `capitalized_interest_cents`, `expenses_cents`, `reserves_cents`, `distributions_paid_cents` integers of 0 or more (an optional field may be absent or null). Sources: roster rows (`principal_cents`, `rent_cents` integers of 0 or more, `occupied` a boolean), claims (`amount_cents` of 0 or more, `paid_date` a valid date) and bank transactions (`amount_cents` a safe integer, `date` a valid date). Integers are written without a fraction or exponent. A failure stops the run with a fixed code (`<field>_invalid`, `roster_invalid`, `claim_invalid`, `bank_txn_invalid`) that never contains the value.

Each source has a cadence and a window:

| Cadence | Full freshness until | Zero at |
| --- | --- | --- |
| `daily` (bank fetch) | 24 h | 168 h |
| `monthly` (manager or issuer export) | 35 days | 65 days |

f is 10,000 bps inside the full window, linear to 0 at the zero point. A monthly export does not lose freshness during its own month.

Every source's age and carried-forward state come from that source's own as-of: the issuer's claims from the issuer's `as_of`, never from the manager export's timestamp. Bank settlements, the manager records and the issuer claims are all required sources, so a stale issuer lowers the run's freshness. A source is `carried_forward` only once a new reporting period has started since the previous run, and then when either its snapshot hash equals the snapshot hash the previous run recorded for that source, or its as-of did not advance past the previous run's as-of for that source. Within the same period an unchanged snapshot is not carried forward (a quiet bank account with no new transactions is normal). A carried-forward source has freshness 0 and raises exception `carried_forward`. The run's freshness is the minimum over required sources.

### 5.7 Collection (`cashflow-v2.1.0`)

For a completed reporting period P, the cutoff T is the last day of P plus 7 calendar days (UTC); a period is completed once T has ended. A run checks its own reporting period once that period's T has ended, otherwise the period before it.

- D = the contractual dues with due dates in P, from the loan or lease schedules (`schedule`, `charges`). A later write-off never removes a due: a written-off row still counts.
- V = bank-settled, claim-linked income allocated to those same dues and posted on or before T: for each due, the claims linked to it (M2) that a bank credit settled (M3), capped at that due's amount. Each claim and each bank credit counts once. M5 applies: bank cash with no manager claim never counts, and security deposits, sponsor transfers, loan proceeds and refunds never settle anything.
- C = V / D, shown as a percentage with 2 decimals (round half up in bps).

Outcomes, recorded in the metrics as `collection: { period, cutoff, status, dues_cents, verified_cents, rate_bps, shortfall }`:

- **verified**: if 10 x V < 9 x D (integers, before any rounding) the cap `collection_shortfall` applies with C in its reason. Exactly 90% passes. There is no exemption by number of units or by amount: one unpaid 100-cent due triggers it.
- **not applicable** (verified zero dues: the schedules are present and complete and nothing fell due in P): no collection rate and no cap, but the hold `collection_not_applicable` keeps the score at 84 or below, because inactivity alone is not green.
- **pending** (T has not ended at the run's as-of, or the bank feed or the servicer or manager records do not cover through the end of T): the hold `collection_pending` keeps the score at 84 or below. `pending_reason` is `before_cutoff` or `no_coverage_<source>`.
- **fail closed**: a missing schedule or roster is `dues_missing`; a due row without a valid id, date or non-negative integer amount, or a cash-paying loan or occupied, rent-bearing unit with no due in a verified P, is `dues_incomplete`. Nothing is scored. Which loans pay cash and which units are occupied is read from the current export (the servicer tape or rent roll the run fetched), not as of P, so a unit that became occupied after P without a charge in P also fails closed (accepted for now, owner review 8 Nov).

Wording: the receipt and UI say "unverified collection", never "default". TrueNav sees only whether cash was bank-confirmed by T, not why it was missing.

## 6. TrueNav score (`cashflow-v2.1.0`)

Reference implementation: `spec/v2/score.mjs` (integer math, section 10); fixtures `spec/v2/fixtures/score-cases.json`; test `spec/v2/score.test.mjs`.

| Part | Max | Credit | Rental |
| --- | --- | --- | --- |
| Cash match | 40 | 40 x min(cash_match_bps, 10,000) / 10,000 | same |
| Yield or payout | 25 | 25 x max(0, 1 - min(yield_gap_bps, 500) / 500) | 25 x clamp((coverage - 0.80) / 0.20, 0, 1) |
| Late payments | 15 | 15 x max(0, 1 - late_share / 20%) | same |
| Freshness | 20 | 20 x run freshness (5.6) | same |

`late_share`: credit, principal outstanding in the 60 and 90+ cohorts over all principal outstanding; rental, rent past due in the 60 and 90+ cohorts over rent due for the period. `raw` = sum of parts. Score = round half up of raw.

**Red-flag caps** (owner review 7 Nov). Each one holds the score at 59 or below, so the band is red, and its reason is written into the receipt (`caps: [{code, reason}]`) and shown in the UI word for word:

| Code | When | Reason shown |
| --- | --- | --- |
| `self_reported_only` | no tier-3 source that is fresh: inside its full-freshness window (daily 24 h, monthly 35 days) and not carried forward | "red because no fresh bank-sourced evidence was available: self-reported only" |
| `yield_gap` | credit, yield_gap_bps of 300 or more | "red because the reported yield is at least 3.00 percentage points above the cash yield" |
| `payout_exceeds_net_cash` | rental, coverage below 1.00 | "red because payouts exceed net cash from rent" |
| `distribution_funded_by_sponsor` | any count above 0 | "red because part of a payout was funded by a sponsor transfer, not by income" |
| `claimed_not_settled` | above 2% of claimed cash | "red because more than 2% of the cash the manager reports was never settled by the bank" |
| `collection_shortfall` | v2.1.0, collection verified and 10 x V < 9 x D (5.7) | "red because of unverified collection: C of contractual dues for P were bank-confirmed by T (at least 90.00% needed)", for example "... 78.57% of contractual dues for 2026-09 were bank-confirmed by 2026-10-07 ..." |

**Holds** (v2.1.0). A hold keeps the score at 84 or below (not green) without a red flag, listed as `holds: [{code, reason}]`: `collection_pending` "not green because collection for the period cannot be verified yet: before the cutoff or without source coverage through it"; `collection_not_applicable` "not green because no contractual dues fell in the period: inactivity alone is not green".

The receipt keeps the uncapped score next to the capped one. Bands: green 85 and up, yellow 60 to 84, red below 60. A payment for a query never changes any input or output of a run.

Raw-data parity fixtures under v2.1.0 (synthetic data with real timestamps of 8 Nov 2026: exports 06:00 UTC, bank fetch 08:30, run 09:00, so every source covers through October's cutoff 2026-11-07 and October is the checked period): demo credit fund 58 red (caps `yield_gap`, `claimed_not_settled`, `collection_shortfall` at 78.57%); demo rental token 58 red (caps `payout_exceeds_net_cash`, `distribution_funded_by_sponsor`, `claimed_not_settled`, `collection_shortfall` at 78.26%); honest credit fund 100 green (raw 99.95) and honest rental token 100 green, collection 100.00% each, no holds.

Frozen v2.0.0 score-case results: demo credit fund 59 red (uncapped 65; caps `yield_gap`, `claimed_not_settled`); demo rental token 59 red (uncapped 78; caps `payout_exceeds_net_cash`, `distribution_funded_by_sponsor`); honest credit fund 96 green; honest rental token 98 green; honest credit fund without bank evidence, or with a carried-forward bank source, 59 red (`self_reported_only`).

## 7. Evidence passport

One entry per source in every run:

| Field | Values |
| --- | --- |
| `source` | `issuer_claims`, `servicer_records`, `property_manager_records`, `bank_settlements` |
| `tier` | 1 `self_reported_upload`, 2 `manager_system_export`, 3 `bank_sourced_tee_fetch` (fetched by the TEE itself with sealed read-only credentials) |
| `independence` | `issuer`, `issuer_appointed_manager`, `third_party_bank` |
| `freshness_hours`, `carried_forward` | integer, bool |
| `coverage_bps` | share of due items this source has a record for |
| `snapshot_sha256` | hash of the exact bytes the TEE read |
| `method_version` | e.g. `cashflow-v2.0.0` |
| `synthetic` | true for every demo source; the UI shows "synthetic data" whenever it is true |

## 8. Checks receipt

### 8.1 Full receipt (returned by the OutLayer run, stored on NEAR)

Canonical JSON: UTF-8, keys sorted, no floats, integers above 2^53 as decimal strings, no whitespace. Fields:

`receipt_version` ("2"), `method` (`cashflow-v2.1.0`), `token_id`, `kind`, `run_nonce` (from the request), `period`, `as_of` (UTC), `score`, `band`, `raw_x100`, `parts_x100` {cash_match, gap, late, freshness}, `uncapped_score`, `caps` [{code, reason}], `holds` [{code, reason}], `metrics` (section 5 aggregates; cohorts under 5 units suppressed), `checks_run` [check ids], `exceptions` [{code, count}], `missing_evidence` [codes], `passport` [section 7], `evidence_hashes` [{source, sha256}], `code_hash` (the wasm hash the contract requested).

`receipt_hash` = sha256 of the canonical JSON.

### 8.2 How the receipt is produced and bound (owner decision 7 Nov, option b)

1. The receipt contract calls `outlayer.testnet` `request_execution` with argument `source` pinned to one build: `{"WasmHash": {"hash": <sha256>}}`, or a project with a fixed `version_key` (never null or latest). `input_data` = `{"token_id", "run_nonce"}` only. `secrets_ref` points at the sealed read-only bank credentials, stored with `--build <sha256>` so only that build can read them and with the receipt contract as the only reader (`--via`).
2. Inside the TEE the wasm fetches the mock bank-data API and the manager export itself, runs the match and score, and prints the receipt. Private records never appear in `input_data`, the receipt or any log.
3. OutLayer resolves the request on chain; the contract's private callback receives the output, checks `run_nonce`, `token_id` and `method` against its own pending request, then stores the receipt with a per-token sequence number, the hash it pinned in the request, and emits an event.
4. Anyone can fetch the run's public attestation (TDX quote over wasm hash, input hash, output hash) and check that the stored receipt hash matches the attested output.

What this binds: the receipt arrived through OutLayer's on-chain resolve for a request our contract made, for the build our contract pinned in that request. Which code ran is enforced by the request pin and by the secrets build lock (another build cannot read the bank credentials), not by the callback: OutLayer's resolve payload carries `success`, `output`, `error` and `resources_used`, no wasm hash (OutLayer contract docs, read 7 Nov), and a `code_hash` written by the wasm itself proves nothing. So the receipt's `code_hash` field is **informational**; the pinned hash the contract stores is the one that counts, and anyone can check it against the run's public attestation (TDX quote over wasm hash, input hash, output hash). What it trusts: OutLayer's resolve path (its operator posts results; the TDX quote is checked off chain, not by our contract). Disclosed in TRUST_MODEL.

### 8.3 Short receipt (Base Sepolia mirror)

`token_id_hash` (sha256 of token_id), `seq`, `receipt_hash`, `score`, `band`, `method_id_hash`, `as_of_ms`. The NEAR contract builds the EIP-1559 transaction for the fixed mirror address and the single update selector on chain 84532, with a nonce it serializes itself, from a receipt it already stored, and asks `v1.signer-prod.testnet` to sign it. It cannot sign anything else. The mirror contract rejects a `seq` that is not greater than the last one for that token.

Re-sign path: the NEAR contract keeps each mirror request as (nonce, seq, unsigned payload). If a signed transaction never lands on Base Sepolia (dropped, underpriced), `resign_mirror(nonce)` asks the MPC to sign the same payload again for the same nonce, allowing only a higher fee up to a fixed cap; nothing else in the payload can change. Because both versions share the nonce, at most one can land. A new nonce is never issued while an earlier one is unconfirmed, so a stuck nonce is fixed by re-signing it, never skipped. The MPC-derived address pays Base Sepolia gas, so it must hold Base Sepolia ETH (faucet; checked before each mirror run).

## 9. Privacy gates (code-enforced)

- Output is aggregates only. No `unit_ref`, `counterparty_ref`, name or per-unit row leaves the TEE.
- Any cohort or group under 5 units is suppressed (shown as "fewer than 5") in receipts, the API and Q&A.
- Q&A answers only from approved aggregates of stored receipts, with citations to receipt fields. It refuses any question about a borrower's or tenant's identity, any request for row-level data, and any query that would narrow a group below 5 (differencing). At most 20 questions per paid entitlement. Each rule is enforced in code before and after the model call and has a refusal test.
- The public hub shows signed aggregates only. The browser never downloads private fixtures and never computes a score.

## 10. Rounding and parity

- Money: integer cents (i128 in Rust, BigInt in JS where a value can exceed 2^53).
- Rates: integer bps. A ratio a / b in bps = round_half_up(a x 10,000 / b), integer division with the remainder compared to half the divisor; ties round away from zero. b = 0 follows the rule stated for that metric.
- Score parts are computed in hundredths of a point (`x100` integers) with the same rule, summed, then score = round_half_up(raw_x100 / 100).
- PD and LGD are integer bps; TrueVal lines = EAD x (10,000^2 - PD x LGD) / 10,000^2, rounded once per line.
- Parity: every fixture in `spec/v2/fixtures/` runs through the JS reference and the Rust/WASM build; outputs must be byte-identical canonical JSON. CI fails on any difference.

## 11. Threat model update (v2)

| # | Attack | Mitigation |
| --- | --- | --- |
| V1 | Issuer fabricates servicer or manager records | three-way match against bank settlements; `claimed_not_settled` |
| V2 | Owner or sponsor top-ups dressed up as rent or interest | unlinked credits never count as cash received (M5); `distribution_funded_by_sponsor` |
| V3 | Security deposits or loan proceeds counted as income | M5 classification |
| V4 | Recycled, duplicate or reversed payments | M1 dedupe and reversal rules |
| V5 | Stale or carried-forward data hides a decline | freshness and `carried_forward` (5.6) |
| V6 | Accrued or capitalized interest presented as yield | cash yield uses settled interest only (5.2) |
| V7 | Private files leak through public inputs | `input_data` carries only token id and nonce; the TEE fetches data itself |
| V8 | Replay an old receipt or a receipt for another token | contract checks nonce, token, method, code hash; per-token sequence on NEAR and Base |
| V9 | Make the MPC sign an arbitrary payload | the contract builds the only payload it will sign (8.3) |
| V10 | Pay to change a score | payment and scoring are separate contracts; no paid input reaches a run |
| V11 | Re-identify a tenant or borrower through Q&A | section 9 gates; refusal tests |
| V12 | Fake bank feed | demo limit: the mock bank-data API is synthetic and run by us; tier 3 means "fetched by the TEE with sealed credentials", not "a real bank". Disclosed everywhere. |
| V13 | OutLayer operator misreports a result | disclosed trust; per-run attestation lets anyone check output hash against the stored receipt |
| V14 | NEAR AI Cloud shared signing key | the Q&A model's signing key is shared by every user of that model; a Q&A signature proves the model answered, not that TrueNav asked. Disclosed. |

## 12. Demo data (synthetic)

- **Credit fund** (fictional; off-chain payments are vouched for by appointed attesters, and share value includes accrued and capitalized interest): its dashboard reports 11.00% yield; bank settlements support cash yield near 6%; 60+ day cohorts rise across three monthly runs; score drops.
- **Rental token** (fictional; a tokenized property that pays holders monthly): distributions exceed rent collected minus expenses and reserves; a sponsor transfer funds part of a payout; occupancy is high while collection is lower.
- Every edge case of section 4 appears in at least one fixture: partial, batched, reversed, duplicate, deposit not rent, owner top-up, unapplied credit, missing source, carried-forward source.
- Mock bank-data API: synthetic, labeled synthetic everywhere, frozen snapshots for reproducibility. Reproducibility is claimed only against a frozen mock-bank snapshot (owner decision 7 Nov).

## 13. Interfaces (outline, detailed in their build steps)

- Receipt contract (NEAR testnet, fresh account; built in step 4, `receipts/`): admin (1 yocto calls, two-step hand-over), pauser, runners; `register_token`, `set_config` (pinned build, never latest); `request_run(token_id)` payable; private callback `on_run_result` with the receipt whitelist (`receipts/src/validate.rs`); views `get_latest`, `get_receipt`, `get_history(token_id, from_seq, limit)`, `get_token`, `list_tokens`, `get_config`; mirror request (8.3) in step 5.
- Query contract (separate account; `query/`): `buy_query(request_id, query_hash, kind)` payable exactly 0.01 NEAR (any other amount fails and the deposit returns with the failed call), entitlement bound to the query hash, valid 24 h, `report` 1 use, `ask` 20 uses; `redeem` by the API account only; admin-only `withdraw` (never below storage plus a reserve) with an event.
- API (`api/`): `GET /fund/{token}/score` free; `GET /fund/{token}/report` needs an unused `report` entitlement for `sha256("report|" + token)` and spends it; `POST /ask` needs an `ask` entitlement for `sha256("ask|" + token)` (Q&A in step 6); 402 names exactly what to buy; payment never changes a score (the score path never reads the query contract).
- Base Sepolia mirror contract: `update(token_id_hash, seq, receipt_hash, score, band, method_id_hash, as_of_ms)`, callable only by the MPC-derived address, strictly increasing `seq` per token.

## 14. Not claimed

Not an audit, not a credit rating, not fair value. TrueVal is a model estimate on demo, uncalibrated tables. Bank tier 3 in this demo is a synthetic API. TrueNav never holds, moves or controls investment money.
