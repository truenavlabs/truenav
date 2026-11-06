# TrueNav test registry contract (testnet only)

A NEAR contract in Rust (near-sdk 5.30.1) that holds what the score engine cannot prove on its own:

- **Signer registry.** The admin adds and removes the secp256k1 addresses allowed to sign score certificates. Addresses rotate, so they are data, never hardcoded.
- **Fund registry.** The admin binds each `fund_id` to its NEAR account and `manager_id`. A certificate is accepted only for a registered `fund_id` whose account and manager match. A fund cannot rename itself to escape its history (score engine hole 5).
- **Signed score certificates.** The engine's output is signed off chain with EIP-191 `personal_sign` over a canonical message (below). The contract recovers the signer with `env::ecrecover`, checks it is registered, checks `signed_at_ms` moves forward per fund, and stores the certificate. `get_certificate_history(fund_id)` is the engine's cert store for `previously_certified`.
- **Loan pledges as NEP-171 tokens.** A registered fund pledges a loan by its 64-hex hash. The first pledge locks the loan and mints a token to the fund (`token_id` = loan hash). A pledge by another fund is refused with "already pledged elsewhere", counted against the attempting fund (`get_attempts`), and raises an alert for the holder (`get_alerts`, time only). The servicer releases a repaid loan, which burns the token. Pledge tokens cannot be transferred. Mint and burn emit the standard NEP-171 `nft_mint` and `nft_burn` events, so wallets and explorers can show the tokens; a refused pledge emits no token event.

All state is public chain state. Alerts and attempts do not name the other fund, but nothing here is private. The sealed registry design (OutLayer TEE) is the private version.

## Canonical certificate message

Fields joined with `|`, in this order:

```
truenav-cert-v1 | contract_id | fund_id | fund_account | manager_id | status | score (empty if none) | band |
raw_x100 | true_val_cents | true_range_cents | policy_nav_cents | headline_cents | blocked_attempts |
data_asof_ms | signed_at_ms | engine_commit
```

The digest is `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`. Money is integer cents and raw is hundredths, so the signed bytes have no floating point. The contract id is inside the message, so a certificate cannot be replayed on another deployment. `fund_id`, `manager_id` and `engine_commit` may not contain `|`, so no two different certificates share one message.

## Methods

| Method | Who | What |
| --- | --- | --- |
| `new(admin, servicer)` | deployer | init |
| `add_signer(address)`, `remove_signer(address)` | admin | signer registry |
| `register_fund(fund_id, account_id, manager_id)` | admin | binds fund_id |
| `submit_certificate(certificate, signature)` | anyone | verify and store; panics on any failure |
| `pledge_loan(loan_hash, asset_type)` | registered fund account | returns `pledged`, `already_yours` or `refused` |
| `release_loan(loan_hash)` | servicer | unlock and burn on repay |
| views | anyone | `get_signers`, `get_fund`, `get_latest_certificate`, `get_certificate_history`, `get_lock`, `get_attempts`, `get_alerts`, `nft_token`, `nft_metadata` |
| NEP-181 views | anyone | `nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner` |
| paged views | anyone | `get_certificate_count`, `get_certificate_history_page(fund_id, from_index, limit)`, `get_attempts_page(...)`, `get_alerts_page(...)`, `get_alert_count`; `limit` is capped at 100. Use these for long lists so a view call never runs out of gas. |

## Test

```
cd contract
cargo test
```

30 unit tests, native target, no network after crates are fetched. The tests sign with a fixed throwaway secp256k1 key that exists only inside the tests; it holds no value and is not a NEAR account key.

## Storage

The contract's own balance pays for all storage: pledges, tokens, attempts, alerts and certificates. Callers attach no deposit. Only admin-registered fund accounts can pledge, so a hostile caller must first be registered. For the testnet demo the contract pays (owner decision 6 Nov); revisit before any mainnet use.

## Build

Needs Rust 1.95 or newer (near-sdk 5.30.1), the `wasm32-unknown-unknown` target and cargo-near 0.23.0. `env::ecrecover` needs near-sdk's `unstable` feature, which `Cargo.toml` enables.

```
rustup target add wasm32-unknown-unknown
cargo install cargo-near --version 0.23.0 --locked
cd contract && cargo near build non-reproducible-wasm
```

Output: `contract/target/near/truenav_registry.wasm` (about 284 KB) plus its ABI. cargo-near's default `ledger` feature needs the system package `libudev-dev` (and `pkg-config`) on Linux.

Deploy goes to a throwaway testnet account (see the main README, Testnet run). Never mainnet.

## Audit (6 Nov 2026)

Gemini 3.1 Pro audited this contract. Each finding was checked with a test in `tests/registry.rs` (tests named `audit_*`):

| Finding | Result |
| --- | --- |
| pledge_loan panics without a deposit | false: the mint passes no refund account; `audit_1` pledges with 0 deposit |
| refused pledges grow storage the contract pays for | true as described; `audit_2` pins it; the owner chose: contract pays for the demo |
| full-list views may run out of gas | plausible for long lists; paged views added (`audit_3_*`) |
| release_loan keeps a deposit it should refund | false: no deposit was taken; `audit_4` |
| own review: a pipe inside a field | fixed; `audit_pipe_*` |
