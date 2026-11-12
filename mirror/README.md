# Base Sepolia receipt mirror

Build and test implementation, not a deployed mirror. All data is synthetic. No live signing, deployment, faucet
request, broadcast or confirmation was performed for this feature. The query contract is unchanged.

## What is signed

The NEAR receipts contract takes only a token id, stored sequence and fee. It reads the already-stored receipt and
constructs ABI calldata for `update(bytes32,uint256,bytes32,uint8,uint8,bytes32,uint64)`:

- SHA-256 of the UTF-8 token id; sequence; the stored callback-byte SHA-256 receipt hash;
- score, band (red 0, yellow 1, green 2), SHA-256 of the UTF-8 method id, UTC Unix milliseconds.

It builds the typed EIP-1559 signing bytes and Keccak-256 hash in Rust: chain 84532, the configured fixed mirror
address, zero value, gas limit 150000 and an empty access list. The selected fee in wei is both max fee and max
priority fee. Configuration rejects other chains and caps fees at 100 gwei or the lower configured cap. A replacement
must increase the fee (choose a sufficient replacement bump for the Base node). No caller can supply calldata,
recipient, selector, value, gas limit, nonce, method or timestamp. The signer path is always `truenav-mirror-v1`.

Admin calls require one yoctoNEAR and an unpaused contract: `set_mirror_config`, `request_mirror`, `resign_mirror`,
`clear_mirror_signing`, `confirm_mirror`. The contract forwards one yoctoNEAR to the signer. Mirror storage is funded by the contract's
balance, under admin control; check storage headroom before enabling it. Mirror state uses `mirror:v1:*` raw keys.
The existing `Receipts` struct, collection prefix order and OutLayer callback are unchanged. A regression test loads
an independent pre-mirror layout and checks identical root-state bytes after configuring and requesting a mirror.

## Nonces, retries and confirmation

Only one nonce can be pending globally. It begins at zero for this new derivation path. `request_mirror` stores the
nonce, sequence, target, immutable calldata and unsigned transaction. `resign_mirror(nonce, fee)` preserves all fields
except the two fee fields. It requires a higher fee within the cap and waits for the prior signing callback to finish.
There are at most 16 signing attempts per nonce, bounding storage; reaching this limit or the cap can stall the lane.
Signer failures preserve the pending nonce. There is deliberately no skip, arbitrary-payload signing or fallback path.

If a signing callback never completes, the admin can call `clear_mirror_signing(nonce)` with one yoctoNEAR while
unpaused. It clears only the signing flag of the pending nonce, preserving the nonce, immutable calldata and every
stored unsigned payload. A late callback is ignored after clearing; after a higher-fee retry its old attempt index
cannot clear or overwrite the new attempt. Clearing does not confirm the nonce or bypass the fee/attempt limits.
Receipt validation rejects impossible Gregorian dates, pre-epoch timestamps and out-of-range clock values before
storage, so they cannot reach the mirror's nonnegative Unix-millisecond conversion.

The private callback accepts a bounded signer response, verifies recovery against the configured derived public key,
normalizes high-S signatures, stores the complete signed transaction, and emits `mirror_signed` with its bytes and
Keccak-256 transaction hash. Every signed replacement is retained: an earlier one may be the one that lands.

`confirm_mirror(nonce, tx_hash)` is admin-only and accepts only the Keccak-256 hash of a stored signed transaction for
that nonce. Only confirmation releases the next nonce. The confirmer script waits for a successful receipt, a
`finalized` block at or above its height and a matching canonical block hash before sending the confirmation from
the dev admin account. It rechecks finality every 15 seconds for at most one hour, leaving the nonce pending on timeout.
It never treats a reverted transaction as a successful update. NEAR trusts the admin for Base finality, not for the
mirrored data; see `TRUST_MODEL.md`.

The Solidity contract has an immutable MPC-derived address, no owner override, and requires strictly increasing
sequence per token. A stale receipt can revert on Base; select a stored sequence newer than the last mirrored one.
Read `latest` and the derived address's transaction count and gas balance before preparing a request.

## Verified signer interface and sources

Read-only testnet observations on 9 Nov 2026 Bangkok:

- `public_key({domain_id:0})`, `derived_public_key({domain_id:0,path,predecessor})`, `config({})` and `state({})` answered.
- Domain 0 is ECDSA, purpose `Sign`. The live config requires at least 15 Tgas for a signing call. This contract
  attaches 100 Tgas and reserves 35 Tgas for its private callback.
- Local address derivation matches the live derived-key view for `receipts.tnlab-718ca9.testnet` (the earlier instance's receipts account; there is no receipts contract on the live 368aa2 registry) and this path:
  `0x34dc6299b7a1a491f915cc2c5d8ff3038e9f72cc`. Recheck for the actual deployed account before configuration.
- Source-verified request: `sign({request:{path,domain_id:0,payload_v2:{Ecdsa:"<64 lowercase hex>"}}})`, deposit one
  yoctoNEAR. The current source also accepts deprecated `payload` byte-array and `key_version` aliases; this feature
  uses the current names. The secp256k1 response has `scheme: "Secp256k1"`, `big_r.affine_point` (33-byte compressed
  point as hex), `s.scalar` (32-byte hex) and `recovery_id`. The callback also accepts the untagged legacy shape.
- Actual live `sign` execution and its returned signature are UNVERIFIED: no write call was authorized or made.
  The observed live views do not independently prove a source-to-deployed-bytecode match.

Sources: [NEAR signing guide](https://docs.near.org/chain-abstraction/chain-signatures/implementation),
[contract signing code](https://github.com/near/mpc/blob/cfa4b83ed9d6c11e8fa1dccdaffc3f8ff136d52e/crates/contract/src/api/sign.rs),
[request schema](https://github.com/near/mpc/blob/cfa4b83ed9d6c11e8fa1dccdaffc3f8ff136d52e/crates/near-mpc-crypto-types/src/sign.rs),
[deposit](https://github.com/near/mpc/blob/cfa4b83ed9d6c11e8fa1dccdaffc3f8ff136d52e/crates/near-mpc-contract-interface/src/deposits.rs),
[derivation](https://github.com/near/mpc/blob/cfa4b83ed9d6c11e8fa1dccdaffc3f8ff136d52e/crates/near-mpc-crypto-types/src/kdf.rs),
[public-key views](https://github.com/near/mpc/blob/cfa4b83ed9d6c11e8fa1dccdaffc3f8ff136d52e/crates/contract/src/api/keys.rs),
[signature schema](https://github.com/near/mpc/blob/cfa4b83ed9d6c11e8fa1dccdaffc3f8ff136d52e/crates/near-mpc-crypto-types/src/primitives.rs).
The root key plus SHA3-256 tweak for the NEAR predecessor and path derives the child secp256k1 public key;
Keccak-256 of its uncompressed coordinates gives the EVM address. SHA3-256 and Keccak-256 are distinct here.

## Local checks

```bash
npm ci
npm test
node mirror/compile.mjs
cargo +1.99.0 test --locked --manifest-path receipts/Cargo.toml
cargo +1.99.0 clippy --locked --manifest-path receipts/Cargo.toml --all-targets -- -D warnings
cargo +1.99.0 test --locked --manifest-path mirror/mock-signer/Cargo.toml
cargo +1.99.0 clippy --locked --manifest-path mirror/mock-signer/Cargo.toml --all-targets -- -D warnings
node mirror/vectors.mjs
```

The Node tests compile Solidity with pinned solc-js, deploy only to an in-process EVM, verify MPC-only updates,
sequence rejection and events, and broadcast a signed fixture to that local EVM. Rust compares ABI bytes, RLP,
signing hashes and signed transaction bytes to the committed viem vectors, including RLP boundaries and UTC dates.
The deterministic signing fixture is public and disposable; it is not an operator credential.

For a machine whose hard nofile limit permits 65535, build `receipts`, `receipts/mock-outlayer` and
`mirror/mock-signer` in the pinned image using `cargo near build non-reproducible-wasm --locked`, then:

```bash
ulimit -n 65535 && npm run e2e:mirror
```

This tests stored receipts through a mock OutLayer and a mock signer at the fixed signer account in a local genesis,
including callback privacy, signature validation, nonce serialization, fee replacement and exact-hash confirmation.
Do not deploy the mock signer on any live network. Local sandbox execution remains unverified in this environment:
the hard nofile limit is 16384. `e2e:receipts` is also skipped here for that limit. Cloud verification must run both.

## Operator scripts (not run live)

`mirror/derive.mjs <receipts-account.testnet>` performs public testnet views and cross-checks local address derivation.
Save `mirror_signed` log strings from the correct receipts account's finalized NEAR transaction as a JSON array.
Both scripts validate the signature, chain, recipient, zero value, gas limit, fees and update selector. Defaults are
dry-run. Neither script owns an EVM key; the derived account's signature is already in the NEAR event.
The mirror and derived addresses come from the receipts contract's `get_mirror_config`, with the derived key checked
against the signer's own derivation; `--mirror` and `--mpc` are optional assertions, and a differing one stops the
script. The Base RPC is read from `BASE_RPC_URL` only (never the command line), and every RPC error prints a fixed
line such as `base rpc error: HttpRequestError`, never a URL, host, path or query. The confirmer treats a transaction
not yet mined, or a receipt from a block that is no longer canonical, as not final and checks again.

```bash
TRUENAV_RECEIPTS_ACCOUNT=<receipts-account.testnet> node mirror/broadcast.mjs <logs.json> [--mirror 0x..] [--mpc 0x..]
TRUENAV_RECEIPTS_ACCOUNT=<receipts-account.testnet> node mirror/confirm.mjs <logs.json> [--mirror 0x..] [--mpc 0x..]
```

Only after separate approval, `--execute` broadcasts or confirms; both then need `BASE_RPC_URL`
(`BASE_RPC_TIMEOUT_MS` optional, default 10000). The confirmer also requires `TRUENAV_ADMIN_ACCOUNT` and
`TRUENAV_SIGNER_KEYFILE` (a matching testnet admin credential outside the repo).
Never print or commit that file. The broadcaster checks sufficient ETH for the maximum transaction gas cost.

## Later approvals, one at a time

1. Review and approve the exact receipts upgrade artifact, including the pending gas-cap change. Confirm unchanged
   state and sufficient storage balance. Do not replace query code.
2. Deploy `TrueNavMirror` on Base Sepolia with the verified derived address as its immutable constructor argument.
3. Fund only that derived address with an approved amount of Base Sepolia ETH. Suggested initial demo allowance:
   0.02 testnet ETH. At the absolute 100-gwei cap and 150000 gas, one transaction's maximum is 0.015 testnet ETH;
   a lower configured cap reduces this bound. No faucet request or funding has been performed.
4. Set `set_mirror_config` on NEAR with chain 84532, the deployed mirror address (40 lowercase hex, no `0x`), the
   chosen fee cap in wei and the derived public key (128 lowercase hex, no `04` prefix). Check the EVM nonce is zero.
5. Approve the first `request_mirror` for an existing stored receipt and its fee, broadcast its signed event, verify
   the emitted fields, wait for finalized success, then confirm the exact transaction hash from the dev admin.

Any relayer-only fallback changes the locked design and requires a stop and report before implementation.
