# TrueNav receipt v3 specification

Status: FROZEN v3.0.0-rc1, pending the owner's final read (9 Nov 2026 Bangkok).

Design only, the owner decisions of 9 Nov 2026 Bangkok. No implementation, deployment or transaction is authorized by
this document. Option A is LOCKED: one combined receipt per credit fund per reporting period on receipts.
Corrections append a sequence referencing the superseded entry; old entries remain immutable. Credit is the main
demo. Rental and DEMO datasets remain regression fixtures through their existing methods, not v3 validation.

## 1. Locked method and encoding

method_version = truenav-v3.0.0. Keep the existing NAV method's 40 coverage / 40 NAV gap / 20 freshness points,
including its existing penalty, eligibility and no-number status rules. Spec source: spec/nav/NAV_SPEC.md R6-R14.
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
| seq | u64 decimal string | P, contract-assigned strictly increasing per token | History order |
| prev_receipt_sha256 | hex32 or null | P, prior stored record hash, null only at genesis | Bind history |
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
| attestation_status | enum verified / unavailable / invalid | P, derived verification outcome | Never substitute a claimed boolean for evidence |
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

No self-reference: TEE produces a redacted public body and commits to the private report, which excludes future
seq/issued_at/receipt hash. Its attestation binds the canonical body and reserved request context. The contract
stores an envelope containing that body, seq, prev hash and issued_at. receipt_sha256 = SHA256(canonical envelope
with receipt_sha256 OMITTED). Public output adds the resulting digest. The attestation_ref points to evidence that
binds the body bytes; it cannot circularly contain the final envelope hash. Independent verification recomputes
both stages. This deliberately differs from legacy callback-byte hashing; preserve the v2 verifier for history.
A body's execution-hash preimage also EXCLUDES attestation_ref and attestation_status: those proof metadata fields
are attached to the final envelope after execution evidence exists. Reserved request context binds expected seq
and previous hash. A public verified status denotes the named external verification policy; it must not imply
that NEAR verified a hardware quote on chain. Readers independently recompute evidence status and reject a false
badge, with unknown for unavailable collateral. Define these exclusions in golden byte vectors before freeze.
A reference to unavailable/invalid evidence cannot produce a verified badge. Public proof exports must contain
only the redacted body; any provider input/output evidence containing private sources must remain private.

## 4. Pledge fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| pledge_scope | {registry_account, block_height, block_hash, scope_id, coverage_status} | P, finalized read references; private roster stays H | State the guarantee boundary |
| fingerprint_scheme | string "loan-terms-v2" | P, exact version | Identity semantics changed |
| pledge_result | enum clear / conflict / incomplete / unknown | P, clear only with all required checks | No missing-data pass |
| pledge_coverage_bps | u16 0..10000 or null | P, floor(exact_bps / 100) * 100, never round up | Locked conservative coverage |
| loans_checked | count band string or null | P, 0 / <5 / 5-9 / 10-19 / 20-49 / 50+; suppress with cohorts where needed | Avoid exposing small roster size |
| blocked_attempts | enum string "0", "1", "2+" | P, counts >=2 map to "2+" | Locked disclosure |
| lien_rank | positive integer per position | H, signed grant | Legitimate liens without position disclosure |
| lien_support | enum "ranked" | P, exact capability marker, not per-loan ranks | Describe rank-aware policy |
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

Second liens require an authorized, servicer-signed lien grant binding loan identity, canonical collateral,
lien_rank, holder, grant ID, permitted amount and declared senior liens. Store unique active locks by
(loan_fingerprint, lien_rank) plus collateral/lineage checks. Same rank pledged to another fund is a conflict;
authorized rank 2 with disclosed senior rank is legitimate and valued with its priority. A caller cannot evade
checks by choosing rank 2 itself. Absent rank authorization/coverage yields unknown/conflict, never clear.
Valuation applies the approved seniority waterfall and senior outstanding claims; two ranks cannot each claim the
entire collateral value. Missing senior claims means incomplete coverage, not an unencumbered junior valuation.
Current registry's single lock per hash does not implement this: plan an explicitly approved registry upgrade or
separate compatible v2 registry, with migration/legacy adapter and no reset of history. Never treat an off-chain
receipt declaration as lien enforcement. This is separate from the ONE receipts-contract upgrade.

Codex identity work: 4-6 hours, including normalization/signatures/vectors 2-3 and OutLayer fingerprint change
and build 2-3. Registry rank/lineage implementation and migration belong to an external owner and are excluded.
Use minimal owned tests for renamed-file, forged terms, amendment and lien input validation; external scenarios
exercise same-rank refusal and legitimate second liens against the registry. Source authenticity/canonical identifiers remain trust
assumptions; identity scope is the participating registry, not a global legal lien search.

## 5. NAV fields

| Field | Type | Visibility / rule | Why |
| --- | --- | --- | --- |
| reported_nav / trueval / truerange_low / truerange_high | rounded integer-cent decimal strings or null | P, round each to max($10,000, 0.1% of its absolute value); exact values H | Locked rounded NAV projection |
| exact.reported_nav / trueval / truerange_low / truerange_high | exact integer-cent decimal strings or null | H, never in public payloads; signed bounds allowed | Authoritative private arithmetic |
| commitments.reported_nav / trueval / truerange_low / truerange_high | hex32 each | P, separately domain-separated commitment to each exact value | Bind all four exact figures |
| nav_result | enum inside / outside_low / outside_high / unknown | P, compare exact inputs; endpoints inclusive | Useful assessment without endpoints |
| nav_gap_band | enum inside / <=5pct / 5-10pct / >10pct / unknown | P, outside gap as fraction of exact TrueVal; zero TrueVal => unknown | Coarse explanation |
| unverified_share_band | enum 0 / <=10pct / 10-25pct / 25-50pct / >50pct / unknown | P, exact internal R13 test before bucketing | Eligibility explanation |

LOCKED rounding: for each exact x cents, step = max(1,000,000, ceil(abs(x)/1000)) cents;
rounded = sign(x) * floor(abs(x)/step + 0.5) * step. Use integer arithmetic (ties away from zero), not binary
floating point. Round all FOUR fields independently; compare NAV to range on the private exact inputs. Unknown
stays null. Public bounds are rounded display figures, not recomputed decision boundaries. Add no public adaptive
step, residual or hidden amount. The private full report contains exact values and the fresh 32-byte TEE salt.
Each commitments.<field> = H("nav_exact:<field>", {currency:"USD", cents:exact_value}), using the commitment
construction above. Domain separation prevents swapping values; null has a distinct canonical representation.
Never export salt/exact values in events, transaction arguments, HTTP, attestation exports or errors.

Privacy gate: a value-derived step can reveal much more than its nominal width. Above $10M, step is approximately
x/1000, so the rounded value can remain extremely close to x. This is a locked-rule risk to TEST, not an alternative
policy silently chosen here. CI must attempt reconstruction jointly with every cash band, score and rounded bound,
for one receipt and consecutive receipts. A failure blocks publication/upgrade readiness and is reported to the owner;
FROZEN rc1 is not a claim that this rounding policy has passed leak tests. Salt protects commitments, not arithmetic.

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
| band | enum green / yellow / red / grey | P, existing legacy whole-score rounding then 85/60 thresholds | Preserve old boundary semantics |
| raw_score | signed fixed-decimal string | H, exact uncapped internal result | Public raw score could undo caps and reveal components |
| parts | {pledge_coverage, nav_gap, freshness, penalty} fixed-decimal values | H; public explanations use closed codes | Keep 40/40/20 without exposing invertible contributions |
| caps / holds | arrays of closed code strings | P, no interpolated money/ratios/loan IDs | Explain constraints without bypassing suppression |
| freshness_band | enum <=24h / >24-72h / >72-168h / >168h / unknown | P, based on oldest required source | Honest age; issued_at cannot refresh inputs |
| ext | object {} | P, MUST be empty; unknown extension keys rejected | Prevent disclosure through arbitrary metadata |

Exact public score is a deliberate disclosure. Score/band can still constrain hidden inputs; hiding parts alone is
not a proof of privacy. CI must expose any residual inference and require the owner's explicit disposition before schema
freeze. No unsupported numerical score for disclaimed/not-rated/verification-failed status: score_x100=null,
holds explain closed status, existing status/band semantics are maintained. Add status as a closed public enum.

## 8. Market-data interfaces and track record

SourceAdapter.read(scope, period, revision) returns canonical payload, schema_version, source, key_id, data_as_of,
coverage manifest and signature. Four slots: servicer (terms/claims), bank (settlements), fund_admin (NAV), custodian
(holdings/liens). Independently sign canonical payload hashes and scope/time/revision. Each simulated adapter has
its OWN runtime-generated simulated signing key. No private keys in git, output or logs. No-key tests generate
throwaway keys locally; replay ships public keys/signatures only. Real adapters implement the same interface and
validation. Register public keys with role, validity/revocation and authorized fund scope; sig_ok never proves
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
HTTP GET /v1/funds, /v1/funds/{token}/receipts/latest and /v1/funds/{token}/receipts/{seq} mirror these read-only
views. Include source contract/block/hash and cache time, preserve null/suppression, accept no private arguments.
The HTTP service is a convenience cache, not a trust root. No endpoint triggers a run or transaction.

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
2. Required cash/NAV matrix: test all four rounded NAV fields against EACH cash_evidence_status, cash_match_band,
   yield_gap_band, collection_rate_band, late_share_band, each cohort/suppression output and each exception band.
   Include every valid boundary and joint combination with score, coverage and public registry knowledge. Repeat
   this matrix for consecutive receipts and corrections, including transitions across NAV rounding steps and cash
   bands. Inconsistent combinations are schema-negative cases, not silently skipped privacy cases.
   One-receipt reconstruction: attacker enumerates known synthetic tapes, solves ratio/denominator and score-part
   equations, tests NAV rounding residuals, and uses totals to recover suppressed cohorts. Compare public-policy
   permissible intervals with recovered candidates; a unique hidden amount/count below the intended granularity
   fails. All four exact NAV values and their salt remain hidden under the locked rule.
3. Two consecutive receipts: difference counts/bands, unchanged roster and known single-payment/default events;
   use corrections, stable fund IDs and known registry events to solve changes. Independent salts must defeat
   commitment comparison. Complementary suppression is temporal as well as within one receipt; previously public
   facts cannot be re-hidden, so suppress new fields or withhold unsafe publication and record a private reason.
4. Multi-output attacks: public score plus NAV result plus coverage, cash bands, public registry locks/attempts,
   source timestamps and method changes. Test boundary queries and many analyst questions as a single budget.
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
bounded conditional buyer analyst remain locked. the owner's final read is pending; changes after this rc1 need an
explicit revision and coordination with consuming lanes.

Codex owns lab/ci-green and lab/receipt-v3-spec, receipts v3 contract/views and Wed upgrade preparation,
engine v3, new pledge fingerprint, source signature checks INSIDE the TEE, and receipt leak tests. Only small
fixtures necessary for these tests belong here. Contract views are in this lane; the HTTP feed and reusable
verifier are not. No generator/attack-scenario dataset, judge command, dashboard, landing, demo token or external
adapter implementation is assigned here. External agents on lab/sim-data and lab/verifier consume this frozen
interface and own their assigned implementations. Registry ranked-lock changes, paid-report service and analyst
need explicit external ownership; the identity interface does not grant ownership of the registry contract.
Root package.json/README changes require task necessity and must be reported. Keep skills/ out. Live upgrade,
configuration and every transaction remain gated on the owner's specific yes; this local freeze authorizes none.
