# engine-v2: pinned, reproducible build

The TrueNav cashflow-v2.0.0 scorer as an OutLayer WASI P2 component. It is the same method as the JS reference
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

## Recorded result (source commit 214dae9, tree outlayer/engine-v2 dab9be5)

| | |
|---|---|
| wasm sha256 | `a74d6976eebb6fe3653648f80e5999e7f8b36c0d4cc6418b26da767a930cecee` |
| size | 559742 bytes |
| check | two fresh clones, mounted at different absolute paths (`/src/a`, `/work/b-other`), same sha256 |

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
  "previous": [{ "source": "bank_settlements", "snapshot_sha256": "<hex>", "as_of": "..." }], "new_period": false }
```

`as_of`, `previous` and `new_period` are optional.

Output (stdout), one canonical JSON object, at most about 3.3 KB for the demo funds:

- on success, the receipt only: method, token id, run nonce, period, score, band, parts, caps, public metrics (cohorts
  under 5 suppressed), evidence passport (source snapshot hashes and freshness), checks run, exception and missing
  evidence counts, synthetic flag, `receipt_sha256`;
- on failure, `{"error":"run_failed","method":"cashflow-v2.0.0","stage":"<code>"}` and nothing else.

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
cargo test --locked                                   # parity 4 fixtures, TEE flow 7 cases
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --target wasm32-wasip2 -- -D warnings
```
