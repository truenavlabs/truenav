# Security

TrueNav is a hackathon prototype on NEAR testnet with fictional data. Do not use it with real funds or real loan documents.

## Reporting

Open a private security advisory on this repository (GitHub, Security tab). Please do not open a public issue for a vulnerability.

## Practices in this repository

- Contract: near-sdk 5.30.1, 80 unit tests (including real TEE-signed verdicts, every role boundary and every pause path), clippy with warnings as errors, RustSec audit in CI, checked against the NEAR contract audit checklist (callbacks, reentrancy, JSON integer types, unsaved changes, owner checks, one-yocto on sensitive calls, storage prefixes, init macro, unbounded loops). A Gemini 3.1 Pro audit on 6 Nov 2026 found 4 items; each was checked by a test (2 false, 1 fixed, 1 kept by owner decision), see `contract/README.md`.
- Reproducible build with a pinned image digest; the testnet code hash matches the build.
- CI: pinned action SHAs, read-only token, no persisted credentials, gitleaks over the full history.
- Dependencies are pinned to exact versions with lock files. Known advisory: `elliptic` (low severity), a transitive dependency of the attestation quote verifier `@phala/dcap-qvl`; it is not used to sign anything.
- RustSec: `RUSTSEC-2026-0387` (crypto-bigint timing) is ignored in `contract/.cargo/audit.toml` because it reaches the crate only through test code (k256 test vectors, near-sdk's unit-testing VM) and is not in the deployed wasm. Unmaintained-crate warnings: `unsafe-libyaml` comes from near-sdk's unit-testing VM only. `wee_alloc` is no longer linked. `near-sdk` is built with `default-features = false`, and the wasm uses Rust's built-in allocator (near-sdk issue 910). `lol_alloc` is not a dependency.
- Keys: NEAR account keys live in `~/.near-credentials` (outside the repo); throwaway certificate signer keys live in `.keys/` (gitignored). The NEAR AI Cloud key is never read by the code in this sandbox's runs; it is injected by a network proxy or read from `NEAR_AI_CLOUD_API_KEY`.

- Roles: admin, registrar, pauser and servicer are separate; a pause switch stops all state-changing calls of the flow.
- TEE verdicts: the attestation reports are published (`tee/fixtures/attestation-report-368aa2.json.b64` for the live registry `registry.tnlab-368aa2.testnet`, and `tee/fixtures/attestation-report.json.b64` for the earlier instance `registry.tnlab-718ca9.testnet`) and re-checkable with `npm run verify:attestation` (add `-- --contract registry.tnlab-718ca9.testnet` for the earlier one); every verdict is bound to one contract, network, version and a 30-day expiry.
- Pledges: every pledge needs the registered servicer secp256k1 key over a canonical message (contract, network, loan hash, fund account, asset type, nonce, expiry). Nonces are stored. Expired signatures are rejected. A refusal is not a blocked attempt and does not alert the fund named in the signature. If a pledge-ticket signer is registered, the same message also needs a ticket. The contract checks that signature and stores the sha256 of the signer's attestation evidence. `npm run verify:pledge-signer` re-checks the evidence file. The chain does not verify the hardware quote. The ticket does not prove loan holding. The publisher can ship another module version. The default fixture is a local stand-in, not a live quote.

See `TRUST_MODEL.md`, `THREAT_MODEL.md` and `AUDIT_FINDINGS.md`.

## Spend store runbook

The API keeps spent nonces and the buyer rate counter in one directory on one machine. Two machines, or two copies of the directory, can each accept the same nonce.

- The host must provide util-linux `flock`. Startup runs `/usr/bin/flock -x -w 1` and refuses to continue if that fails. Busybox `flock` is not accepted. `node` is the current executable, not a PATH lookup.
- One directory on one machine. Several API processes on that machine share the flock. Two machines, or two copies of the directory, do not.
- Pick a persistent path, not `/tmp`. Example: `/var/lib/truenav/spend`.
- `mkdir -m 700 /var/lib/truenav/spend`
- Initialize only with `node api/spend-init.mjs /var/lib/truenav/spend`. There is no environment flag that creates a store. Then set `TRUENAV_SPEND_STORE` to that directory and start the API.
- `chmod 700` the directory. The process refuses a group-writable or world-writable directory, a symlink store path, and a `LOCK` that is a symlink or a directory.
- The process exits if `TRUENAV_SPEND_STORE` is missing. It does not create an empty store on its own. A missing or corrupt `state.json` returns 503. The body is `{"error":"spend store closed"}`. The path is logged on the server only.
- Recovery from "spend store corrupt": stop the API, restore `state.json` from backup, confirm `READY` is still there, and start again. Do not delete `state.json` to get a fresh store. Deleting it and initializing again starts a new nonce list, so a nonce can be replayed until its proof expires.
- If the error says `LOCK` is a symlink or a directory: stop the API, remove that `LOCK` path only, leave `state.json` and `READY`, and start again.
- The IP limiter reads the socket address. It does not trust `X-Forwarded-For` unless `TRUENAV_TRUST_PROXY=1`. When that is set, the client address is `TRUENAV_PROXY_HOPS` from the right (default 1), never the leftmost. A client can prepend forged hops. Leave the flag unset unless the last hop is your proxy.

## Receipts v3 attestation records, local candidate

No hardware quote is validated on-chain. A stored proof locator is not an attestation verdict. Frozen v3 receipts remain immutable with attestation_ref=null. The callback separately binds canonical B through body_sha256. Only the designated OutLayer relayer can append proof records; storage is paid, existing records cannot be deleted or overwritten, and exact retries are idempotent. Admin writer rotation requires a pause and never changes old records.

Off-chain verification must check the public OutLayer proof against the receipt/body hashes, approved engine, original request input, signer/project, REPORTDATA, all worker measurements and Intel quote verification. No record or unavailable evidence means unavailable. Only a successful off-chain match may be labelled attested. No real v3 OutLayer proof has been produced by this local task.

The new method and storage are in round-1 audit scope before the upgrade: writer authorization and rotation, no permissionless proof slot, immutable receipt/body binding, composite keys, append-only indexes, idempotent replay, bounded references/pages, deposit/refund accounting and the off-chain trust boundary. A clean local test run does not substitute for that audit. See receipts/attestation/OUTLAYER_BODY_BINDING.md and UPGRADE_V3.md.

## Round 1 fix pass

`REDTEAM_R1.md` records the findings. High and medium code fixes:

- Pledge identity is domain `truenav-fp-v4`, length-prefixed: asset class, normalized collateral namespace (registry, jurisdiction, or issuer), and `document_root(collateral_ref)`. The pledge module and the NAV check MAC that preimage under key path `loan-terms-v2`. The document root is NFKC, Unicode lowercase, with whitespace, default-ignorable characters, variation selectors, and tags removed. A short Latin lookalike map folds Cyrillic and Greek copies. Suffixes such as `-copy` are not stripped. Principal, dates, and borrower are not in the hash. The same ref in two namespaces is two loans. The migration alias is a length-prefixed `truenav-fp-v1` frame for the same asset, namespace, and document. The engine reads it. It is not a second identity.
- A foreign lock at any lien rank sets `pledge_conflict` and caps the score at 59 red. The second-lien hold still applies. Ranked-lien sharing is not built. A tape principal that is not the signed `principal_cents`, or an origination date that is not the signed date, sets the public exception `terms_mismatch` (band `material`). That caps the score at 59 red and does not set `pledge_conflict`. Tape dollars become cents from the decimal text, not an f64 multiply. After rounding half away from zero, a cent amount at or above 2^53 is not used.
- v3 sources must carry a non-empty `fund_id`. An empty value is `source_scope_mismatch`, and the fixture signatures were recomputed. The execution body uses that `fund_id` with no `token_id` fallback. The matcher requires `context.fund_id` and rejects a mismatch with the envelope `fund_id`.
- Quotes must be Intel `UpToDate`. The proof `timestamp` is Unix seconds, the same unit `taskHash` writes as a little-endian u64. `QUOTE_RUN_WINDOW_SEC` binds that timestamp to the attested `valuation_time` (the field kept in the execution body): from 5 minutes before it through 60 minutes after it. Outside that window the match is `attestation_unbound`. `issued_at` is not in the body, so it is not the anchor. A receipt older than `RECEIPT_STALE_AFTER_SEC` (7 days) stays `attested`. The match reports `receipt_age_days` and `stale`. Age is not a validity failure.
- Attestation records are capped at 12 per receipt and 3 per attester, counted across writer rotation. A missing record returns `attestation_record_missing` and does not panic.
- A corrupt stored head does not start a run. The call returns `error: v3_receipt_corrupt` and `head_status: failed`, and refunds the deposit. A later failed run keeps the stored receipt for history and marks the live head failed (`get_latest` band red, `get_latest_receipt` `head_status: failed`) so a stale green envelope is not the current head.
- Public score and report responses, and v2 `get_receipt` text, omit `uncapped_score`, exact cent fields, and other fields outside the public allowlist.
- Token registration is capped at 64. `redeem` respects pause.
- A registry read with no lock is `completed: false`, so a missing pledge can surface as an incomplete read.

Migration: identity is now `truenav-fp-v4` over asset class, collateral namespace, and document root. Testnet pledge locks from earlier fingerprints will not match. Re-seed those locks on the upgrade. Every v3 source must be signed again with a non-empty `fund_id`. The known-answer source vector was re-signed. Derived receipt vectors were regenerated.

Stale pins, not rebuilt in this pass: `receipts/dist/truenav_receipts.wasm` (`b7fb827ac4d51cd2d92090fa5caea88b1e3a3a99c63103411303aa78eb7d1f47`), `receipts/dist/truenav_query.wasm` (`ec1f9f3a67e69b802efa7be64feee15ac869cf12a1e73014defaf45c52505156`), engine `0ffb3e314f2a3881bd28ab70cb9ba01a6f9b6f6fe41af8ef81b0455ce9ca8d38`, and fingerprint wasm `4a7c0e4ed5007ac6720b30906db4105bc302e35fb495003692225f630d1f07e3`. Rebuild and re-pin before any testnet upgrade. This commit does not deploy.

Pin refresh: `receipts/pinned-builds.json` and `receipts/v3-build.json` pin the hashes the pinned image produced in CI at `8cc9ede`: receipts `dcb46bd0645749948a72b42e5b35c670433a86e86a692e1947841c21129d2259` (555924 bytes), query `dee5f216c7ed6a0b75e597b2c5dce643dfcb88dc6517e71e85c5bb96f8169d09` (162201 bytes), engine v3 `61fe33a0299ae77fcb42c6d804f782845cbe5f50cb3153b3b43dbe45ea63f0bb` (byte length not recorded). Derived engine vectors were regenerated for that engine hash. The committed `receipts/dist/` files were not rebuilt and still hold the stale bytes above, so the deploy script refuses them. The fingerprint wasm is unchanged.

Residual: a fund that controls its own ids can rename a collateral ref. The defense is an external collateral identifier, namespace plus ref, that the signed source key attests. A rename inside that same external ref is one pledge. A renamed ref is a different identifier, and string suffixes are not treated as the same document. A failed OutLayer promise still refunds the forwarded deposit. Admission failure and a panic after admission look the same, and the admission path must still return the deposit. The contract account backup key is an operator removal, not a code change. The index `score` field remains a `u64`, so a JSON null score is still stored as 0. The v3 envelope keeps the null, and readers that use only the index should also read the envelope.
