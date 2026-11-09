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
