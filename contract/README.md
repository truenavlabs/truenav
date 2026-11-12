# TrueNav test registry contract (testnet only)

A NEAR contract in Rust (near-sdk 5.30.1) that holds what the score engine cannot prove on its own:

- **Signer registry.** The admin adds and removes the secp256k1 addresses allowed to sign score certificates. Addresses rotate, so they are data, never hardcoded.
- **Fund registry.** The admin binds each `fund_id` to its NEAR account and `manager_id`. A certificate is accepted only for a registered `fund_id` whose account and manager match. A fund cannot rename itself to escape its history (score engine hole 5).
- **Signed score certificates.** The engine's output is signed off chain with EIP-191 `personal_sign` over a canonical message (below). The contract recovers the signer with `env::ecrecover`, checks it is registered, checks `signed_at_ms` moves forward per fund, and stores the certificate. `get_certificate_history(fund_id)` is the engine's cert store for `previously_certified`.
- **Loan pledges as NEP-171 tokens.** A registered fund pledges a loan by its 64-hex hash. The call carries a signature from the registered servicer pledge key over `truenav-pledge-v1|contract|network|loan_hash|fund_account|asset_type|nonce|expiry`. The first pledge locks the loan and mints a token to the fund (`token_id` = loan hash). A pledge by another fund is refused with "already pledged elsewhere". That refusal does not increment `get_attempts` and does not raise `get_alerts`. When a pledge-ticket signer is registered, the same message also needs a ticket. The servicer releases a repaid loan, which burns the token. Pledge tokens cannot be transferred. Mint and burn emit the standard NEP-171 `nft_mint` and `nft_burn` events, so wallets and explorers can show the tokens; a refused pledge emits no token event.

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

Sensitive calls need exactly 1 yoctoNEAR (only a full-access key can make them). Pause stops the calls marked (p).

| Method | Who | What |
| --- | --- | --- |
| `new(admin, servicer)` | deployer | init; registrar and pauser start on the admin |
| `set_role(role, account_id)`, `get_roles()` | admin / anyone | roles: admin, registrar, pauser, servicer |
| `pause()`, `unpause()` | pauser | emergency stop |
| `register_fund(fund_id, account_id, manager_id)` | admin | the fund allowlist; binds fund_id |
| `add_signer`, `remove_signer` | registrar | certificate signers |
| `add_tee_signer(address, model_id, attestation_ref, attestation_sha256)`, `remove_tee_signer` | registrar | TEE signers, with the published attestation report hash |
| `submit_certificate(certificate, signature)` (p) | anyone | verify and store a signed certificate |
| `pledge_loan(loan_hash, asset_type, fund_account, nonce, expiry_ms, servicer_signature, ticket_signature)` (p) | registered fund account named in the servicer signature | `pledged`, `already_yours` or `refused`. A valid signed double pledge is an attempt on that fund. An unsigned squat is not recorded. |
| `release_loan(loan_hash)` (p) | servicer | unlock and burn on repay |
| `submit_verdict(loan_hash, model_id, request_sha256, response_body, signature)` (p) | servicer | TEE verdict on a pledged loan; the reply may hold only the allowed keys and value types (`reply_problem`, checked first, because the arguments are public); binding `truenav-verdict-v1\|contract\|network\|expiry` checked; a flag clears only with a pass from a new request |
| views | anyone | `get_signers`, `get_tee_signers`, `get_fund`, `get_latest_certificate`, `get_certificate_count`, `get_certificate_history_page`, `get_lock`, `get_attempts_page`, `get_alerts_page`, `get_alert_count`, `get_latest_verdict` (current pledge only), `get_verdict_count`, `get_verdicts_page`, `get_flag_count`, `nft_token`, NEP-181 views, `nft_metadata` |

## Fresh account (no migration)

The Borsh layout changed when pledge nonces, pledge signers, and `ticket_required` were added. There is no migration. The earlier instance `registry.tnlab-718ca9.testnet` cannot be upgraded in place; the live registry was deployed fresh to `registry.tnlab-368aa2.testnet` by these steps. Each step below is a separate yes from the owner. Do not run them in this pass.

1. Owner approval: create a new testnet account for the registry. Do not reuse the earlier instance `registry.tnlab-718ca9.testnet` or the live `registry.tnlab-368aa2.testnet`.
2. Owner approval: deploy this contract wasm to that empty account with `new(admin, servicer)`. State starts empty.
3. Owner approval: `set_role` for registrar, pauser, and servicer.
4. Owner approval: `register_fund` for each demo fund.
5. Owner approval: `set_servicer_pledge_key` to the servicer secp256k1 address.
6. Owner approval, only if tickets are wanted: `add_pledge_signer`. This sets `ticket_required` permanently. Removing the last signer does not turn the requirement off.
7. Owner approval: point readers at the new account. Do not expect the old account's state to load.

## Test

```
cd contract
cargo test
```

106 unit tests (`cargo test`, 87 `#[test]` functions; the role tests in `tests/roles.rs` expand to 24), native target, no network after crates are fetched. The tests sign with a fixed throwaway secp256k1 key that exists only inside the tests; it holds no value and is not a NEAR account key.

## Storage

The contract's own balance pays for all storage: pledges, tokens, attempts, alerts and certificates. Callers attach no deposit. Only admin-registered fund accounts can pledge, so a hostile caller must first be registered. For the testnet demo the contract pays (owner decision 6 Nov); revisit before any mainnet use.

## Build

Needs Rust 1.95 or newer (near-sdk 5.30.1), the `wasm32-unknown-unknown` target and cargo-near 0.23.0. `env::ecrecover` needs near-sdk's `unstable` feature, which `Cargo.toml` enables.

```
rustup target add wasm32-unknown-unknown
cargo install cargo-near --version 0.23.0 --locked
cd contract && cargo near build non-reproducible-wasm
```

Output: `contract/target/near/truenav_registry.wasm` plus its ABI. A local host (non-reproducible) build measured on 11 Nov 2026 was 364904 bytes; that is not a pinned-image / NEP-330 size. cargo-near's default `ledger` feature needs the system package `libudev-dev` (and `pkg-config`) on Linux.

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
