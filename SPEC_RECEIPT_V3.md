# TrueNav receipt v3 specification

Status: FROZEN v3.0.0-rc3, pending the owner's final read (9 Nov 2026 Bangkok).
The owner's 9 Nov rc3 review: whole public score, private committed precision fields, known-answer vectors and benchmark cohorts.
The owner's 9 Nov disclosure decision accepts the all-public-field measured bounds below. Status: FROZEN v3.0.0-rc3,
pending the owner's final read. No disclosure field was removed or weakened to obtain a passing guard.

Design only, the owner decisions of 9 Nov 2026 Bangkok. No engine deployment or transaction is authorized by
this document. Schema and interface tests are local artifacts only. Option A is LOCKED: one combined receipt per credit fund per reporting period on receipts.
Corrections append a sequence referencing the superseded entry; old entries remain immutable. Credit is the main
demo. Rental and DEMO datasets remain regression fixtures through their existing methods, not v3 validation.

## 1. Locked method and encoding

method_version = truenav-v3.0.0. Keep the existing NAV method's 40 coverage / 40 NAV gap / 20 freshness points,
including its existing penalty, eligibility and no-number status rules. Coverage means R7 verified VALUE, not the
loan-count registry-read coverage metric. Rename the former pledge_coverage score part to coverage. Spec source: spec/nav/NAV_SPEC.md R6-R14.
Cashflow-v2.1.0 contributes red-flag caps only: any applicable cap restricts the final score to at most 59.00.
It adds no fourth weight and cannot raise a score. Use exact internal inputs for policy comparisons, never public
rounded values. Retain its current cap triggers and closed codes, including the strict collection threshold.
Private benchmark precision 99.17 green for Harbor and 42.84 red for Meridian must reproduce from their
original inputs and pinned valuation time; public scores are 99 and 43.
Their combined benchmark cash fixtures must avoid adding a cap absent from the benchmark scenario; test new capped
variants separately. No retuning or hardcoded score override. Judge valuation_time: 2026-11-10T12:00:00Z as in the
existing NAV benchmark; distinguish replay time from actual issued_at. Synthetic=true is mandatory for this demo.

Use UTF-8 canonical JSON (RFC 8785), integer bps/x100 and canonical decimal strings for cents/large integers.
Dates are real Gregorian UTC dates, ISO 8601 seconds with Z, no ambiguous local times. Unknown is explicit null
plus an enum/status, never zero. Reject unknown keys, duplicate JSON keys, non-finite numbers, overflows and ext
entries. Bounds, size limits, enum lists and golden serialization vectors are part of the frozen method spec.
P = public on chain, callback, event, HTTP feed and Base-verifiable record; H = hidden in the private full report;
Hidden means absent from public JSON, not merely a null field beside a leaked metric.

## 2. Identity fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| receipt_version | string "3" | P, exact | Schema dispatch |
| method_version | string "truenav-v3.0.0" | P, exact | Assessment rules |
| method_spec_sha256 | hex32 | P, hash of canonical frozen rules artifact | Version alone is insufficient |
| token_id | bounded opaque string | P, allowlisted stable identity | Fund lookup |
| fund_account | NEAR account ID | P, contract-bound token registration | Prevent identity substitution |
| kind | enum | P, credit accepted; real_estate and treasury reserved and REJECTED | Explicit asset policy |
| period_start / period_end | UTC date strings | P, start inclusive/end exclusive | Scope and comparison |
| network / receipts_contract / currency | fixed strings near_testnet / receipts.tnlab-718ca9.testnet / USD (the receipts account of the earlier instance, frozen in this spec version; the live registry registry.tnlab-368aa2.testnet has no receipts contract) | P, part of every hash and signature context | Prevent cross-network/contract/unit substitution |
| seq | u64 decimal string | P, contract-assigned strictly increasing per token | History order |
| prev_receipt_sha256 | hex32 or null | P, prior stored record hash, null only with no v2 or v3 history | Bind history |
| supersedes_seq | u64 string or null | P, earlier sequence of same token/period only | Corrections |
| correction_reason_code | closed enum or null | P, source_correction / calculation_correction / coverage_correction; paired with supersedes_seq | No free-text leakage |
| issued_at | UTC timestamp | P, contract acceptance time | Cannot refresh source age |
| data_as_of | UTC timestamp | P, oldest relevant required source time | Real freshness |
| valuation_time | UTC timestamp | P, pinned in judge replay; explicit in normal runs | Reproducible valuation |
| request_id | opaque bounded string | P, contract request identity | Execution linkage |
| request_nonce | hex32 | P, contract-generated unique request context | Replay protection |
| synthetic | boolean true | P, must be true | No real-party implications |

A normal period has one accepted assessment; subsequent assessments of that period are explicit corrections.
New periods extend the same per-token history. Contract request context reserves expected next seq and previous
hash, permits only one pending request per token, and verifies callback context. Actual acceptance adds issued_at;
callers cannot choose seq/head/time. A correction based on an obsolete head must be rejected and re-requested.

## 3. TEE binding and commitments

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| engine_version_key / engine_code_sha256 | bounded key / hex32 | P, required pinned build mapping | Match executed code |
| input_sha256 | hex32 | P, salted aggregate input commitment, not a bare NAV document digest | Bind inputs without dictionary search |
| receipt_sha256 | hex32 | P, contract-computed final public record digest as defined below | Authoritative citation |
| attestation_ref | bounded content-addressed reference | P, public redacted execution evidence only | Independent verification |
| attestation_status | enum verified / unavailable / invalid | Reader-derived, OUTSIDE receipt and receipt hash | Never hash an observer verdict |
| source_key_ids | array of {source, key_id, sig_ok} | P, source is servicer / bank / fund_admin / custodian; sig_ok boolean | Signature provenance without private documents |
| commitments.tape / cash / nav_report / pledge_detail / registry_state_root / full_report | hex32 each | P, independently domain-separated salted commitments | Bind hidden evidence |
| certificate_salt | 32 random bytes | H, cryptographic TEE entropy; fresh per run/correction | Prevent guessing and cross-run linkability |
| private_registry_state_root | hex32 | H, canonical pinned-block roster/read manifest root | Publishing the bare root can expose a small roster |

Define H(label, value) = SHA256(length-prefixed encoding of "truenav-v3", label, request_nonce, certificate_salt,
canonical(value)). Publish H for each commitment. registry_state_root commits to the private root with its block
reference; it is not misrepresented as a NEAR consensus state root or a Merkle proof. input_sha256 = H("inputs",
canonical input manifest). Record units/field schema in every committed object. Randomness is never derived from
public data. Unit tests may inject synthetic entropy in memory, but no production salt is exported in public receipt/proof
fixtures. Section 13 permits explicit all-zero TEST-only known-answer entropy. Salt and exact values are released only within the buyer's private full report.

No self-reference: the TEE execution body B excludes receipt_sha256, attestation_ref and issued_at. It INCLUDES
the reserved next seq and prev hash from the contract request. The attestation binds canonical B. Acceptance
verifies this context, attaches attestation_ref and issued_at, then hashes canonical envelope E excluding
receipt_sha256. attestation_status is NOT in B or E: readers compute it and return it only in an outer verification
wrapper. It cannot alter receipt identity. The schema rejects it inside an envelope. E's only omitted envelope
field is receipt_sha256 itself. Evidence reference may be null for a local golden/replay case, yielding unavailable,
never verified. No claim of on-chain hardware quote validation. Legacy v2 hashing remains unchanged.

First v3 sequence is latest v2 seq + 1, with prev_receipt_sha256 equal to the authoritative latest v2 callback-byte
hash, even though v3 uses a different preimage. With no earlier receipt: seq="1", prev=null. Never reset per-token
history on upgrade. History identifies each version; verifier dispatches v2/v3 appropriately. get_latest_receipt
returns the highest accepted seq, INCLUDING a correction of an older period; get_receipt_history remains append
order. A period-specific current assessment follows explicit supersession links, not wall-clock sorting. Corrections
must reference the current unsuperseded head for their period; no cycle/cross-token/cross-period supersession.

### Exact source signature interface

Signature algorithm: Ed25519, signing the 32 digest bytes SHA256(P), NOT their hex text. Public-key encoding is
ed25519: followed by 64 lowercase hex characters (raw 32 bytes); signature transport is 128 lowercase hex characters.
P = LP(UTF8("truenav-src-v1")) || LP(UTF8(source)) || LP(UTF8(key_id)) || LP(JCS(scope)) || LP(JCS(period)) ||
LP(UTF8(revision)) || LP(UTF8(data_as_of)) || LP(raw_payload_sha256_bytes).
LP(b) = u32 big-endian byte length || b. Empty text is not a null value. payload_sha256 = SHA256(JCS(payload)).
scope is exactly {network,receipts_contract,fund_account,token_id}; period is exactly {period_start,period_end}.
revision is a positive u64 canonical decimal string. UTF-8, JCS, date validity and no duplicate-key checks happen
before signature verification. Digest bytes are 32 bytes; public JSON transports them as lowercase hex.
key_id grammar: ^(servicer|bank|fund_admin|custodian):[a-z0-9][a-z0-9_-]{0,31}:v[1-9][0-9]{0,8}$.

Public registry JSON: {registry_version:"truenav-src-v1", keys:[{key_id,role,fund_scope:[token_id,...],
public_key:"ed25519:<64 lowercase hex>",valid_from:<UTC>,valid_until:<UTC>,revoked:false}]}.
See schema/source-key-registry.schema.json. No wildcard fund scopes. IDs unique, key role matches key_id prefix,
valid_from <= data_as_of < valid_until and key unrevoked at the pinned registry version. Fund, period, revision,
network and contract must match the request. Backend TEE reads a trusted pinned public registry, not an issuer
replacement. Signature acceptance does not prove source truth or completeness. Four source roles are required.
Any sig_ok=false -> status=verification_failed, score=null, band=red; private raw_score=null and hold
source_signature_invalid; do not run normal scoring on rejected payloads. Invalid/unavailable/revoked/expired keys
use the corresponding closed hold, also verification_failed; never downgrade them to an apparently successful run.

### Exact H interface

H(label,value) = SHA256(LP(UTF8("truenav-v3")) || LP(UTF8(label)) || LP(raw_request_nonce_32) ||
LP(raw_certificate_salt_32) || LP(UTF8(JCS(value)))). All LP lengths are u32 big-endian BYTE counts, no terminators.
Nonce/salt are raw bytes, not hex strings. Canonical null is the four UTF-8 bytes 6e756c6c; never an absent field,
empty bytes or the JSON string "null". Reject labels outside: inputs, tape, cash, nav_report, pledge_detail,
registry_state_root, full_report, nav_exact:reported_nav, nav_exact:trueval, nav_exact:truerange_low,
nav_exact:truerange_high, score_exact:score_x100, score_exact:parts_x100, score_exact:raw_score. Exact NAV value object is {currency:"USD",cents:<canonical integer-cent string>} or null.
All other values use the versioned canonical source/report objects. Domain separation uses these literal labels.
The salt and exact values occur only in the private full report, never production public vectors or proof exports; section 13 defines the TEST-only exception.

## 4. Pledge fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| pledge_scope | {registry_account, block_height, block_hash, scope_id, coverage_status} | P, finalized read references; private roster stays H | State the guarantee boundary |
| fingerprint_scheme | string "loan-terms-v2" | P, exact version | Identity semantics changed |
| pledge_result | enum clear / conflict / incomplete / unknown | P, clear only with all required checks | No missing-data pass |
| pledge_coverage_bps | u16 0..10000 or null | P, completed-read count / in-scope open-loan count; floor to 100 bps, or 2500 in small bands | Locked conservative coverage |
| loans_checked | closed count-band enum | P, tokens zero / lt_5 / from_5_to_9 / from_10_to_19 / from_20_to_49 / gte_50 / unknown / suppressed | Avoid exposing small roster size |
| blocked_attempts | enum zero / one / two_plus / unknown | P, UI 0 / 1 / 2+; fixed window below | Locked disclosure |
| lien_rank | positive integer per position | H, signed grant | Legitimate liens without position disclosure |
| lien_support | enum first_lien_only | P, rank >=2 is unknown in rc3 | No unsupported lien assurance |
| pledge details / fingerprint list / holder identities | typed private records | H, no raw loan IDs or per-loan fingerprints in receipt | Registry itself remains publicly observable |

### Renamed-document bypass: LOCKED FIX NOW

Pledge identity excludes filename, upload URL and document identifier. Verify the servicer signature FIRST over a
versioned canonical terms object: authority namespaces, borrower_id, origination_date, principal_cents,
currency, collateral_ref. The loan terms digest is SHA256(domain-separated canonical object). Inside OutLayer,
use the existing common-scope secret fingerprint derivation over that digest; raw terms/digest never go on chain.
All participating funds use the same servicer namespace and common fingerprint scope, not per-fund keys.

Normalization is deterministic and signed as part of loan-terms-v2:
- Borrower/collateral identifiers: authority-issued stable IDs, UTF-8 NFC, strip leading/trailing ASCII spaces,
  collapse internal ASCII whitespace to one space. Reject control/zero-width characters. ASCII letters become
  uppercase only in the explicitly case-insensitive authority namespace. Case-sensitive namespaces preserve case.
  No fuzzy name/address matching or merging borrower display names. Namespace is included in the signature/hash.
- Origination: YYYY-MM-DD Gregorian date, valid civil date, no time zone conversion or inferred date.
- Principal: currency with two decimal places for this demo, decimal string to exact cents; round half up from
  documented higher precision BEFORE signing, disclose the canonical value to signer; reject exponents, negatives,
  overflow and ambiguous separators. Canonical principal is an integer-cent string. Never round to $10k for identity.
- Currency: uppercase ISO-style allowlisted code, USD for demo. Collateral namespace rules match borrower rules.
- Amendments: signed lineage links old identity to replacement, migrate/release under authorization. Resubmission
  under a new principal/date must not silently create a clean history. Keep a collateral index to detect related
  claims even when different loan terms legitimately have different principal amounts.

Second lien LOCKED rc3 policy: lien_rank >=2 -> pledge_result=unknown, hold=second_lien_unsupported; the
loan is unverified for R7/R13. Never flag it as a proven double pledge merely for having rank 2, and never clear
it as a supported second lien. Record rank and signed terms privately. Rank 1 conflicts remain conflicts. Ranked
registry locks and their migration are follow-up work outside this spec.
A conflicted OR unread loan becomes unverified and flows through R7 verified-value coverage and R13 exposure
eligibility. Completed read does not mean verified ownership: a completed read showing a conflict still counts in
read coverage. Result priority: known conflict first; otherwise unsupported rank => unknown; otherwise incomplete
reads => incomplete; otherwise clear only with supported first liens and matching ownership.

A refused pledge ATTEMPT is not an active lien or a conflict in the fund's current book. If the fund tried to
pledge another holder's loan, the registry refused it, and that loan is absent from its current authenticated book,
pledge_result is clear when all current first-lien positions read clean. blocked_attempts/penalty/R12 still apply.
Only current in-scope ownership mismatches yield conflict. Meridian golden is clear with one refused attempt,
its unchanged penalty and red score; its pre-existing valuation/anomaly exclusions still flow through R7/R13.

Read coverage: N = distinct in-scope OPEN loans in the authenticated roster, C = those with a completed finalized
registry read, including successful null/conflict results; timeouts/unread are not C. 0 <= C <= N <=10000. Denominator
unknown or N=0 => coverage=null, never 10000. loans_checked bands C. For lt_5 or from_5_to_9, q=2500; otherwise q=100.
pledge_coverage_bps = q * floor(10000*C/(N*q)), using integers, never rounding before flooring. Exactly complete
reads yield 10000; partial coverage cannot round up to 10000. Unknown/suppressed count follows the conservative
small-band q=2500. Backend CI enumerates every N=1..10000 and C=1..min(N,9), groups public (band,coverage) pairs,
and requires >=2 possible C for every lt_5 pair. This specifically protects positive completed counts 1..4;
zero is intentionally public. Test residual unread-count and temporal inference in the broader leak matrix.
See schema/vectors/coverage-enumeration.json for expected candidate sets, not a disclosure of any actual roster.

blocked_attempts window = unique refused pledge action_id events for this fund in [period_start 00:00:00Z,
valuation_time], both inclusive, evaluated at the pinned registry block. Include later events in the next run,
not historical backfills of this cutoff. Display zero/one/two_plus; unknown when pagination/coverage unavailable.
This period-to-valuation window is separate from R9/R10's penalty history/decay and R12's 30-day hold. No attempt
outside the display window is silently removed from scoring. Changing period window cannot reset penalties.

Registry rank/lineage implementation and migration are excluded from this spec.
Use minimal owned tests for renamed-file, forged terms, amendment and lien input validation; external scenarios
exercise same-rank refusal and rank >=2 unknown behavior against the registry. Source authenticity/canonical identifiers remain trust
assumptions; identity scope is the participating registry, not a global legal lien search.

## 5. NAV fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| reported_nav / trueval / truerange_low / truerange_high | rounded integer-cent decimal strings or null | P, round each to max($10,000, 0.1% of its absolute value); exact values H | Locked rounded NAV projection |
| exact.reported_nav / trueval / truerange_low / truerange_high | exact integer-cent decimal strings or null | H, never in public payloads; signed bounds allowed | Authoritative private arithmetic |
| commitments.reported_nav / trueval / truerange_low / truerange_high | hex32 each | P, separately domain-separated commitment to each exact value | Bind all four exact figures |
| nav_result | enum inside / outside_low / outside_high / outside_both / unknown | P, compare exact inputs; endpoints inclusive | Useful assessment without endpoints |
| nav_gap_band | enum inside / gt_0_lte_5pct / gt_5_lte_10pct / gt_10pct / unknown | P, outside gap as fraction of exact TrueVal; zero TrueVal => unknown | Coarse explanation |
| unverified_share_band | enum zero / gt_0_lte_10pct / gt_10_lte_25pct / gt_25_lte_50pct / gt_50pct / unknown | P, exact internal R13 test before bucketing | Eligibility explanation |

LOCKED fixed ladder: let x be exact signed integer cents. Find the smallest dollar step in {1,2,5}*10^k,
k>=0, such that step_cents>=1,000,000 AND 1000*step_cents>=abs(x). Then let n=floor((2*abs(x)+step_cents)/
(2*step_cents)); rounded=sign(x)*n*step_cents. Integer math, half ties away from zero. Do NOT use a step that moves
continuously with x. Apply independently to all four figures; zero maps to zero, unknown to null. Never publish
step residuals or exact values. See schema/vectors/nav-rounding.json for positive/negative/boundary/tie vectors.
Public range endpoints are rounded displays, not inputs to the decision. Publish four separate H commitments,
with labels nav_exact:<field>, to the exact private values and keep the fresh 32-byte TEE salt private.

reported_nav = signed fund headline_nav, not Policy NAV. R6 decision uses LIH=headline+liabilities-attested_cash,
over=max(0,LIH-exact_high), under=max(0,exact_low-min(LIH,Policy_NAV)), beyond=max(over,under).
inside iff over=under=0; outside_high iff over>0,under=0; outside_low iff under>0,over=0; outside_both iff both>0.
Unknown if required facts unavailable or no verified loans. nav_gap_band measures beyond/TrueVal, not a gap to a
rounded endpoint. If TrueVal<=0 and beyond>0 the gap band is unknown. All band interval ends are explicit in the
schema's x-band-intervals and method artifact; exactly 5% is gt_0_lte_5pct, exactly 10% gt_5_lte_10pct. R13 uses
UNCLIPPED unverified share for eligibility; exactly 50% is gt_25_lte_50pct and still eligible, >50% is disclaimed.
The TrueRange midpoint (low+high)/2, range width and symmetry against TrueVal are part of the leak matrix.

## 6. Cash fields

Operator-containing band labels in this table are DISPLAY ONLY. Exact snake_case wire tokens and interval ends
are authoritative in schema/receipt-v3.schema.json. The same display-only convention applies to freshness_band
and the point-threshold tables; no operator strings are serialized.

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| cash_evidence_status | enum verified / partial / stale / missing / invalid | P, source and settlement coverage rules | Evidence quality |
| cash_match_band | enum <90pct / 90-<98pct / 98-100pct / unknown | P, compute on exact amounts | Reconciliation without totals |
| yield_gap_band | enum <0pp / 0-<3pp / >=3pp / unknown | P, preserve >=3pp cap boundary | No exact yield disclosure |
| collection_rate_band | enum <90pct / >=90pct / pending / no_dues / unknown | P, compare exact integers at cutoff | No rounded pass below threshold |
| late_share_band | enum 0 / >0-10pct / >10-25pct / >25pct / unknown | P, no late_share_bps or exposure denominator | Prevent algebraic reconstruction |
| late_loan_cohorts | closed keys for 1-30 / 31-60 / 61-90 / 90+ DPD, values count or suppression marker | P, counts >=5 only, <5 marker for 1..4; see suppression below | Loan counts, never dollar sums |
| exceptions | array of {code, band} | P, closed codes and none / low / material / unknown bands | No arbitrary text or quantities |
| cash totals, exposure denominators, exact ratios, per-loan rows | typed private fields | H, never in public passport, logs or proof export | Preserve underlying privacy |

Remove claimed_not_settled_cents from public schema completely, including nested exceptions and legacy metrics
spreads. It remains an internal cap input. No dollar amounts anywhere in cash output. Pending collection is not a
pass. Exception bands use fixed documented per-code policy, not issuer-selected thresholds; cap applicability is
computed from exact inputs independently of the displayed band.

Exception-array omission makes no zero assertion. Only an explicit code with band=none asserts a verified
absence/zero; low/material/unknown carry their defined per-code meaning. An empty array is not a public exhaustive
ledger of every nonzero private exception. The guard combines explicit exception entries with cash bands/caps.

Primary suppression: hide positive counts 1..4 as <5. Complementary suppression: if totals, other cohorts or
coverage fields would solve a suppressed cell, suppress another cell with a generic suppressed marker (not <5)
and/or suppress the total. Do not suppress a large cell as <5. Evaluate all public fields jointly, including
loans_checked, overlapping cohorts and prior receipts. Bucket additional visible counts if needed. Zero is public
only when it cannot expose a hidden complement. Suppression applies to derived HTTP/network outputs too.

## 7. Score and extension fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| status | enum scored / disclaimed / verification_failed / invalid_fund_fields / not_rated | P, preserve legacy eligibility order and no-number rules | Explicit score availability |
| score | u8 0..100 or null | P, round_half_up of unrounded final | Legacy public pins 99 and 43 |
| score_x100 | u16 0..10000 or null | H, round_half_up(final*100) | Private pins 9917 and 4284 |
| band | enum green / yellow / red / grey | P, existing legacy whole-score rounding then 85/60 thresholds; R12 yellow ceiling | Preserve old boundary semantics |
| parts_x100 | {gap,coverage,freshness,penalty} integers or null | H, separately round_half_up(part*100) | Private score decomposition |
| raw_score | canonical decimal string or null | H always, unrounded total | No public raw decomposition |
| commitments.score_x100 / parts_x100 / raw_score | hex32 each | P, H with score_exact:<field> labels | Bind private score values |
| parts_band | {coverage, nav_gap, freshness, penalty} | P, exactly four required enum fields; no additional keys | Coarse explanation of each existing score part |
| parts_band.coverage / nav_gap / freshness / penalty | enum high / medium / low / none / unknown | P, thresholds below, using exact internal values | Explain contributions and penalty without publishing exact parts |
| caps / holds | arrays of closed code strings | P, no interpolated money/ratios/loan IDs | Explain constraints without bypassing suppression |
| freshness_band | enum <=24h / >24-72h / >72-168h / >168h / unknown | P, based on oldest required source | Honest age; issued_at cannot refresh inputs |
| ext | object {} | P, MUST be empty; unknown extension keys rejected | Prevent disclosure through arbitrary metadata |

LOCKED scoring formula, unchanged internal precision:
raw = gap + coverage + freshness - penalty;
cap = 59.00 if any cash cap applies, otherwise 100.00;
final = min(cap, max(0, raw));
score = round_half_up(final), PUBLIC;
score_x100 = round_half_up(final*100), PRIVATE;
parts_x100.<part> = round_half_up(part*100), PRIVATE, never summed to calculate the final score.
raw_score is PRIVATE regardless of whether another public field could constrain it. Commit to each of these three
private fields with H("score_exact:score_x100", integer_or_null), H("score_exact:parts_x100", canonical_parts_object)
and H("score_exact:raw_score", canonical_decimal_string_or_null). Fresh production salt stays in the full report.

Band thresholds are 85/60 on public whole score. R12 recent_pledge_attempt caps the BAND at yellow for 30 days
without changing the number. Concentration flags remain non-capping holds. Cash caps remain <=59, no fourth weight.
collection_pending/not_applicable limit band to yellow. R15 largest obligor >15% / top five >50% are flags only.
Public pins: Harbor 99 green, Meridian 43 red. Private report pins: 9917/4284, independently computed from the
unrounded final in receipt:v3:pins and npm run judge -- --replay. Keep original benchmark as-of.
Nonnumeric statuses have score=null, band per R14; source rejection nulls private precision fields and uses unknown
parts_band. Missing values are not zero. No public score_x100, parts_x100 or raw_score keys are accepted.

Residual disclosure is MEASURED PER PUBLIC VECTOR, not a universal half-point rule. The observer takes the
ENTIRE public envelope, including unverified_share_band, rounded valuation cells, cash/exception/cohort bands,
counts, caps/holds, timestamps, method identity and provenance. It never reads private report/test sidecars or
expected bounds. Salted commitments are opaque under the stated cryptographic assumption; they are not extra
amount measurements. Non-null external evidence must be supplied to an expanded observer, never silently ignored.

The owner accepts: when unverified_share_band=zero, R7 coverage=40 exactly for these positive-coverage scored vectors.
R13 zero implies no unverified value/not-listed balance/unattested cash; Policy NAV=L and LIH<=L, giving R7=40.
The degenerate zero-denominator case is not assumed fully verified: score/positive parts-band excludes it here.
This intended fully-verified signal also reveals derived raw/precision fields when the other parts are fixed;
storing them privately does not claim to hide those mathematical consequences. Monetary values remain protected
at their public rounding/band resolution.

| Public vector / observation | Accepted coverage interval, points of 40 | Width | Verified-value share |
| --- | --- | --- | --- |
| Harbor | [40,40] | 0 | 100% exactly, intended |
| Meridian | (approximately 35.9603088738611,40] | approximately 4.0396911261389 | (approximately 89.9007721846527%,100%] |
| Harbor correction | [40,40] | 0 | 100% exactly, intended |
| Harbor capped | [40,40] | 0 | 100% exactly, intended |
| Harbor plus its correction | [40,40] | 0 | No additional narrowing |
| Separate loan-turns-unverified TEST pair, before | [37.733333333333...,38.333333333333...) | 0.6 | [94.333333333333...%,95.833333333333...%) |
| Same TEST pair, after known 0.4-point loss | [37.333333333333...,37.933333333333...) | 0.6 | [93.333333333333...%,94.833333333333...%) |

The loan-change pair is a minimal SIM-DISCLOSURE observer fixture, not a replacement Harbor benchmark tape. It
uses a wider NAV range in which both inside results are feasible. Its 1%-of-book loan loss is explicit attacker
prior knowledge, not an amount learned from the receipt. The four original golden benchmarks retain their clocks.

Meridian is NOT assessed with the old score-only [34,40] range. R6 outside_high, rounded TrueVal/high/headline,
R7 verified value, R13 <=10% exposure, the whole score and parts bands jointly tighten it. Let T=max(LIH,L), P be
Policy NAV, U the R13 numerator and D its denominator. T-P<=U and D<=max(headline,T), so coverage >=
40*(1-u*max(headline/T,1)). R6 gives LIH=high+TrueVal*(40-gap)/400. Projecting these constraints with the score
bin/penalty band gives the documented Meridian lower endpoint. The observer also projects gap, freshness, penalty,
raw_score and private precision ranges; all measured bounds are frozen in schema/vectors/disclosure-bounds.json.

Other hidden quantities have NO additional accepted precision loss:

| Monetary quantity | Harbor, correction and capped cells, USD | Meridian cells, USD |
| --- | --- | --- |
| Exact reported NAV | [9,495,000,9,505,000) | [3,735,000,3,745,000) |
| Exact TrueVal | [9,665,000,9,675,000) | [3,085,000,3,095,000) |
| Exact TrueRange low | [9,315,000,9,325,000) | [2,725,000,2,735,000) |
| Exact TrueRange high | [10,010,000,10,030,000) | [3,445,000,3,455,000) |

These are the inverse fixed-ladder cells, including the step-selection rule, not a guessed symmetric cell around
the displayed value. TrueRange midpoint/symmetry must not narrow them. Cash ratios stay at their public bands;
absolute cash totals have no public dollar denominator and remain scale-free. Original loan principal has no
public amount; outstanding EAD has only a broad valuation-derived ceiling, with no precision finer than the
minimum public valuation step ($10,000). No identifiable per-loan amount is published. A previously known loan
amount in a TEST attack is prior knowledge, not a new receipt disclosure.

General guard rule: compute the tightest intervals implied by the frozen public-observer constraints for EACH
hidden quantity and compare against its documented bound. FAIL if any interval is narrower, including tightened
endpoints, single/consecutive observations, cash bands, NAV cells or loan amounts. Monetary floors remain at
public rounding/band resolution; the score disclosure acceptance does not waive them. Frozen expected bounds
are review artifacts, never regenerated in CI. Numerical tolerance is 1e-12 for legacy arithmetic (far below cent/score precision).
This is a reproducible inference regression model, not a proof against arbitrary external confidential knowledge;
new fields/unsupported proof payloads must fail closed and expand the model under review.

### Public score-part bands

These are public coarse classifications, not a fourth score weight, a new penalty or a change to caps. Compute
them from the exact internal pre-cap contribution points and the total applicable penalty after existing
manager/attempt scope rules, before flooring the final score. Do not derive them from the rounded public score.
Each contribution is bounded by its existing maximum: coverage 40, nav_gap 40, freshness 20 points.

| Field | none | low | medium | high | unknown |
| --- | --- | --- | --- | --- | --- |
| parts_band.coverage | p = 0 | 0 < p < 20 | 20 <= p < 34 | 34 <= p <= 40 | Required input/part unavailable or invalid |
| parts_band.nav_gap | p = 0 | 0 < p < 20 | 20 <= p < 34 | 34 <= p <= 40 | Required input/part unavailable or invalid |
| parts_band.freshness | p = 0 | 0 < p < 10 | 10 <= p < 17 | 17 <= p <= 20 | Required input/part unavailable or invalid |
| parts_band.penalty | d = 0 | 0 < d < 5 | 5 <= d < 15 | d >= 15 | Required penalty evidence unavailable or invalid |

For contributions, 50% and 85% of the available points separate weak, partial and strong contributions while
retaining broad intervals. They are explanatory thresholds, not claims that one strong part makes a fund safe.
For penalties, 15 points is the existing initial cost of one distinct attempt; 5 points distinguishes smaller
deductions from a material fraction of that cost. High penalty means MORE deduction and is adverse; high
coverage/nav_gap/freshness means MORE positive contribution. Clients must preserve that direction.
none means a verified exact zero, never missing evidence. unknown is not converted to none or a numeric score.
Do not clamp invalid/out-of-range parts into a valid band. Compare exact fixed-point/rational values at each
boundary, not rounded display numbers. score_x100, parts_x100 and raw_score remain private even when a cap binds; public parts_band remains.
Regenerate method_spec_sha256 for this amended canonical rules artifact; do not reuse the prior rules hash.

## 8. Market-data interfaces and track record

SourceAdapter.read(scope, period, revision) returns canonical payload, schema_version, source, key_id, data_as_of,
coverage manifest and signature. Four slots: servicer (terms/claims), bank (settlements), fund_admin (NAV), custodian
(holdings/liens). Independently sign canonical payload hashes and scope/time/revision. Each simulated adapter has
its OWN runtime-generated simulated signing key. No private keys in git, output or logs. No-key tests generate
throwaway keys locally; replay ships public keys/signatures only. Real adapters implement the same interface and
validation. The trusted verification-key roster records source roles, validity dates, revocation and fund scope; sig_ok never proves
financial truth or complete coverage. Prevent stale replay and source role substitution.

Asset class policy is a versioned configuration/adapter module interface: supported source schema, valuation,
score policy, validators and test vectors. v3 activates credit only. real_estate and treasury remain reserved;
adding one requires reviewed config/modules, fixtures and a new method pin as necessary, not rewriting the core
receipt pipeline. Do not claim an enum switch supplies a new valuation model.

Proposed public contract views (new unless already present with equivalent semantics):
- get_latest_receipt(token_id) -> full public envelope or null.
- get_receipt(token_id, seq) -> immutable public envelope or null.
- list_funds(from_index, limit) -> bounded registered-fund page, stable IDs; maximum 100.
- get_receipt_history(token_id, from_seq, limit) -> bounded ordered page, maximum 100.
HTTP GET /v1/funds, /v1/funds/{token}/receipts/latest, /v1/funds/{token}/receipts/{seq} and
GET /v1/funds/{token}/receipts?from_seq=&limit= mirror these read-only views. Include source contract/block/hash and cache time, preserve null/suppression, accept no private arguments.
The HTTP service is a convenience cache, not a trust root. No endpoint triggers a run or transaction.

HTTP response wrapper: {network,receipts_contract,block_height,block_hash,fetched_at,next_from_seq,data,verification}.
data is an envelope, envelope array, fund array or null as appropriate; next_from_seq is u64 string/null and history
is ascending, inclusive from_seq with limit 1..100. verification is null if not performed, otherwise
{attestation_status,reason_codes:[...]}; it is OUTSIDE each envelope/hash. Missing receipt returns data=null, never
an invented genesis record. Every returned envelope carries currency/network/contract identity independently.
Verifier reason-code enum is pinned in schema/verifier-result.schema.json and the method artifact: ok,
schema_invalid, hash_mismatch, method_unknown, method_hash_mismatch, engine_mismatch, attestation_missing,
attestation_invalid, attestation_expired, attestation_unbound, source_signature_invalid, source_registry_unavailable,
previous_missing, previous_hash_mismatch, sequence_invalid, head_untrusted, network_mismatch, contract_mismatch,
correction_invalid, evidence_unavailable. Unknown/missing evidence cannot become ok. Status-only metadata is never
silently mixed into committed receipt bytes.

Reusable verifier package, proposed API verifyReceipt(envelope, evidence, priorReceipt, policy): recompute digest,
validate schema/method pin, match attestation_ref to quote/collateral/output binding and engine hash, bind input
commitment/request context, verify previous hash and monotonic sequence against contract views. Pin the trusted
contract/chain and head; a self-consistent fabricated history alone is insufficient. Return verified / invalid /
unknown with fixed reasons. Offline replay validates at recorded time; current revocation/freshness requires reads.
Verify available historical collateral honestly; no signature invented if a provider lacks evidence. Verifiers can
check execution bindings without access to hidden records; full financial recomputation requires authorized inputs.

Track record = method_version plus the prev_receipt_sha256 chain and retained source/proof references. Preserve
method transitions and corrections. History becomes the assessment dataset, not evidence of predictive accuracy
until compared with subsequent outcomes. All parties and data remain simulated. No provider/competitor names or
traction/user claims are introduced here.

## 9. Private AI analyst: LOCKED KEEP SMALL, conditional deadline

NEAR AI Cloud analyst for paid report buyers only. Verify wallet-bound entitlement, fund scope and buyer session;
feed only that fund's bounded report projection. Answers use bands and receipt facts with receipt_sha256/seq,
never raw loan data, exact hidden amounts or unrestricted tools. Unknown yields null unavailable citations and a
no-receipt note. The model cannot choose additional retrieval scopes. Enforce budgets and query limits. Red-team
prompt injection, other-fund requests, arithmetic inversion, repeated thresholds, encoded exfiltration and output
caches/logs. Renderer enforces schema/allowed fact IDs after inference. Built LAST among musts. Drop if behind on
Thu 12 Nov per the owner, disclose the drop; this supersedes the former monitor-only cut rule.

## 10. Leak tests required in CI

Tests are planned, not run by this documentation commit. Use public synthetic attacker knowledge plus all public
receipt fields, feed outputs, events, transaction arguments, attestation exports and network aggregates. A salt
protects commitments from guessing; it cannot hide information already disclosed by ratios, counts or scores.

1. Preserve a failing legacy attack fixture: DEMO-CREDIT exposes a non-late/current principal sum of 850M cents
   and late_share=1500 bps. Reconstruct total = 850M / (1 - 0.15) = 1,000M cents; hidden late principal = 150M
   cents ($1.5M). With the equal-size $500k loan fixture knowledge (or remaining total/cohort count constraints),
   recover 3 loans despite primary suppression. Pin the precise source fields and full derivation in CI; 850M is
   the non-late sum, not the total denominator. Inspect all cohort sums and claimed_not_settled_cents too.
2. Required cash/NAV matrix (including TrueRange midpoint and low/high width): test all four rounded NAV fields against EACH cash_evidence_status, cash_match_band,
   yield_gap_band, collection_rate_band, late_share_band, each cohort/suppression output and each exception band.
   Cross these with EACH parts_band field and its high/medium/low/none/unknown states, the public score, coverage
   and registry knowledge. Include every valid boundary and joint combination; repeat
   this matrix for consecutive receipts and corrections, including transitions across NAV rounding steps and cash
   bands. Inconsistent combinations are schema-negative cases, not silently skipped privacy cases.
   One-receipt reconstruction: attacker enumerates known synthetic tapes, solves ratio/denominator and score-part
   equations, tests NAV rounding residuals, and uses totals to recover suppressed cohorts. Compare public-policy
   permissible intervals with recovered candidates; a unique hidden amount/count below the intended granularity
   fails. Exact NAV values and salt are not directly published; attacks must still assess inference from the intentional score disclosures.
3. Two consecutive receipts: difference counts/bands, unchanged roster and known single-payment/default events;
   use corrections, stable fund IDs and known registry events to solve changes. Independent salts must defeat
   commitment comparison. Complementary suppression is temporal as well as within one receipt; previously public
   facts cannot be re-hidden, so suppress new fields or withhold unsafe publication and record a private reason.
4. All-public-field disclosure CI: receipts/tests/receipt_v3_observer.py reads every public envelope field via
   a frozen field catalog plus the closed schema. It derives score/cap/freshness/parts bounds, R6/R7/R13 value
   constraints, inverse NAV ladder cells, TrueRange midpoint, cash bands and count/cohort constraints. No private
   TEST report or expected result is an observer input. Tests cover ALL four goldens, their correction pair and
   a distinct two-receipt loan-turns-unverified case, not a Harbor-only constant.
   Accepted coverage bounds are the per-vector table in sec. 7: zero unverified share intentionally reveals 40;
   Meridian retains its measured all-fields interval. General rule: FAIL any tighter interval for any hidden
   quantity than the documented bound. Preserve every other amount at no finer than public rounding/band.
   Known TEST loan-loss prior knowledge cannot be silently attributed to receipt-only inference. The old universal
   +/-0.5 rule is superseded. schema/vectors/disclosure-bounds.json freezes endpoints and open/closed semantics.
   Negative tests inject finer amount/coverage inferences and new private/public fields to prove the gate rejects
   them. No failure is marked expected or skipped. New observer constraints may expose new leakage; update the owner
   rather than auto-regenerating a more permissive bound. Non-null proof evidence requires explicit model expansion.
   Retain the full cash/NAV/midpoint, cohort, small-group, stale-data and temporal attack matrix around this gate.

5. Reject hidden keys and canaries in all nested objects/errors/logs; claimed_not_settled_cents, cash dollar totals,
   denominator amounts, arbitrary ext and raw source hashes must be absent. Test unauthorized buyer/key replay.
6. Network view leak test: aggregate outputs across a small roster, exclude one fund and difference over time.
   It must not reveal tighter per-fund values than permitted by the receipt. Every aggregate is public-field-only;
   exact total value is impossible if those values are hidden. Show an interval/estimate or unavailable, with
   denominator/coverage, and suppress small/complementary groups. No hidden store access to improve the headline.

Proposed commands: npm run receipt:v3:schema; npm run receipt:v3:pins; npm run receipt:v3:leaks -- --single;
npm run receipt:v3:leaks -- --consecutive; npm run network:leaks; npm run analyst:redteam -- --replay;
npm run receipt:v3:verify -- --replay. Expected: schema negatives refused, both score pins reproduce, legacy
attack recovered, v3 protected values unrecoverable beyond approved policy, unknown evidence stays unknown.
Exact scores and public registry knowledge may expose inference tradeoffs; unresolved failures block publication
until the owner approves a concrete disclosure change. No test waivers disguised as salt-based privacy claims.

## 11. Frozen interface

No disclosure decisions remain open. Coverage floors to 100 bps, or 2500 bps for small checked-count bands
lt_5/from_5_to_9 (also conservative unknown/suppressed). Attempts wire tokens are zero/one/two_plus, displayed
as 0/1/2+. All four NAV figures retain ladder rounding and individual salted commitments. Public score is whole;
precision fields are private with separate commitments. The disclosure guard enforces the accepted all-fields measured bounds. The signed-terms fingerprint fix and
bounded conditional buyer analyst remain locked. Changes after this rc3 need an explicit new revision.

Scope of this freeze: the receipts v3 contract and views, engine v3, the new pledge fingerprint, source signature
checks INSIDE the TEE, and receipt leak tests, with only the small fixtures those tests need. Contract views are in
scope; the HTTP feed and the reusable verifier are not. The simulated data generator, simulated adapters and
simulated signing material, the verifier package, the npm run judge command and the HTTP feed consume this frozen
interface; this spec supplies only minimal test vectors for them, not their production implementations. Registry
ranked-lock changes, the query/payment/report service, the analyst, dashboards, landing page and demo token are out
of scope; the identity interface does not change the registry contract. Live upgrade, configuration and every
transaction are separate later actions; this local freeze authorizes none.


## 12. Pinned files and local golden vectors

Machine schema: schema/receipt-v3.schema.json (Draft 2020-12), closed objects throughout. Literal enums use
snake_case tokens, never display operators. Human bands like <5/5-9/2+ are display labels only; use lt_5,
from_5_to_9 and two_plus on wire. x-band-intervals declares lower/upper bounds and open/closed ends; missing upper
bound means unbounded, not unknown. x-status-only-tokens and x-exception-policy cover nonnumeric states.
Method artifact: schema/methods/truenav-v3.0.0-rc3.json. method_spec_sha256 = SHA256(JCS(artifact)), not this Markdown
file or a self-containing artifact. Artifact pins schema file bytes via receipt_schema_sha256. No circular hash.

schema/vectors/receipt-v3-golden.json contains Harbor, Meridian, one Harbor correction and one capped Harbor
variant, each with canonical execution/receipt preimage UTF-8/hex, receipt_sha256 and expected score. These are
LOCAL SERIALIZATION/PIN vectors, not live receipts, real attestation or signed-source evidence. Synthetic engine
hash, null proof reference and opaque commitment placeholders must never be passed off as a deployed build or
mathematical commitment verification. No production salt or private signing material is exported. Corrections preserve benchmark
as-of; source_correction is illustrative metadata only. Full external scenarios live with the simulated data generator.
The CI enumeration and vector tests for this spec run separately from the root npm scripts. The judge command
consumes these vectors and pins; it is not implemented here.


## 13. Rc3 known-answer and benchmark fixtures

schema/vectors/commitment-known-answers.json pins every H label with an all-zero 32-byte TEST salt AND nonce,
explicitly TEST ONLY, including canonical null, exact NAV objects and private score label classes. This is the
only public test-entropy exception; never use that entropy for a production report. Live salts remain private.
schema/vectors/source-signature-known-answer.json uses the RFC 8032 section 7.1 TEST 1 public verification key
for a new source-framing message. It contains only public verification key, framing inputs/preimage, digest and
signature, no signing seed. The interface test verifies the frozen signature; it does not regenerate it randomly.

Golden benchmark cohorts: Harbor 2 at 1-30 DPD and 1 over 90; Meridian 1 at 61-90 and 1 over 90. Those cells use
lt_5. Other cohort cells are complementary suppressed, even when zero, to prevent subtraction from revealing the
small cells. Private TEST-only expected counts accompany vectors so tests verify true tape counts, not invent them.
Golden test_private_score_report is a public synthetic test projection of the PRIVATE report interface, not an
extra public envelope field. It contains only already-published benchmark score information and TEST entropy.
All four golden receipt/execution hashes are regenerated for rc3. No live proof, deployment or current TEE run
is claimed. The former rc2 method artifact remains in git history; rc3 references the new artifact path.
