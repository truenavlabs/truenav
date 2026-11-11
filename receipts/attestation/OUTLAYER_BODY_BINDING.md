# OutLayer body-hash binding, confirmed 9 Nov 2026

This confirmation used read-only public evidence. No new OutLayer run, deployment or transaction was made.

- Public testnet proof: https://testnet-api.outlayer.ai/attestations/by-call/018c52cc-8269-43a8-8f19-f67d6a6bb618 returned HTTP 200. Its output_hash equals SHA256 of the recorded public output in the existing fingerprint fixture. The freshly fetched quote is byte-identical to that recorded quote.
- Recomputing the existing OutLayer task hash matches REPORTDATA[0..32]; the other 32 bytes are zero. Changing output_hash breaks that binding. Intel quote verification with the existing pinned DCAP verifier returned UpToDate.
- The current NEAR execution path hashes the JSON value returned to the caller, then includes that output_hash in the task commitment passed to Intel TDX. Sources are pinned at upstream commit 3079d756a0be19e09d1c81f52336528d2603c11b: [worker hashing](https://github.com/out-layer/outlayer/blob/3079d756a0be19e09d1c81f52336528d2603c11b/worker/src/main.rs#L3689), [REPORTDATA construction](https://github.com/out-layer/outlayer/blob/3079d756a0be19e09d1c81f52336528d2603c11b/worker/src/tdx_attestation.rs#L187), [public lookup routes](https://github.com/out-layer/outlayer/blob/3079d756a0be19e09d1c81f52336528d2603c11b/API.md#L124).

B is the frozen execution object, excluding issued_at, attestation_ref and receipt_sha256. The v3 guest prints canonical B, without an extra newline. All object field names are fixed ASCII and public numbers are safe integers; the worker JSON parse/compact serialization preserves these canonical bytes. An isolated Rust helper copies the worker Json return path and hashes serde_json::to_string of its Value. It checks exact byte/hash equality against all four frozen goldens and every actual engine-derived envelope, temporal pair and conflict case. An intentionally noncanonical sentinel differs, so this is not an assumption of general equivalence. The test fails on any receipt mismatch; a mismatch would require a separate output hash in the record/matcher before use. The receipts callback stores SHA256(canonical(B)), not a hash of arbitrary transport whitespace or key order.

The existing proof confirms the protocol's output binding. It is a fingerprint execution, not a v3 engine execution. A genuine live v3 proof remains unverified until the owner separately approves that run and its artifact is checked. Native matcher success cases use explicitly simulated quote-verification capabilities, never fake live attestation claims.

## Option 3 interface

The frozen receipt and its digest never change. attestation_ref remains null. The callback stores a separate BodyBinding. A designated OutLayer relayer can append an AttestationRecord with token_id, seq, receipt_sha256, body_sha256, proof_ref, proof_scheme, attester and block_height.

- `set_attester(account: AccountId | null)`: admin, exactly one yocto, paused; null disables future submissions. It does not alter historical records.
- `get_attester()` returns the configured writer or null. No writer is configured by default.
- `get_body_binding(token_id, seq)` returns the authoritative callback hashes; seq is a decimal U64 string.
- `publish_attestation(token_id, seq, receipt_sha256, body_sha256, proof_ref, proof_scheme)`: designated writer only, unpaused, positive storage budget. Hashes must match the stored binding. Attach a conservative storage budget, suggested 0.05 testnet NEAR; only measured added storage is charged and the remainder is refunded. No quote bytes go on chain.
- `proof_scheme` is outlayer_tdx_v1. `proof_ref` for new on-chain records is a bounded public testnet OutLayer URL under /attestations/by-request/{id}, canonical decimal u64. Leading zeros and one trailing slash normalize to that form. The relayer resolves by-tx/by-call to a request ID before publication. Historical protocol readers can still fetch all three routes. It is a locator, not an on-chain verification verdict. No other origin, query, fragment, credential or redirect is accepted by the reader.
- The unique key is (token_id, seq, receipt_sha256, proof_ref). An exact resubmit returns the original record, original attester and block height, with no storage growth. A different locator appends a different record; it cannot overwrite an old one. There is no deletion or rewrite method, and no permissionless slot to occupy.
- `get_attestations(token_id, seq, from, limit)` returns append order, at most 100 records per page. No records means unavailable, never attested.

`matchPublicAttestation` is the backend evidence-matching component. It fetches only those public proof routes, rejects redirects and oversized responses, checks receipt and body hashes, expected engine, request input hash, original NEAR signer and project, the TDX task commitment, every approved worker measurement and the Intel quote. It returns attested only after all these checks; missing record/evidence returns unavailable. The public function has no injected quote-verdict override. Tests inject capabilities only at the internal module boundary.

The caller verifier must first anchor the receipt and record in finalized contract views and run its full frozen-schema/chain checks. Its context must come from the original execution request and approved worker registry, not the proof's own assertions. OutLayer input_hash is the hash of public stdin; receipt input_sha256 is a different, salted private-input commitment. Never equate them. OutLayer caller_account_id is the original proven NEAR signer, not necessarily the receipts predecessor used by the common-scope encryption-key manifest.

A verifier or feed can consume this component and these new views; the verifier is outside this repository. No hardware quote is validated on-chain. This method, its role/configuration, callback body binding, append-only storage/index, refunds, idempotency, reference restrictions and verifier boundary are mandatory round-1 audit scope before any upgrade.

## No-key replay

`node receipts/attestation/check-protocol.mjs --recorded` reproduces the existing public output/REPORTDATA binding without network access. It explicitly skips a fresh Intel collateral check. `node receipts/attestation/check-protocol.mjs --fetch` reads the public proof and Intel collateral, checks the signature/UpToDate verdict and never executes an OutLayer job. Neither command takes an account or signing key. The live read was verified for this task; it is not a v3 engine run.

Receipt policy is selected strictly by method_version: v3.0.0 uses only rc3 and its artifact; v3.0.1 uses only the versioned amendment schema/artifact. A v3.0.0 pledge_conflict cap rejects. SourceRegistrySession provides an explicit fixture or live trust context; it rejects duplicate IDs, rebound public keys and mixed registries. The caller verifier must integrate these helpers, finalized anchoring and full schema/chain/signature validation. Its folder is unchanged.
