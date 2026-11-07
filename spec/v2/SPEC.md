# TrueNav spec v2: is the yield real?

Status: draft for owner review, 7 Nov 2026 (Bangkok). Replaces the pledge-registry scope (owner reset, 7 Nov). Where this conflicts with `spec/nav/NAV_SPEC.md`, older docs or Notion pages, this file wins. Items marked **[proposed]** wait for an owner decision. All names, funds, properties, borrowers, tenants and numbers are fictional and synthetic.

TrueNav privately checks whether the cash behind a tokenized fund or tokenized rental property is actually coming in. It compares what the issuer says it was paid with cash a bank actually settled, without exposing borrower or tenant files, and publishes a verifiable score and a signed checks receipt. **TrueNav reports and scores only. It never holds, moves or controls investment or fund money.** The only money it receives is small testnet service fees from agents for paid queries.

## 1. Names and tooltips

Tooltip strings are **[proposed]**; the owner approves them before they ship. The engine exports them as one `LABELS` table so the UI, the API and the docs read from one source.

| Name | Definition | Proposed tooltip |
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
| `cashflow-v2.0.0` | This spec: three-way match, cash yield, rental coverage, cohorts, freshness, passport, score. | draft |

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

**M5 Classify unlinked bank credits.** A credit that settles no claim is not rent or interest. It is classified from `kind_hint` as `security_deposit`, `owner_transfer` (issuer or sponsor top-up), `loan_proceeds`, `refund` or `unattributed`, and none of these count as cash received. An owner transfer that funds a distribution is exception `distribution_funded_by_sponsor`.

**M6 Exceptions** (counted, never individually identified in public output): `claimed_not_settled` (the manager says paid, the bank shows no cash), `settled_not_claimed`, `duplicate_claim`, `duplicate_bank_txn`, `probable_reversal`, `batch_mismatch`, `claim_without_due`, `unapplied_credit`, `distribution_funded_by_sponsor`, `stale_source`, `carried_forward`, `missing_source`.

## 5. Metrics

All money is integer cents, all rates integer basis points, rounding per section 10.

### 5.1 Cash received

`cash_received` for a period = settled amounts linked to due items of that period (M3, M4), net of reversals (M1). Unlinked credits (M5) are excluded. `claimed_cash` = sum of non-reversed claims for the period. `cash_match_bps` = cash_received / claimed_cash (10,000 when both are 0).

### 5.2 Credit: reported yield vs cash yield

- `cash_interest` = cash received on `interest` due items for the period.
- `accrued_interest` and `capitalized_interest` (interest added to the loan, PIK) come from the issuer claim and are shown next to cash, never added to it.
- `cash_yield_bps` = cash_interest x (365 / days in period) / average `principal_outstanding` over the period, in bps.
- `yield_gap_bps` = max(0, reported_yield_bps - cash_yield_bps).

### 5.3 Rental: coverage and collection

- `rent_due`, `rent_collected` = due and settled amounts on `rent` items for the period.
- `collection_rate_bps` = rent_collected / rent_due. Occupancy is shown separately and never used in place of collection.
- `net_operating_cash` = rent_collected - expenses - reserves (expenses and reserves from bank debits tagged `expense` where present, else from the issuer claim, flagged `expenses_self_reported`).
- `rental_coverage_bps` = net_operating_cash / distributions_paid (shown as a ratio, 1.00 = 10,000 bps). Below 10,000 is exception `payout_exceeds_net_cash`.

### 5.4 Late-payment cohorts

Per `unit_ref`, days past due = days from the `due_date` of the oldest due item not `paid_full` (by bank-settled cash) to the run's as-of date. Cohorts **[proposed: the usual delinquency convention]**: `current` (0 to 29 days), `30` (30 to 59), `60` (60 to 89), `90+` (90 or more). Each cohort reports count and outstanding cents. Cohorts with fewer than 5 units are suppressed in every public or Q&A output (section 9).

### 5.5 TrueVal and TrueRange (credit)

Reuses the `legacy-nav-v1` loss math with bank-verified days past due: EAD = principal outstanding (including capitalized interest, flagged) + accrued interest not yet settled. PD comes from the v1 day bands (finer than the four reported cohorts), "demo, not calibrated":

| Days past due (bank-verified) | PD |
| --- | --- |
| 0 or less | 2% |
| 1 to 30 | 10% |
| 31 to 60 | 25% |
| 61 to 90 | 45% |
| 91 or more | 100% |

LGD: real-estate-secured 31%, unsecured 67% (v1 inference, labeled as such). TrueVal and TrueRange use the v1 formulas in section 1.

### 5.6 Freshness

Per source, age = run as-of minus the latest record date the source covers. f(age) = 1 at 24 h or less, linear to 0 at 168 h (v1 rule R8). A source is `carried_forward` when its balances or records for the current period are identical to the previous period's, or its as-of is before the period end; its freshness is 0 and exception `carried_forward` is raised. The run's freshness is the minimum over required sources.

## 6. TrueNav score (`cashflow-v2.0.0`) [proposed weights]

| Part | Max | Credit | Rental |
| --- | --- | --- | --- |
| Cash match | 40 | 40 x cash_match_bps / 10,000 | same |
| Yield or payout gap | 25 | 25 x max(0, 1 - yield_gap_bps / 500) | 25 x min(1, rental_coverage_bps / 10,000) |
| Late payments | 15 | 15 x max(0, 1 - (outstanding in 60 and 90+) / (outstanding total x 20%)) | same with rent due |
| Freshness | 20 | 20 x run freshness | same |

`raw` = sum of parts. **Evidence cap**: with no bank-sourced (tier 3) source, the score is capped at 59 (red) and labeled "self-reported only". Score = round half up of raw. Bands as in v1: green 85 and up, yellow 60 to 84, red below 60. A payment for a query never changes any input or output of a run.

Demo targets (fixture design, section 12): the credit fund reports 11.00% and shows cash yield near 6% with rising 60+ cohorts, so the yield-gap part falls to 0 and the score drops into red; the rental token pays out more than net operating cash, so coverage is below 1.00 and the payout part falls.

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

`receipt_version` ("2"), `method` (`cashflow-v2.0.0`), `token_id`, `run_nonce` (from the request), `period`, `as_of_ms`, `score`, `band`, `raw_x100`, `parts_x100` {cash_match, gap, late, freshness}, `capped` (bool), `metrics` (section 5 aggregates; cohorts under 5 units suppressed), `checks_run` [check ids], `exceptions` [{code, count}], `missing_evidence` [codes], `passport` [section 7], `evidence_hashes` [{source, sha256}], `code_hash` (the wasm hash the contract requested).

`receipt_hash` = sha256 of the canonical JSON.

### 8.2 How the receipt is produced and bound (owner decision 7 Nov, option b)

1. The receipt contract calls `outlayer.testnet` `request_execution` with a pinned `code_source` (project version or wasm hash), `input_data` = `{"token_id", "run_nonce"}` only, and a `secrets_ref` to the sealed read-only bank credentials.
2. Inside the TEE the wasm fetches the mock bank-data API and the manager export itself, runs the match and score, and prints the receipt. Private records never appear in `input_data`, the receipt or any log.
3. OutLayer resolves the request on chain; the contract's private callback receives the output, checks `run_nonce`, `token_id`, `method` and that `code_hash` equals the pinned hash, then stores the receipt with a per-token sequence number and emits an event.
4. Anyone can fetch the run's public attestation (TDX quote over wasm hash, input hash, output hash) and check that the stored receipt hash matches the attested output.

What this binds: the receipt arrived through OutLayer's on-chain resolve for a request our contract made, for code our contract pinned. What it trusts: OutLayer's resolve path (its operator posts results; the TDX quote is checked off chain, not by our contract). Disclosed in TRUST_MODEL.

### 8.3 Short receipt (Base Sepolia mirror)

`token_id_hash` (sha256 of token_id), `seq`, `receipt_hash`, `score`, `band`, `method_id_hash`, `as_of_ms`. The NEAR contract builds the EIP-1559 transaction for the fixed mirror address and the single update selector on chain 84532, with a nonce it serializes itself, from a receipt it already stored, and asks `v1.signer-prod.testnet` to sign it. It cannot sign anything else. The mirror contract rejects a `seq` that is not greater than the last one for that token.

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

- **Credit fund** (fictional, modeled on specialty-credit vaults where attesters vouch for off-chain payments and share value includes accrued and added-on interest): its dashboard reports 11.00% yield; bank settlements support cash yield near 6%; 60+ day cohorts rise across three monthly runs; score drops.
- **Rental token** (fictional, modeled on monthly-payout tokenized property): distributions exceed rent collected minus expenses and reserves; a sponsor transfer funds part of a payout; occupancy is high while collection is lower.
- Every edge case of section 4 appears in at least one fixture: partial, batched, reversed, duplicate, deposit not rent, owner top-up, unapplied credit, missing source, carried-forward source.
- Mock bank-data API: synthetic, labeled synthetic everywhere, frozen snapshots for reproducibility. Reproducibility is claimed only against a frozen mock-bank snapshot (owner decision 7 Nov).

## 13. Interfaces (outline, detailed in their build steps)

- Receipt contract (NEAR testnet, fresh account): roles and pause from the v1 contract; `request_run(token_id)`; private OutLayer callback; `get_latest(token_id)`, `get_history(token_id, from, limit)`; mirror request (8.3).
- Query contract (separate account): `buy_query(request_id, query_hash)` payable 0.01 NEAR, one-use entitlement valid 24 h; refunds wrong amounts; admin-only `withdraw` with an event.
- API: `GET /fund/{token}/score` free; `GET /fund/{token}/report` and `POST /ask` require an unused entitlement; payment never changes a score.
- Base Sepolia mirror contract: `update(token_id_hash, seq, receipt_hash, score, band, method_id_hash, as_of_ms)`, callable only by the MPC-derived address, strictly increasing `seq` per token.

## 14. Not claimed

Not an audit, not a credit rating, not fair value. TrueVal is a model estimate on demo, uncalibrated tables. Bank tier 3 in this demo is a synthetic API. TrueNav never holds, moves or controls investment money.
