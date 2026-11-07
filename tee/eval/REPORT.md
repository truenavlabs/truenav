# TEE underwriter eval and red-team report

Model `Qwen/Qwen3-VL-30B-A3B-Instruct` in NEAR AI Cloud (attested TEE), temperature 0, one answer per document, no retries. Every reply is signed by the attested model key. Reproduce every number without a key: `npm run eval` (re-checks all signatures and the reply rule, then recomputes `metrics.json` for each set). Rerun live with a key: `npm run eval:run -- main` and `npm run eval:run -- holdout`.

All documents are fictional and watermarked. A positive is a document that should be flagged.

## Two sets

- **Main set** (`tee/eval/`, 86 documents, `generate.mjs`): the set used on 6 Nov.
- **Hold-out set** (`tee/eval/holdout/`, 40 documents, `holdout/generate.mjs`): new templates and wording, written and committed (e7699fe) before the changed prompt was run on anything, and not edited since (owner decision 7 Nov). Honest hold-out documents carry near-miss words ("certified by", "issued", "original lender", "copy furnished", "INVOICE COPY") but never the duplicate phrases.

## Two ways to count (owner decision 7 Nov)

- **Raw**: the verdict the model returned.
- **Grounded**: a `duplicate_document` code counts only if `duplicate_evidence_line` points at a document line that contains "CERTIFIED COPY" or "re-issued" (`tee/eval/ground.mjs`, tested in `tee/test/ground.test.mjs`). Eval level only: on chain a signed flag stays a flag and clears only through a later pass from a new request.

## Result, 7 Nov (current prompt)

| | Main, raw | Main, grounded | Hold-out, raw | Hold-out, grounded |
| --- | --- | --- | --- | --- |
| Signatures verified | 86 of 86 | | 40 of 40 | |
| Replies within the reply rule (allowed keys only) | 86 of 86 | | 40 of 40 | |
| Recall (tampered flagged) | 100% (46 of 46) | 100% | 100% (20 of 20) | 100% |
| Precision of a flag | 100% (46 of 46) | 100% | 100% (20 of 20) | 100% |
| False positive rate (honest flagged) | 0% (0 of 40) | 0% | 0% (0 of 20) | 0% |

Grounding changed nothing: every duplicate flag (6 main, 3 hold-out) gave a line number that holds the phrase, and no honest document was flagged.

| Category | Main: cases, flagged, expected code | Hold-out: cases, flagged, expected code |
| --- | --- | --- |
| honest | 40, 0, n/a | 20, 0, n/a |
| amount edit | 12, 12, 12 | 6, 6, 6 |
| id edit | 6, 6, 6 | 3, 3, 3 |
| asset swap | 4, 4, 4 | 2, 2, 2 |
| prompt injection | 12, 12, 12 | 4, 4, 4 |
| duplicate | 6, 6, 6 | 3, 3, 3 |
| unreadable | 6, 6, 4 | 2, 2, 1 |

## What changed since 6 Nov

| | 6 Nov (main set) | 7 Nov (main set) |
| --- | --- | --- |
| False positive rate | 7.5% (3 of 40: E009, E013, E033, all `duplicate_document`) | 0% (0 of 40) |
| Precision | 93.9% | 100% |
| Recall | 100% | 100% |
| Replies echoing document fields (`document_id`, `asset`, `amount`) | 66 of 86 | 0 of 86 |

The 6 Nov run is kept unchanged in `results-2026-11-06.json` and `metrics-2026-11-06.json`.

Cause of the 6 Nov false positives: the three flags quoted no line; the documents contain neither phrase. The prompt now (1) numbers every document line, (2) asks for `duplicate_evidence_line` and says the check is ok when no line can be given, (3) says only the exact words count and a repeated line or watermark is not a duplicate, and (4) lists the exact allowed reply keys. Point 3 was added after a smoke test on the demo documents (not the eval or hold-out sets): with points 1, 2 and 4 alone, the honest demo document H-RE-01 was flagged with line 13, its closing watermark, which repeats line 1. The hold-out set was frozen before either change was run.

## Findings

1. **No tampered document passed** in either set, including a 1-dollar and a 9-dollar change and every injection style (10 styles across both sets).
2. **The false positives are gone on both sets** with an evidence line number required; the grounding check found no ungrounded duplicate flag to drop.
3. **The reply leak is gone.** On 6 Nov most replies repeated the document id, asset and amount, which became public transaction data (AUDIT_FINDINGS 21). Every 7 Nov reply holds only the allowed keys; the client, the contract and CI now reject anything else.
4. **Reason codes remain less reliable than verdicts.** Unreadable scans were all flagged, but 2 of 6 (main) and 1 of 2 (hold-out) carried an amount or id code instead of, or besides, `unreadable`. The score uses the verdict; codes are reasons only.

## Limits of this eval

126 synthetic documents in four templates, written by the same team that wrote the prompt; real loan documents vary far more. One model, one prompt, one run each; LLM answers can vary between runs even at temperature 0. A perfect score here means no failure was found in these documents, not that the underwriter cannot fail. The evidence line number points into the private document, so outside the eval nobody can check it from chain.
