# Security

TrueNav is a hackathon prototype on NEAR testnet with fictional data. Do not use it with real funds or real loan documents.

## Reporting

Open a private security advisory on this repository (GitHub, Security tab). Please do not open a public issue for a vulnerability.

## Practices in this repository

- Contract: near-sdk 5.30.1, 44 unit tests including real TEE-signed verdicts, clippy with warnings as errors, RustSec audit in CI, checked against the NEAR contract audit checklist (callbacks, reentrancy, JSON integer types, unsaved changes, owner checks, one-yocto on sensitive calls, storage prefixes, init macro, unbounded loops). A Gemini 3.1 Pro audit on 6 Nov 2026 found 4 items; each was checked by a test (2 false, 1 fixed, 1 kept by owner decision), see `contract/README.md`.
- Reproducible build with a pinned image digest; the testnet code hash matches the build.
- CI: pinned action SHAs, read-only token, no persisted credentials, gitleaks over the full history.
- Dependencies are pinned to exact versions with lock files. Known advisory: `elliptic` (low severity), a transitive dependency of the attestation quote verifier `@phala/dcap-qvl`; it is not used to sign anything.
- RustSec: `RUSTSEC-2026-0387` (crypto-bigint timing) is ignored in `contract/.cargo/audit.toml` because it reaches the crate only through test code (k256 test vectors, near-sdk's unit-testing VM) and is not in the deployed wasm. Unmaintained-crate warnings: `unsafe-libyaml` comes from near-sdk's unit-testing VM only; `wee_alloc` is near-sdk 5.30.1's default wasm allocator and is in the deployed wasm (near-contract-standards enables near-sdk's default features, so it cannot be switched off here). Both are flagged as unmaintained, not as known vulnerabilities.
- Keys: NEAR account keys live in `~/.near-credentials` (outside the repo); throwaway certificate signer keys live in `.keys/` (gitignored). The NEAR AI Cloud key is never read by the code in this sandbox's runs; it is injected by a network proxy or read from `NEAR_AI_CLOUD_API_KEY`.

See `TRUST_MODEL.md` and `THREAT_MODEL.md`.
