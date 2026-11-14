# Roles, keys, security and known limits

[Back to the README](../README.md). Chain figures and dates are as stated in each row.

## Roles and keys

- **admin** assigns roles and registers funds. **registrar** adds and removes certificate and TEE signers. **pauser** pauses and unpauses. **servicer** releases repaid loans and submits TEE verdicts. Each role is refused every other role's job.
- The certificate signer on the current testnet instance (`registry.tnlab-368aa2.testnet`) and on the earlier instance is a test key, not a TEE key. The engine is public and deterministic, so anyone can recompute the numbers from the same inputs.
- The TEE signer is registered by the registrar after an off-chain attestation check that anyone can repeat (`npm run verify:attestation`). The contract does not verify the hardware quote itself.
- Live instance: `get_roles` on 14 Nov 2026 (testnet RPC, finality `final`) returns admin and registrar `tnlab-368aa2.testnet`, pauser `pauser.tnlab-368aa2.testnet`, servicer `servicer.tnlab-368aa2.testnet`. Key counts were last read with `view_access_key_list` on 12 Nov 2026 (not re-read today, unverified for this date): `registry.tnlab-368aa2.testnet`, `tnlab-368aa2.testnet`, `servicer.tnlab-368aa2.testnet` and `pauser.tnlab-368aa2.testnet` each had 1 full-access key and no function-call keys. CI job `judge-path` checks the registry and its parent account with `npm run rt17:check`. Role calls attach 1 yoctoNEAR, so role holders use full-access keys.
- The registry contract has no upgrade method. The 1 full-access key on `registry.tnlab-368aa2.testnet` is its upgrade authority: whoever holds it can deploy new code to that account.
- The default live reads, the demo and `npm run judge` do not use the earlier instance (`tnlab-718ca9`); CI re-reads its recorded history in separate, labelled earlier-instance steps.
- The demo agent, when used on testnet, signs with its own account. It refuses the master, `receipts.`, `query.`, `runner.` and `api.` accounts. `runAgent` buys nothing unless it is called with `execute: true`.
- Never put a seed phrase or private key in the repo, in chat, or in a command.

## Security and limits

- Testnet and fictional data only. Fixture keys are publicly derivable test keys for reproducibility. PD tables are demo. TrueRange assumes independent defaults.
- TrueNav informs only. A red score is information. It does not block a subscription, a redemption, or any other transfer.
- TEE eval limits (from `tee/eval/REPORT.md`): 126 synthetic documents in a small set of templates, written by the same team that wrote the prompt. Real loan documents vary far more. One model, one prompt, one run each. A perfect score here means no failure was found in these documents, not that the underwriter cannot fail.
- `vault/` is leftover circuit-breaker code from an earlier design and is not part of the product or the demo.
- A TEE proves which code ran, not that the model's judgment is right. The underwriter is an LLM.
- The only on-disk state of the API in `api/` is its spend store (`api/spend-store.mjs`). Demo documents are fictional and committed so judges can replay them.
- Pledges, verdicts, attempts, alerts and certificates are public chain state, not hidden. A refused pledge returns `already pledged elsewhere` without naming the fund that holds the loan (transaction `8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs` above).
- TEE signer registration and certificate signing are phase-1 trust: registrar and operator keys, not on-chain quote verification. Stated in `TRUST_MODEL.md`.
- OutLayer is a young dependency. If OutLayer accepts a run and its callback then fails, the receipts contract refunds 0.01 NEAR from its own balance in both that case and a refused run (RT-13, accepted).
- `@phala/dcap-qvl` 0.7.0 pulls `elliptic` (2 low findings on `npm audit --omit=dev`). The full `npm audit`, including devDependencies such as ganache, reports more issues; that is not a production-audit claim.
- More: `AUDIT_FINDINGS.md`, `REDTEAM_R1.md`, `SECURITY.md`, `THREAT_MODEL.md`, `TRUST_MODEL.md`.

### Known limits and disclosures

Open items, all Low or Info. None of them changes the offline judge path. Chain figures are testnet RPC reads on 12 Nov 2026.

| Item | What is true today | Where | Status |
| --- | --- | --- | --- |
| TLS binding | When a report carries `tls_cert_fingerprint`, it is folded into the report-data check. It is not compared with the certificate of the live HTTPS connection to NEAR AI Cloud. | `tee/attest.mjs` | Not checked |
| Image provenance and measurement pins (N-06) | MRCONFIGID is compared with the report's own `app_compose`, and RTMR3 with the report's own event log. MRTD, RTMR0 to RTMR2 and the compose hash are not compared with published expected values, and container image provenance is not checked. The OutLayer receipts path does pin all five measurements (`receipts/attestation/match-core.mjs`). | `tee/attest.mjs` | Open, Low |
| NVIDIA GPU token (N-05) | The NRAS reply token is decoded and `x-nvidia-overall-att-result` is read. Its signature, issuer, expiry, nonce claim and the per-GPU tokens are not verified; TLS to NVIDIA is the only anchor. | `tee/attest.mjs` | Open, Low |
| Shared certificate signer and pledge key (N-07) | On `registry.tnlab-368aa2.testnet`, `get_signers` and `get_servicer_pledge_key` return the same address, `0x6994c1391f4244185497aa2afa8e14f5790314b0`, a test key. The domain prefixes `truenav-cert-v1` and `truenav-pledge-v1` stop a signature for one being used as the other, so this is role concentration, not a bypass. | `contract/src/lib.rs` | Open, Low |
| Expired verdicts stay latest on chain (N-02) | `get_latest_verdict` (`latest_for_pledge`) returns the latest verdict for the current pledge even after its `expires_at_ms`. The contract is unchanged. The clients treat an expired verdict as expired: `npm run chain:read`, the web chain loader and the scoring engine report it as `expired`, not as a pass, and the loan as unverified (`TEE verdict expired`). | `contract/src/lib.rs`, `web/chain.mjs`, `engine/src/score.mjs` | Disclosed; handled by clients |
| TEE signer age | A registered TEE signer has no expiry or age check on chain. Each verdict binding may expire at most 30 days (plus a 1 hour margin) after it is submitted, and the registrar removes a signer by hand. | `contract/src/lib.rs` | Open |
| Upgrade authority key | One full-access key on `registry.tnlab-368aa2.testnet` can replace the contract code. No multisig or DAO. | Roles and keys above | Disclosed |
| Storage headroom (N-01) | `registry.tnlab-368aa2.testnet` has a balance of 3.9969356929043999 NEAR and uses 399065 bytes (RPC `view_account`, 14 Nov 2026, 15:56 Asia/Bangkok). At 1e19 yoctoNEAR per byte that leaves about 628 bytes (about 0.0063 NEAR). The next write, such as a new verdict or certificate, is likely to fail until the account is topped up. Reads are not affected. | RPC `view_account` | Open, Low |
| RT2-01 | The committed `receipts/dist` wasm files do not match the pins in `receipts/pinned-builds.json`, so `receipts/deploy-testnet.mjs` refuses them (sha256 re-checked 12 Nov 2026; the refusal is tested in `receipts/tests/deploy-args.test.mjs`). `tests/security/rt2-pins.test.mjs` checks that every copy of the engine v3 pin and the receipts pin agree. | `receipts/` | Open |
| RT2-02 | `stamp_failure` in `receipts/src/lib.rs` treats a stored head as failed by searching its text for `"head_status":"failed"` instead of parsing it. For v3, the schema sets `additionalProperties: false` on every object, so a nested `head_status` key is refused before storage. `receipts/tests/rt2_n6.rs` checks that refusal at every object path of the golden v3 vectors; it runs under `cargo test` in `receipts/` (CI), and was not run locally. | `receipts/src/lib.rs` | Info, not fixed |
| RT2-07 | `/report` reads the latest head once, then redeems. If that head is failed, it returns 409 and redeems nothing (tested). If a new failed head is stored after that read and before the redeem, the use is spent and the reply is the earlier good receipt it read. `tests/security/rt2-report-race.test.mjs` (in `npm test`) records this behaviour. | `api/server.mjs` | Info, not fixed |
| RT2-08 | `plainCallArgs` checks the call arguments and returns the same object, so a getter could return a different value when the arguments are serialized. Current callers pass literals. `tests/security/rt2-call-args.test.mjs` (in `npm test`) checks its refusals of cycles, `Map`, `Set`, `Date`, boxed values, functions, `toJSON` and `Infinity`, and records the getter behaviour. | `certify/call-args.mjs` | Info, not fixed |
