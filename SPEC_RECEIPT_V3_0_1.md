# TrueNav receipt method v3.0.1 amendment

The owner locked this amendment on 9 Nov 2026 at 16:39 Bangkok. New receipts use method_version=truenav-v3.0.1. The receipt_version stays "3". The frozen v3.0.0 spec, schema, method artifact, goldens, observer and historical receipts remain byte-identical.

The new schema is schema/receipt-v3.0.1.schema.json. It differs from the frozen schema only in its ID, method_version constant, added pledge_conflict cap code and caps maxItems 6. The new method artifact is schema/methods/truenav-v3.0.1.json. Its receipt_schema_sha256 binds the new schema bytes; public method_spec_sha256 binds its JCS bytes. Every other field, rounding, commitment, signature and privacy rule is inherited unchanged.

A confirmed active first-lien ownership conflict has pledge_result=conflict and cap pledge_conflict. After unchanged R7/R13 and the existing cash caps, final=min(59,max(0,raw)); public score is at most 59 and band is red. Eligibility rules still take precedence: disclaimed/not-rated/failed outcomes retain a null score, never become a numeric 59. The private full report commits to the capped score_x100 and unchanged raw_score/parts. This adds no fourth scoring weight.

An unsupported rank >=2 alone has pledge_result=unknown and hold second_lien_unsupported, without pledge_conflict or a conflict score cap. A separate proven first-lien conflict retains priority. A refused attempt on an otherwise clean book is not an active conflict; its existing R10/R12 rules still apply. Harbor stays public 99 green/private 9917 and Meridian public 43 red/private 4284.

Validation dispatches on method_version: truenav-v3.0.0 selects only rc3 and its old artifact; truenav-v3.0.1 selects only the new schema/artifact. No trial-schema fallback. A v3.0.0 receipt with pledge_conflict rejects even if its hash is recomputed. A v2 wrapper cannot pass as a v3 envelope. The backend core and proof matcher implement this dispatch; the separately owned verifier/feed must integrate it before any live read publication.

No hardware quote is validated on-chain. Frozen attestation_ref remains null. The detached append-only attestation record, designated storage-funded writer, public-proof matcher and mandatory round-1 audit scope remain as specified in receipts/attestation/OUTLAYER_BODY_BINDING.md.
