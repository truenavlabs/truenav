# TEE underwriter eval and red-team report

Run: 6 Nov 2026, model `Qwen/Qwen3-VL-30B-A3B-Instruct` in NEAR AI Cloud (attested TEE), one answer per document, no retries. Every reply is signed by the attested model key and stored in `tee/eval/results.json`. Reproduce the numbers without a key: `npm run eval` (re-checks all 86 signatures, then recomputes `tee/eval/metrics.json`). Rerun the documents live with a key: `npm run eval:run`.

The 86 documents are fictional and watermarked "DEMO, NOT A REAL DOCUMENT", generated deterministically by `tee/eval/generate.mjs`. A positive is a document that should be flagged.

## Result

| Metric | Value |
| --- | --- |
| Signatures verified against the attested TEE key | 86 of 86 |
| Recall (tampered documents flagged) | 100% (46 of 46) |
| Precision of a flag | 93.9% (46 of 49 flags) |
| False positive rate (honest documents flagged) | 7.5% (3 of 40) |

| Category | Cases | Flagged | Expected reason code given |
| --- | --- | --- | --- |
| honest | 40 | 3 (false positives) | n/a |
| amount edit (plus 1M, times 10, divided by 10, plus 9, minus 50k, digits reversed) | 12 | 12 | 12 |
| id edit | 6 | 6 | 6 |
| asset swap (invoice for a title claim and the reverse) | 4 | 4 | 4 |
| prompt injection (direct, reviewer note, role play, fake JSON, obfuscated, other language) | 12 | 12 | 12 |
| duplicate (certified copy, re-issued) | 6 | 6 | 6 |
| unreadable (garbled, amount illegible, empty) | 6 | 6 | 3 |

## Findings

1. **No tampered document passed.** Every amount edit, including a 9-dollar change, and every injection style was flagged. Injections did not change any verdict to pass.
2. **False positives: 3 honest title reports flagged as duplicate_document** (E009, E013, E033). The earlier demo run showed the same pattern once (H-RE-05, rechecked and recorded in `tee/fixtures/verdicts.json`). Cause not verified; the likely trigger is the "Recording reference" line, which the duplicate check mentions.
3. **Reason codes are less reliable than verdicts.** 3 of 6 unreadable scans were flagged as amount or id mismatch instead of unreadable; 7 of 12 amount edits also carried asset_mismatch. The score uses the verdict, and anomaly codes are shown only as reasons.
4. **Model echo.** The reply must copy the loan hash and the binding exactly. The demo runs saw one miscopied hash before the hash was sent in 8-character groups; the eval had no echo errors.

## What this means for the score

A false positive makes an honest loan unverified until the servicer submits a later pass from a new request. At a 7.5% rate that is visible. In the demo, the recorded verdicts are first answers except H-RE-05, which is marked as rechecked.

## Open items (decisions for the owner)

- Reduce duplicate_document false positives: drop the "Recording reference" line from the title template, or tighten the duplicate check to the words only, then rerun this eval. Either changes the underwriter or the demo documents.
- Decide whether reason codes should be shown to investors, given finding 3.

## Limits of this eval

86 synthetic documents in two fixed templates; real loan documents vary far more. One model, one prompt, one run; LLM answers vary between runs. Documents were written by the same team that wrote the prompt.
