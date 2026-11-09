# Security

TrueNav is a hackathon prototype on NEAR testnet with fictional data. Do not use it with real funds or real loan documents.

## Reporting

Open a private security advisory on this repository (GitHub, Security tab). Please do not open a public issue for a vulnerability.

## Practices in this repository

- Contract: near-sdk 5.30.1, 80 unit tests (including real TEE-signed verdicts, every role boundary and every pause path), clippy with warnings as errors, RustSec audit in CI, checked against the NEAR contract audit checklist (callbacks, reentrancy, JSON integer types, unsaved changes, owner checks, one-yocto on sensitive calls, storage prefixes, init macro, unbounded loops). A Gemini 3.1 Pro audit on 6 Nov 2026 found 4 items; each was checked by a test (2 false, 1 fixed, 1 kept by owner decision), see `contract/README.md`.
- Reproducible build with a pinned image digest; the testnet code hash matches the build.
- CI: pinned action SHAs, read-only token, no persisted credentials, gitleaks over the full history.
- Dependencies are pinned to exact versions with lock files. Known advisory: `elliptic` (low severity), a transitive dependency of the attestation quote verifier `@phala/dcap-qvl`; it is not used to sign anything.
- RustSec: `RUSTSEC-2026-0387` (crypto-bigint timing) is ignored in `contract/.cargo/audit.toml` because it reaches the crate only through test code (k256 test vectors, near-sdk's unit-testing VM) and is not in the deployed wasm. Unmaintained-crate warnings: `unsafe-libyaml` comes from near-sdk's unit-testing VM only; `wee_alloc` is near-sdk 5.30.1's default wasm allocator and is in the deployed wasm (near-contract-standards enables near-sdk's default features, so it cannot be switched off here). Both are flagged as unmaintained, not as known vulnerabilities.
- Keys: NEAR account keys live in `~/.near-credentials` (outside the repo); throwaway certificate signer keys live in `.keys/` (gitignored). The NEAR AI Cloud key is never read by the code in this sandbox's runs; it is injected by a network proxy or read from `NEAR_AI_CLOUD_API_KEY`.

- Roles: admin, registrar, pauser and servicer are separate; a pause switch stops all state-changing calls of the flow.
- TEE: the attestation report is published (`tee/fixtures/attestation-report.json.b64`) and re-checkable with `npm run verify:attestation`; every verdict is bound to one contract, network, version and a 30-day expiry.

See `TRUST_MODEL.md`, `THREAT_MODEL.md` and `AUDIT_FINDINGS.md`.

## Receipts v3 attestation records, local candidate

No hardware quote is validated on-chain. A stored proof locator is not an attestation verdict. Frozen v3 receipts remain immutable with attestation_ref=null. The callback separately binds canonical B through body_sha256. Only the designated OutLayer relayer can append proof records; storage is paid, existing records cannot be deleted or overwritten, and exact retries are idempotent. Admin writer rotation requires a pause and never changes old records.

Off-chain verification must check the public OutLayer proof against the receipt/body hashes, approved engine, original request input, signer/project, REPORTDATA, all worker measurements and Intel quote verification. No record or unavailable evidence means unavailable. Only a successful off-chain match may be labelled attested. No real v3 OutLayer proof has been produced by this local task.

The new method and storage are in round-1 audit scope before the upgrade: writer authorization and rotation, no permissionless proof slot, immutable receipt/body binding, composite keys, append-only indexes, idempotent replay, bounded references/pages, deposit/refund accounting and the off-chain trust boundary. A clean local test run does not substitute for that audit. See receipts/attestation/OUTLAYER_BODY_BINDING.md and UPGRADE_V3.md.

## Round 1 fix pass

`REDTEAM_R1.md` records the findings. High and medium code fixes:

- Pledge identity is one domain: `truenav-fp-v1|real_estate|{document root}`. The document root is NFKC, Unicode lowercase, with whitespace and invisible characters removed, and one trailing `-copy` removed. Principal and dates are not in the hash. The same document id is one loan even if the borrower id changes or gains a short hyphen suffix (`BORROWER` and `BORROWER-A`). Lookup also covers a `truenav-fp-v3` domain (document root plus borrower root) and `truenav-fp-v1|invoices|{document root}`.
- A tape principal that is not the signed `principal_cents`, or a foreign lock at any lien rank, sets `pledge_conflict` and caps the score at 59 red. The second-lien hold still applies. Ranked-lien sharing is not built.
- Signed source scope can carry `fund_id`. An empty `fund_id` is omitted so older signatures keep their bytes. The execution body includes `fund_id` (the token id when the scope field is empty). The matcher rejects a caller `fund_id` that differs from the attested `fund_id` or `token_id`.
- Quotes must be Intel `UpToDate` and no more than 30 days from the verifier clock.
- Attestation records are capped at 12 per receipt and 3 per attester, counted across writer rotation. A missing record returns `attestation_record_missing` and does not panic.
- A corrupt stored head does not start a run. The call returns `error: v3_receipt_corrupt` and `head_status: failed`, and refunds the deposit. A later failed run keeps the stored receipt for history and marks the live head failed (`get_latest` band red, `get_latest_receipt` `head_status: failed`) so a stale green envelope is not the current head.
- Public score and report responses, and v2 `get_receipt` text, omit `uncapped_score`, exact cent fields, and other fields outside the public allowlist.
- Token registration is capped at 64. `redeem` respects pause.
- A registry read with no lock is `completed: false`, so a missing pledge can surface as an incomplete read.

Migration: the fingerprint no longer hashes principal, dates, or the old full loan-terms message, and document ids are casefolded. Testnet pledge locks from earlier fingerprints will not match. Re-seed those locks on the upgrade. Sources that should name a registry `fund_id` other than the implicit token id must be signed again. Empty `fund_id` scopes do not need a new signature.

Residual: a failed OutLayer promise still refunds the forwarded deposit. Admission failure and a panic after admission look the same, and the admission path must still return the deposit. The contract account backup key is an operator removal, not a code change. The index `score` field remains a `u64`, so a JSON null score is still stored as 0. The v3 envelope keeps the null, and readers that use only the index should also read the envelope.
