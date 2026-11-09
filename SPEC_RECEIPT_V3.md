# TrueNav receipt v3 specification

Status: FROZEN v3.0.0-rc2, pending the owner's final read (9 Nov 2026 Bangkok).
the owner's 9 Nov rc2 review: fixed NAV ladder, public parts_x100, stable lane interfaces and first-lien-only policy.

Design only, the owner decisions of 9 Nov 2026 Bangkok. No implementation, deployment or transaction is authorized by
this document. Option A is LOCKED: one combined receipt per credit fund per reporting period on receipts.
Corrections append a sequence referencing the superseded entry; old entries remain immutable. Credit is the main
demo. Rental and DEMO datasets remain regression fixtures through their existing methods, not v3 validation.

## 1. Locked method and encoding

method_version = truenav-v3.0.0. Keep the existing NAV method's 40 coverage / 40 NAV gap / 20 freshness points,
including its existing penalty, eligibility and no-number status rules. Coverage means R7 verified VALUE, not the
loan-count registry-read coverage metric. Rename the former pledge_coverage score part to coverage. Spec source: spec/nav/NAV_SPEC.md R6-R14.
Cashflow-v2.1.0 contributes red-flag caps only: any applicable cap restricts the final score to at most 59.00.
It adds no fourth weight and cannot raise a score. Use exact internal inputs for policy comparisons, never public
rounded values. Retain its current cap triggers and closed codes, including the strict collection threshold.
Harbor 99.17 green and Meridian 42.84 red must reproduce from their original inputs and pinned valuation time.
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
| network / receipts_contract / currency | fixed strings near_testnet / receipts.tnlab-718ca9.testnet / USD | P, part of every hash and signature context | Prevent cross-network/contract/unit substitution |
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
public data. Unit tests may inject synthetic entropy in memory, but no salt is exported in public receipt/proof
fixtures. Salt and exact values are released only within the buyer's private full report.

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
Any sig_ok=false -> status=verification_failed, score_x100=null, band=red, raw_score=null and hold
source_signature_invalid; do not run normal scoring on rejected payloads. Invalid/unavailable/revoked/expired keys
use the corresponding closed hold, also verification_failed; never downgrade them to an apparently successful run.

### Exact H interface

H(label,value) = SHA256(LP(UTF8("truenav-v3")) || LP(UTF8(label)) || LP(raw_request_nonce_32) ||
LP(raw_certificate_salt_32) || LP(UTF8(JCS(value)))). All LP lengths are u32 big-endian BYTE counts, no terminators.
Nonce/salt are raw bytes, not hex strings. Canonical null is the four UTF-8 bytes 6e756c6c; never an absent field,
empty bytes or the JSON string "null". Reject labels outside: inputs, tape, cash, nav_report, pledge_detail,
registry_state_root, full_report, nav_exact:reported_nav, nav_exact:trueval, nav_exact:truerange_low,
nav_exact:truerange_high. Exact NAV value object is {currency:"USD",cents:<canonical integer-cent string>} or null.
All other values use the versioned canonical source/report objects. Domain separation uses these literal labels.
The salt and exact values occur only in the private full report, never public vectors or proof exports.

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
| lien_support | enum first_lien_only | P, rank >=2 is unknown in rc2 | No unsupported lien assurance |
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

Second lien LOCKED rc2 policy: lien_rank >=2 -> pledge_result=unknown, hold=second_lien_unsupported; the
loan is unverified for R7/R13. Never flag it as a proven double pledge merely for having rank 2, and never clear
it as a supported second lien. Record rank and signed terms privately. Rank 1 conflicts remain conflicts. Ranked
registry locks/migration are unowned follow-up work, not a hidden backend lane task or a Wednesday prerequisite.
A conflicted OR unread loan becomes unverified and flows through R7 verified-value coverage and R13 exposure
eligibility. Completed read does not mean verified ownership: a completed read showing a conflict still counts in
read coverage. Result priority: known conflict first; otherwise unsupported rank => unknown; otherwise incomplete
reads => incomplete; otherwise clear only with supported first liens and matching ownership.

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

backend lane identity work: 4-6 hours, including normalization/signatures/vectors 2-3 and OutLayer fingerprint change
and build 2-3. Registry rank/lineage implementation and migration belong to an external owner and are excluded.
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

Primary suppression: hide positive counts 1..4 as <5. Complementary suppression: if totals, other cohorts or
coverage fields would solve a suppressed cell, suppress another cell with a generic suppressed marker (not <5)
and/or suppress the total. Do not suppress a large cell as <5. Evaluate all public fields jointly, including
loans_checked, overlapping cohorts and prior receipts. Bucket additional visible counts if needed. Zero is public
only when it cannot expose a hidden complement. Suppression applies to derived HTTP/network outputs too.

## 7. Score and extension fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| status | enum scored / disclaimed / verification_failed / invalid_fund_fields / not_rated | P, preserve legacy eligibility order and no-number rules | Explicit score availability |
| score_x100 | u16 0..10000 or null | P, half-up to 0.01 from exact final legacy score after penalties/caps | Preserve 9917 and 4284 |
| band | enum green / yellow / red / grey | P, existing legacy whole-score rounding then 85/60 thresholds; R12 yellow ceiling | Preserve old boundary semantics |
| parts_x100 | {gap,coverage,freshness,penalty} integers or null | P, each round_half_up(100*part), no privacy bucketing | Score decomposition is intentionally public |
| raw_score | canonical decimal string or null | P when identical to public parts sum; otherwise null and exact total in private report | No claim of hiding an already published sum |
| parts_band | {coverage, nav_gap, freshness, penalty} | P, exactly four required enum fields; no additional keys | Coarse explanation of each existing score part |
| parts_band.coverage / nav_gap / freshness / penalty | enum high / medium / low / none / unknown | P, thresholds below, using exact internal values | Explain contributions and penalty without publishing exact parts |
| caps / holds | arrays of closed code strings | P, no interpolated money/ratios/loan IDs | Explain constraints without bypassing suppression |
| freshness_band | enum <=24h / >24-72h / >72-168h / >168h / unknown | P, based on oldest required source | Honest age; issued_at cannot refresh inputs |
| ext | object {} | P, MUST be empty; unknown extension keys rejected | Prevent disclosure through arbitrary metadata |

LOCKED scoring formula (all arithmetic BEFORE display rounding):
raw = gap + coverage + freshness - penalty;
cap = 59.00 if any cash cap applies, otherwise 100.00;
final = min(cap, max(0, raw));
score_x100 = round_half_up(final * 100), from the UNROUNDED total, never the sum of rounded parts_x100.
Each parts_x100 member is separately round_half_up(part*100); their sum can differ from score_x100.
Band uses the legacy round_half_up(final) thresholds 85/60 to preserve boundary behavior. R12 emits closed hold
recent_pledge_attempt for 30 days after an applicable attempt and caps the BAND at yellow, leaving the number
unchanged. Concentration holds concentration_largest_obligor and concentration_top_five are flags only, NO score
or band cap. Cash collection_pending/not_applicable holds also limit band to yellow without adding a fourth weight.
R15 concentration triggers are largest share >15% and top-five >50%; exact boundaries do not trigger them.

raw_score is public as a canonical decimal iff raw exactly equals
(parts_x100.gap+parts_x100.coverage+parts_x100.freshness-parts_x100.penalty)/100; otherwise emit null and retain
unrounded raw in the private report. Never publish a rounded raw masquerading as the exact value. This is an
output rule, not a privacy guarantee: exact score plus public data_as_of and registry attempts can recover score
parts, BY DESIGN. parts_x100 and parts_band are both public. No parts are claimed hidden. Use full precision
internally for the final total; do not tune or independently round contributions to make the pins hold.

No numeric score for invalid_fund_fields/disclaimed/verification_failed/not_rated: score_x100=null; source rejection
also nulls all parts_x100 and parts_band becomes unknown. Other unavailable individual parts are null/unknown,
not zero. Band/status follow R14. receipt:v3:pins and external npm run judge -- --replay must reproduce 9917 green
and 4284 red using the benchmark funds' original as-of timestamps, including the original Meridian attempt age.

### Public score-part bands

These are display-only classifications, not a fourth score weight, a new penalty or a change to caps. Compute
them from the exact internal pre-cap contribution points and the total applicable penalty after existing
manager/attempt scope rules, before flooring the final score. Do not derive them from rounded score_x100.
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
boundary, not rounded display numbers. parts_x100 remain public even when a cap binds; raw_score follows its conditional publication rule.
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
4. Multi-output attacks: public score plus NAV result plus coverage, cash bands, public registry locks/attempts,
   all four parts_band fields, source timestamps and method changes. Try reconstructing an exact part or raw_score
   from public parts_x100/parts_band, data_as_of and registry attempts. Such score-part recovery is intentional
   disclosure, not a failing privacy assertion. Separately attack hidden NAV/cash/loan values through those same
   public equations, including capped scores and known penalty events; hidden financial reconstruction still fails.
   Test contribution boundaries at 0/20/34/40 and 0/10/17/20, penalty boundaries at 0/5/15, adjacent exact values,
   and unknown-to-known transitions. For consecutive receipts, attack band crossings, unchanged parts, decaying
   penalties and corrections. Public outputs must not expose hidden values beyond approved disclosure granularity;
   unsafe combinations block publication rather than silently changing the locked thresholds or hiding a field.
   Test boundary queries and many analyst questions as a single budget.
   Existing registry visibility is declared attacker knowledge, not privacy credited to the receipt.
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

## 11. Frozen interface and lane ownership

No disclosure decisions remain open. Coverage rounds down to 100 bps, all four NAV figures are rounded with
separate salted exact commitments, and blocked attempts are "0" / "1" / "2+". The signed-terms fingerprint fix and
bounded conditional buyer analyst remain locked. the owner's final read is pending; changes after this rc2 need an
explicit revision and coordination with consuming lanes.

backend lane owns lab/ci-green and lab/receipt-v3-spec, receipts v3 contract/views and Wed upgrade preparation,
engine v3, new pledge fingerprint, source signature checks INSIDE the TEE, and receipt leak tests. Only small
fixtures necessary for these tests belong here. Contract views are in this lane; the HTTP feed and reusable
verifier are not. No generator/attack-scenario dataset, judge command, dashboard, landing, demo token or external
adapter implementation is assigned here. lab/sim-data owns the generator, simulated adapters and simulated signing material, broad fixtures and attack
scenarios. lab/verifier owns the verifier package, npm run judge entry command and HTTP feed. Both consume this
frozen interface; backend lane supplies only minimal owned test vectors, not their production implementations. Registry ranked-lock changes, query/payment/report service, analyst, dashboards/landing and demo token
are UNOWNED and need the owner to assign them; the identity interface does not grant ownership of the registry contract.
Root package.json/README changes require task necessity and must be reported. Keep skills/ out. Live upgrade,
configuration and every transaction remain gated on the owner's specific yes; this local freeze authorizes none.


## 12. Pinned files and local golden vectors

Machine schema: schema/receipt-v3.schema.json (Draft 2020-12), closed objects throughout. Literal enums use
snake_case tokens, never display operators. Human bands like <5/5-9/2+ are display labels only; use lt_5,
from_5_to_9 and two_plus on wire. x-band-intervals declares lower/upper bounds and open/closed ends; missing upper
bound means unbounded, not unknown. x-status-only-tokens and x-exception-policy cover nonnumeric states.
Method artifact: schema/methods/truenav-v3.0.0-rc2.json. method_spec_sha256 = SHA256(JCS(artifact)), not this Markdown
file or a self-containing artifact. Artifact pins schema file bytes via receipt_schema_sha256. No circular hash.

schema/vectors/receipt-v3-golden.json contains Harbor, Meridian, one Harbor correction and one capped Harbor
variant, each with canonical execution/receipt preimage UTF-8/hex, receipt_sha256 and expected score. These are
LOCAL SERIALIZATION/PIN vectors, not live receipts, real attestation or signed-source evidence. Synthetic engine
hash, null proof reference and opaque commitment placeholders must never be passed off as a deployed build or
mathematical commitment verification. No salt/private signing material is exported. Corrections preserve benchmark
as-of; source_correction is illustrative metadata only. External full scenarios belong to lab/sim-data.
The backend lane CI enumeration/vector tests run separately from root npm scripts; root package.json/README are
unchanged. Do not implement external npm run judge here; its owner consumes these vectors and pins.
