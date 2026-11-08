# engine-v2: pinned, reproducible build

The TrueNav cashflow-v2.1.0 scorer as an OutLayer WASI P2 component. It is the same method as the JS reference
(`cashflow/`, `spec/v2/score.mjs`). The four raw-data parity fixtures (`cashflow/fixtures/parity/`) come out byte for
byte identical on canonical JSON (`cargo test --test parity`).

## Build

Pinned image (by digest), pinned toolchain, `--locked`:

```bash
IMG='sourcescan/cargo-near:0.22.0-rust-1.99.0@sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e'
chmod -R a+rwX .   # the image runs as uid 1000 and writes target/
docker run --rm -v "$PWD":/src -w /src/outlayer/engine-v2 -e RUSTUP_TOOLCHAIN=1.99.0 "$IMG" \
  bash -c 'rustup target add wasm32-wasip2 && cargo build --release --locked --target wasm32-wasip2'
sha256sum outlayer/engine-v2/target/wasm32-wasip2/release/truenav-engine-v2.wasm
```

Behind a TLS-intercepting proxy, also mount its CA and pass the proxy variables
(`-v <ca>:/ca.crt:ro -e SSL_CERT_FILE=/ca.crt -e CARGO_HTTP_CAINFO=/ca.crt -e HTTPS_PROXY --network host`). That only
affects downloads, not the output.

## Recorded result (source commit 9138f10, method cashflow-v2.1.0; BUILD.md is not a build input)

| | |
|---|---|
| wasm sha256 | `360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57` |
| size | 579642 bytes |
| check | two fresh clones, mounted at different absolute paths (`/src/a` as root, `/work/b-other` as the image user), same sha256; CI rebuilds it and fails if the hash differs from this table |
| previous | `6d1eac8911d751c4baf877d14c4357862c09b38aaa52d2245aec6815f4e59601` (f74661a, before the field validation and the TEE-derived new_period), `fce34e79...` (7ef4423, cashflow-v2.0.0), `a74d6976...` (214dae9); none uploaded |

The only absolute paths in the binary are the image's own registry paths (`/home/near/.cargo/registry/...`), which the
pinned image fixes. A change to a build input under `outlayer/engine-v2/` (`src/`, `Cargo.toml`, `Cargo.lock`, `wit/`) changes the hash, so
this table is updated with every engine commit that is meant to be deployed.

## What the component imports

`wasi:cli`, `wasi:clocks`, `wasi:io`, `wasi:random/insecure-seed` (std hash map seed; nothing in the output depends on it), `wasi:http/outgoing-handler` (the bank fetch) and
`outlayer:encryption-keys/api@0.1.0` `mac` (pseudonyms, under the project key `truenav-ref`, see `manifest.json`).

## Runtime contract

Secrets (env vars, stored with `outlayer secrets set`, never in input): `TRUENAV_DATA_URL`, `TRUENAV_DATA_TOKEN`.
The TEE fetches `GET {TRUENAV_DATA_URL}/v1/tokens/{token_id}/{bank-feed|manager-export|issuer-claims}` itself with
`Authorization: Bearer {TRUENAV_DATA_TOKEN}`. In the demo the server is the mock bank-data API
(`cashflow/mockbank/server.mjs`), synthetic data only.

Public input (JSON on stdin), unknown fields refused:

```json
{ "token_id": "DEMO-CREDIT", "run_nonce": "<32 to 128 hex>", "as_of": "2026-11-01T00:00:00Z",
  "previous": [{ "source": "bank_settlements", "snapshot_sha256": "<hex>", "as_of": "..." }], "previous_period": "2026-09" }
```

`as_of`, `previous` and `previous_period` are optional; `previous` needs `previous_period`. The receipt contract builds
this input itself: `token_id` from `request_run`, its own `run_nonce`, and `previous` / `previous_period` from its own
last stored receipt for the token. It never sends `as_of`, so the receipt's `as_of` is the TEE clock. `new_period` is
not an input: the TEE sets it when `previous_period` differs from the issuer's period it fetched. Timestamps may carry `Z` or a `+HH:MM` / `-HH:MM` offset and are normalized to UTC; the receipt's `as_of` is always `...Z`.

Output (stdout), one canonical JSON object, at most about 3.3 KB for the demo funds:

- on success, the receipt only: method, token id, run nonce, period, score, band, parts, caps, holds, public metrics
  (cohorts under 5 suppressed; collection status, period, cutoff, dues and verified cents, rate), evidence passport (source snapshot hashes and freshness), checks run, exception and missing
  evidence counts, synthetic flag, `receipt_sha256`;
- on failure, `{"error":"run_failed","method":"cashflow-v2.1.0","stage":"<code>"}` and nothing else. Source checks run before any matching and give named codes: `source_missing_<source>`, `as_of_missing_<source>`, `as_of_invalid_<source>`, `as_of_invalid_run`, `as_of_invalid_previous`, `dues_missing`, `dues_incomplete`, `<field>_invalid` for each issuer field that reaches the public metrics (`occupancy_bps`, `reported_yield_bps`, `principal_outstanding_cents`, `accrued_interest_cents`, `capitalized_interest_cents`, `expenses_cents`, `reserves_cents`, `distributions_paid_cents`), `roster_invalid`, `claim_invalid`, `bank_txn_invalid`; input errors `input_*` (sources: `bank_settlements`, `servicer_records`, `property_manager_records`, `issuer_claims`).

In on-chain mode the whole output is public transaction data. So the output never holds row-level data, ids, payer
names, pseudonyms, the bearer token, the data URL, or any value or hash derived from a secret (`tests/tee.rs`).
`receipt_sha256` is a hash of the public receipt fields only.

## Pin enforcement

The OutLayer resolve payload carries no wasm hash. The pin is enforced by the request `source` (the wasm hash above,
or a fixed version key) together with the secrets `--build <sha>` lock, so the data token only opens for this exact
binary.

## Tests

```bash
cd outlayer/engine-v2
cargo test --locked                                   # parity 4 funds, 42 edge cases, TEE flow 12 cases
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --target wasm32-wasip2 -- -D warnings
```
