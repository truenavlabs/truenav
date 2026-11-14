# TrueNav scoring spec: TrueVal, TrueRange and the TrueNav score

Status: revision 3. Every rule below was decided by owner 5 Nov 2026 (panel v4, decisions through 18:31 Bangkok), unless marked "proposed, pending owner".
All funds, loans and numbers are fictional demo data.
The engine in `engine/src/score.mjs` is the single implementation. `spec/nav/check.mjs` imports it and compares its output to `spec/nav/fixtures.json`.

## 1. Names

| Name | What it is | One-line explainer |
| --- | --- | --- |
| TrueNav | The product. | |
| TrueVal | Dollar figure: sum over verified loans of EAD x (1 - PD x LGD). | What the fund's loans are worth after expected losses. Model estimate, not fair value. |
| TrueRange | The range around TrueVal: plus or minus 1.96 x sqrt(sum EAD^2 x LGD^2 x PD x (1 - PD)). | Where TrueVal likely falls, assuming loans default independently. Demo estimate, labeled "demo range (independent defaults)". |
| TrueNav score | 0 to 100 trust score. | How far you can trust the fund's reported NAV, 0 to 100. |

TrueVal is a model estimate, not fair value. TrueRange is a demo range, not a confidence interval.
The engine exports these labels and explainers as `LABELS`, so the UI and docs read from one source.

## 2. Model tables (R3, decided by owner 5 Nov 2026)

PD by days-past-due bucket, labeled "demo, not calibrated":

| Bucket | DPD range (R1) | PD |
| --- | --- | --- |
| current | 0 or less | 2% |
| 1 to 30 | 1 to 30 | 10% |
| 31 to 60 | 31 to 60 | 25% |
| 61 to 90 | 61 to 90 | 45% |
| over 90 | 91 or more | 100% |

LGD by asset type, from the KBRA BBB row, labeled "inference from a corporate stress table; KBRA methodology does not address CRE CLOs" (source not checked here):

| Asset type | LGD |
| --- | --- |
| real_estate (first-lien real estate) | 31% |
| invoices (treated as unsecured) | 67% |

## 3. Inputs

Fund: `fund_id`, `headline_nav` (signed top-line NAV), `cash`, `cash_attested`, `cash_asof`, `liabilities`, `liabilities_attested`, `nav_report_date`, `certificate { signed_at, data_asof, signer, manager_id, history }`, `policy_markdown`, `blocked_attempts [{ action_id, age_days }]`, `loans`.

Timestamps (every `*_asof`, `nav_report_date`, `signed_at`, `data_asof`, `cash_asof`, and `now`): exactly `YYYY-MM-DDTHH:MM:SSZ`, a real UTC calendar date, as `timestamp()` in `engine/v3-core/src/wire.rs` reads it. Offsets, fractional seconds, a missing seconds field, date-only and other formats are an unknown time (data age unknown, cash not attested), never a guess. The JS engine reads them with `parseUtcMs` and does not depend on the process time zone.

Loan: `id`, `asset`, `principal`, `accrued`, `repaid`, `bucket`, `dpd` (optional), `nft`, `nft_id`, `anomaly`, `reported_value` (optional), `servicer_asof`, `obligor_id` (optional).
EAD = principal + accrued - repaid, all Keel Servicing signed. The Keel signed event schema must carry accrued interest per loan. Fixtures carry an explicit `repaid` on every loan (0 when nothing is repaid).
`previously_certified` and `manager_id` are derived, never taken from the fund (R17, R18). A fund-supplied value that disagrees is flagged as a spoof and ignored.

Verifier inputs (passed by the caller, not by the fund):
- `opts.certStore = { [fund_id]: [{ fund_id, signed_at }] }`: the verifier's certificate history. previously_certified is true when this store, unioned with the certificate's own `history`, holds a certificate for this fund_id signed before now. The store counts only as a plain object (prototype Object or null, not an array) whose every own value is an array; otherwise it is ignored. When no valid store is passed the result carries the flag "no cert store: previously_certified not verifiable". The demo and `spec/nav/check.mjs` always pass one (`cert_store` in fixtures.json).
- `opts.attemptLog = { [fund_id]: { [action_id]: { attempting_status, attempting_policy_nav, largest_policy_nav, attempting_open_loans, manager_id } } }`: the verifier's record of each blocked attempt. Shell size at the event comes only from this record. Any `snapshot` in the fund payload is ignored. With no record, the fund's current size is used.

## 4. Rules (each decided by owner 5 Nov 2026)

R1 Loan validation. Bad loan data never throws. An excluded loan counts 0 toward Policy NAV and TrueVal, stays in the listed book at the fund's mark, and carries a reason: "unknown asset", "invalid bucket" (including a finite dpd outside the bucket's range), "incomplete data" (principal, accrued or repaid missing or not a finite number; strings are never coerced; nft held without nft_id), "overpaid, check servicing" (repaid above principal + accrued; the line floors at 0 in the listed book and the 50% test, the raw negative is shown in the walk), "duplicate nft" (R23), "duplicate loan" (same loan_hash listed more than once; first occurrence may verify), "nft_id listed by several funds" (R23 across funds, 6 Nov). A loan with EAD 0 is closed.

R2 A verified loan is open, valid, NFT held, not anomaly-flagged, not a duplicate nft_id and not a duplicate loan_hash. Every other open loan is unverified.

R4 TrueVal and TrueRange as in section 1. Policy NAV = sum of the fund's marks on verified loans, each counted at most at its EAD (RT3-04, both engines: `engine/src/score.mjs` and `outlayer/engine-v3/src/nav.rs`). A mark is `reported_value`, or EAD x (1 - policy markdown) when absent. Marks floor at 0. `tests/fixtures/nav-differential.json` cases D4 check the cap in both engines.

R5 Listed book L = sum of marks on open listed loans. Residual = headline - (L + cash - liabilities). A positive residual is "not listed in book": unverified, and it lowers coverage. A negative residual is the flag "headline below book" with amount and percent, no extra penalty.

R6 Gap (max 40). LIH (loan-implied headline) = headline + liabilities - attested cash only. Over = max(0, LIH - hi). Under = max(0, lo - min(LIH, Policy NAV)). Beyond = max(over, under). Edges count as inside. Points = 40 x max(0, 1 - beyond / (10% x TrueVal)). No verified loans gives 0.

R7 Coverage (max 40) = 40 x min(1, Policy NAV / max(LIH, L)). R7 ships together with R6's attested-only cash rule: without it, invented cash could keep coverage at 40.

R8 Freshness (max 20) = 20 x f(age), f = 1 at 24 h or less, linear to 0 at 168 h. Age is the oldest of every loan's servicer_asof, the NAV report date, the certificate data_asof and, when cash is attested and the attestation is live (168 h or less), cash_asof. An expired claimed cash attestation is unattested cash, stays out of the data age and the stale-certificate rule, and sets freshness to 0 (6 Nov 13:32). A re-signed certificate cannot refresh an old loan tape.

R9 Penalty: 15 x 0.5^(age_days / 30) per distinct attempt, stacking linearly. Delivery retries with the same action_id count once.

R10 Penalty scope. The attempting fund always takes it. The manager's other funds get a 90-day warning flag. The penalty goes manager-wide when the attempting fund is a shell at the event (empty, not_rated, disclaimed, verification_failed, invalid_fund_fields, or Policy NAV under 10% of the manager's largest fund on Policy NAV, sizes from the verifier attempt record when present), when the attempt is the manager's 2nd or later within 90 days, or once any of the manager's scored funds that carries a penalty has its floor bind (raw at or below 0). One action_id listed by several funds of a manager is one attempt at the youngest listed age; every listing fund pays it at that age as its own penalty and is flagged "action_id listed by several funds", and it is manager-wide if any listing fund is a shell (each judged on its own verifier record). A fund with no certificate takes its manager_id from its verifier attempt records. Records naming several managers are flagged "conflicting manager_id in attempt log" and each attempt goes to the manager its own record names; an attempt that cannot be tied to a manager is flagged "attempts not attributable to a manager".

R11 raw = gap + coverage + freshness - penalty. Score = round half up of max(0, raw). Bands on the rounded score: green 85 and up, yellow 60 to 84, red below 60. Raw is shown to 1 decimal.

R12 No green for 30 days after an attempt: the fund that attempted, and any sibling that took the manager-wide penalty, is capped at yellow (number unchanged).

R13 50% test. Unverified value = unverified open loans at max(floored mark, EAD) + "not listed in book" + unattested cash. For an excluded loan whose repaid is missing or non-finite, EAD for this test is principal + accrued. An unverified or excluded line whose principal or accrued is non-finite has unknown exposure, and the fund is disclaimed with reason "unverified line with unknown exposure". Attested cash counts as verified only while cash_asof is 168 h old or less. Share_raw = unverified / max(headline, L50), where L50 is the listed book with each verified loan counted at most its EAD (6 Nov 13:32); share_display = min(1, share_raw). Over 50% is disclaimed; exactly 50% is scored. Over 50% is compared in integer cents.

R14 Status, in order: invalid_fund_fields; verification_failed when previously certified and (no certificate, no headline, or data age over 30 days), or when a certificate is present and the data age is over 30 days or unknown (a missing as-of gives data age null); never certified and (no certificate or no headline) is not_rated; zero open loans is not_rated "no loans in book" at headline 0, disclaimed above 0; share_raw over 50% is disclaimed; otherwise scored. Disclaimed and verification_failed show red with no number and all pillars visible; not_rated shows grey with no number. Sort order: verification_failed and invalid_fund_fields (rank 0), disclaimed, red, yellow, green; not_rated is outside the order. A numeric filter never passes a no-number status.

R15 Concentration is a flag only: largest obligor share and top five share of EAD on open listed loans against 15% and 50% as concentration indicators: flag dependence on a single obligor or a small group; these do not change the score.

R16 The 30 days, 50% and 10% thresholds are TrueNav's own policy, not agency figures.

R17 to R24 Validation: previously_certified from the certificate history (spoof flagged); manager_id from certificate.manager_id or signer (spoof flagged); liabilities finite and 0 or more, else invalid_fund_fields; negative cash is set to 0 and its absolute value added to liabilities, flagged "negative cash treated as liability"; cash_asof required for attested cash and revoked past 168 h; non-finite headline is a missing headline, non-finite cash or liabilities is invalid_fund_fields; zero denominators fail closed (coverage 0; share 0, or +Infinity shown as 100%); duplicate nft_id excluded after the first; duplicate loan_hash excluded after the first; every as-of age is clamped at 0, so a future date contributes age 0.

Changes of 5 Nov 2026 on top of cb688fc, each decided by owner: unknown exposure disclaims (R13); shell size from the verifier record only, invalid_fund_fields is a shell status with rank 0, uncertified funds are tied to a manager through the attempt log, floor bind only on scored funds with a penalty, action_id deduped across the manager (R10); negative cash is a liability (R19, R21); previously_certified needs the verifier store with cutoff now, and a certificate over stale data fails (R14, R17). Changes of 5 Nov 2026 20:10 on top of 84de15b, each decided by owner: shared action_id grouping and multi-manager attempt records (R10); cert store validity (R17); V4 kept scored with freshness 0. Changes of 6 Nov 2026 13:32 on top of db8139f, each decided by owner: an nft_id verified in several funds is verified in none (R23); verified marks capped at EAD in the 50% test (R13); equal-age attempts ranked by age then action_id (R10); expired claimed cash is unattested with freshness 0 (R8, R20); fund_id rename limit documented (TRUST_MODEL). Trust limits are in `engine/TRUST_MODEL.md`.

R25 TEE underwriter verdicts (decided by owner 6 Nov 2026). A NEAR AI Cloud model running in an attested TEE reads each pledged loan's private document, compares it with the fund's claimed loan data, and returns a signed verdict-only reply (pass, or flag with anomaly codes amount_mismatch, asset_mismatch, id_mismatch, injection_attempt, duplicate_document, unreadable). The contract verifies the TEE signature and stores every verdict; the latest one counts. The engine reads the verdicts from the chain as `opts.teeStore` and never calls the TEE itself. A flag makes the loan unverified and excluded ("TEE flag: <codes>"). With no verdict, the loan is pending for 7 days after its on-chain pledge time and unchanged; after that it is unverified and excluded ("TEE check overdue"). A loan with no loan_hash or no store entry is "not checked" and unchanged. With no valid store the fund is flagged "TEE verdicts not checked" and the score is unchanged. Demo: every demo document passes, so the pins hold; a flag on H-RE-01 takes Harbor from 99.17 green to 51.59 red.

## 5. Worked example

Valuation time 10 Nov 2026 12:00 UTC. Headline equals the listed book, cash 0, liabilities 0, previously certified (derived from certificate history). Every Harbor as-of is 30 h old; every Meridian as-of is 48 h old.

### 5.1 Harbor Credit Fund

Policy: 30% markdown at 61 to 90 DPD, 75% over 90. H-IN-04 was repaid on time (352,000, balance 0, NFT burned) and is closed.

| Loan | Asset | EAD | Bucket | Mark | PD x LGD | Expected loss | TrueVal line | Variance term |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H-RE-01 | real_estate | 1,800,000 | current | 1,800,000 | 0.0062 | 11,160 | 1,788,840 | 6.102734e9 |
| H-RE-02 | real_estate | 1,500,000 | current | 1,500,000 | 0.0062 | 9,300 | 1,490,700 | 4.238010e9 |
| H-RE-03 | real_estate | 1,400,000 | current | 1,400,000 | 0.0062 | 8,680 | 1,391,320 | 3.691778e9 |
| H-RE-04 | real_estate | 1,200,000 | current | 1,200,000 | 0.0062 | 7,440 | 1,192,560 | 2.712326e9 |
| H-RE-05 | real_estate | 1,000,000 | 1 to 30 | 1,000,000 | 0.031 | 31,000 | 969,000 | 8.649000e9 |
| H-RE-06 | real_estate | 900,000 | current | 900,000 | 0.0062 | 5,580 | 894,420 | 1.525684e9 |
| H-RE-07 | real_estate | 800,000 | current | 800,000 | 0.0062 | 4,960 | 795,040 | 1.205478e9 |
| H-RE-08 | real_estate | 600,000 | over 90 (120 DPD) | 150,000 | 0.31 | 186,000 | 414,000 | 0 |
| H-IN-01 | invoices | 300,000 | current | 300,000 | 0.0134 | 4,020 | 295,980 | 7.918596e8 |
| H-IN-02 | invoices | 250,000 | current | 250,000 | 0.0134 | 3,350 | 246,650 | 5.499025e8 |
| H-IN-03 | invoices | 200,000 | 1 to 30 | 200,000 | 0.067 | 13,400 | 186,600 | 1.616040e9 |
| H-IN-04 | invoices | 0 | closed | | | | | |

Listed book = Policy NAV = headline = 9,500,000. TrueVal = 9,665,110. Variance sum 3.108283e10, sqrt 176,303.2, TrueRange = 1.96 x 176,303.2 = 345,554, range 9,319,556 to 10,010,664.
At over 90 DPD with PD 100%, H-RE-08 has no variance: the model treats its loss as certain at 31% of EAD (TrueVal line 414,000, against the fund's mark of 150,000).
Gap: LIH 9,500,000 is inside, under is 0 (min(LIH, Policy) = 9,500,000 is above lo). 40 points.
Coverage: 9,500,000 / 9,500,000 = 1. 40 points.
Freshness: 30 h, 1 - 6 / 144 = 0.958333. 19.17 points.
Score: raw 99.17, 99 green. Concentration: largest 18.1%, top five 69.3%, both flagged, no score impact.

### 5.2 Meridian Yield Fund

Policy: 15% markdown over 90 DPD. One blocked attempt 2 days old (Harbor's H-RE-03). M-IN-03 is anomaly-flagged.

| Loan | Asset | EAD | Bucket | Mark | Verified | PD x LGD | TrueVal line | Variance term |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M-RE-01 | real_estate | 1,600,000 | current | 1,600,000 | yes | 0.0062 | 1,590,080 | 4.821914e9 |
| M-RE-02 | real_estate | 1,100,000 | over 90 | 935,000 | yes | 0.31 | 759,000 | 0 |
| M-IN-01 | invoices | 500,000 | 61 to 90 | 500,000 | yes | 0.3015 | 349,250 | 2.777569e10 |
| M-IN-02 | invoices | 400,000 | current | 400,000 | yes | 0.0134 | 394,640 | 1.407750e9 |
| M-IN-03 | invoices | 300,000 | current | 300,000 | no (anomaly) | | | |

Headline = listed book = 3,735,000. Policy NAV = 3,435,000. TrueVal = 3,092,970. Variance sum 3.400535e10, sqrt 184,405.4, TrueRange = 361,435, range 2,731,535 to 3,454,405.
Gap: over = 3,735,000 - 3,454,405 = 280,595; under = 0. Points = 40 x (1 - 280,595 / 309,297) = 3.71.
Coverage: 3,435,000 / 3,735,000 = 0.919679. 36.79 points.
Freshness: 48 h, 1 - 24 / 144 = 0.833333. 16.67 points.
Penalty: 15 x 0.5^(2 / 30) = 14.32.
Score: raw 42.84, 43 red. Without the attempt: raw 57.17, 57 red. Unverified share 300,000 / 3,735,000 = 8.03%. Concentration: largest 41.0%, top five 100%, both flagged.

## 6. Documented edges

X9: headline 51 with one verified line marked 24.99 and 26.01 not listed is 51% unverified and disclaimed. Raising only the fund's mark to 25.50 makes the residual 25.50, exactly 50%, and the fund is scored 40 red. The jump is a property of the 50% line, not tuned.
X10: one loan against 100 notes with the same total EAD gives the single loan a wider TrueRange and so a higher score at the same headline. This follows from the independent-defaults range.
X11: a book marked below TrueRange plus an unverified line can sit inside the range on LIH while Policy NAV is far under it. The max-of-sides gap scores it 73 yellow; an over-only gap would have scored 92 green.

## 7. Roadmap

Next: correlated defaults (Vasicek one-factor Monte Carlo with a published seed in the TEE).
Next: on-chain certificate history for previously_certified.
Next: bind manager_id to the live NEAR registry signer.
Next: liability oracle.

## 8. Reproduce

`npm test` runs the engine tests and `node spec/nav/check.mjs`. No dependencies, Node 18 or later.
