# Step 4: receipt contract, paid query contract, API

Testnet only. Nothing here is deployed yet; every deploy, transaction, OutLayer upload or secret needs the owner's
yes on the exact printed commands.

| Part | Where | What |
| --- | --- | --- |
| Receipt contract | `receipts/` | requests a pinned OutLayer run per token, stores the public checks receipt it returns |
| Query contract | `query/` | an agent pays 0.01 testnet NEAR for a one-use, 24-hour entitlement (report: 1 use, Q&A: 20 questions) |
| API | `api/` | `GET /fund/{token}/score` free; `GET /fund/{token}/report` and `POST /ask` need an entitlement |
| Mock OutLayer | `receipts/mock-outlayer/` | local sandbox stand-in for `request_execution` (yield and resume); never deployed |

## Flow

1. A runner calls `request_run(token_id)` on the receipt contract with 0.26 NEAR (0.01 for OutLayer, 0.25 held for
   receipt storage; the unused part of both is refunded).
2. The contract makes a nonce and calls `outlayer.testnet` `request_execution` with `source` = the project at the
   fixed `version_key` (the engine wasm sha256 from `outlayer/engine-v2/BUILD.md`) and `secrets_ref` = the sealed data
   credentials. It builds `input_data` itself, never from the caller: `token_id`, its own `run_nonce`, and, once the
   token has a stored receipt, `previous` (that receipt's passport sources, hashes and as-of) and `previous_period`.
   No `as_of` (the TEE clock is used) and no `new_period` (the TEE derives it from `previous_period` and the issuer's
   period). `get_run_input(token_id)` shows exactly what the next request would send.
3. Inside the TEE the engine fetches the three documents itself, runs cashflow-v2.1.0 and prints the receipt.
4. OutLayer resumes the request; the contract's private callback checks the receipt answers this request (token,
   nonce, method, kind) and passes the whitelist in `receipts/src/validate.rs`, then stores it with a per-token
   sequence number, the sha256 of the bytes as delivered and the build the request pinned. A module error, a failed
   execution or a rejected receipt stores only a short code.

On chain go only: aggregates, caps and holds with their reasons, the public metrics block (cohorts under 5 units
suppressed, enforced again by the contract) and the passport with whole-document sha256 hashes. Never a token, key,
seed, pseudonym or row.

## What the receipt hash binds

`receipt_sha256` on chain is the sha256 of the bytes the callback received. OutLayer reads large outputs back from
its own storage and resumes with them as JSON (`response_format: "Json"`; NEAR limits a resume payload to 1024
bytes, which is why OutLayer stores them), so those bytes can differ in whitespace or key order from what the wasm
printed. The engine already prints canonical JSON, so they should match; a check against a run's attestation should
compare parsed JSON, not bytes (not built yet: step 5 or the verifier). The receipt's own `receipt_sha256` field is the engine's hash of its fields and is
informational, as `code_hash` is (spec 8.2).

## Tests

```bash
(cd receipts && cargo test --locked)     # 16: the 4 real engine receipts, closed-schema rejections with fixed codes, malformed UTF-8 dates, JSON-string receipts, admission vs run failure refunds, storage charge, method snapshot, roles, contract-built input
(cd query && cargo test --locked)        # 8: exact fee, 24 h, uses, redeemer, withdraw bound, 1 yocto admin calls
node --test api/test/api.test.mjs        # 7: free score, 402, one-use report, ask spends nothing, score unchanged
npm run e2e:receipts                     # 63 checks on a local sandbox, engine run natively as the worker
```

## Pinned builds

`sourcescan/cargo-near:0.22.0-rust-1.99.0@sha256:51ab40ef...`, `cargo near build non-reproducible-wasm --locked`,
two fresh clones at different paths (as root and as the image user), source commit 0c49d30:

| Contract | sha256 | bytes |
| --- | --- | --- |
| receipts | `57ae8fa8d3af720aab15c397a60baca0aa3aeaf965d42e8017b8a06cd0d87948` | 257067 |
| query | `ec1f9f3a67e69b802efa7be64feee15ac869cf12a1e73014defaf45c52505156` | 155543 |

`receipts/pinned-builds.json` holds the same hashes; the deploy script refuses any other bytes.

## Who can use the data credentials

Checked against the OutLayer contract (`contract/src/execution.rs`) and `outlayer-cli` 0.2.1 (`commands/secrets.rs`),
8 Nov:

- An `--access whitelist:` leaf is judged on the transaction signer. A run starts with `runner.` signing
  `request_run`, so the signer OutLayer sees is `runner.tnlab-718ca9.testnet`, not the receipt contract. Whitelisting
  `receipts.` alone would admit no run.
- `--via receipts.tnlab-718ca9.testnet` adds a `Predecessor` rule: the account that called `request_execution` must
  be the receipt contract. The stored condition is
  `And[Whitelist[runner.], Predecessor{Whitelist[receipts.]}]`, so `runner.` calling OutLayer directly, or through any
  other contract, is refused, and nobody else's signature is accepted through the receipt contract.
- `--build <engine sha>` locks the row to the pinned engine build, so another build in the project cannot read it.
- The receipt contract only lets runners it lists call `request_run` (`set_runner`, admin only), and it builds the
  whole input itself.

## Failures and refunds

- Refused at admission (`request_execution` panicked): NEAR returns the 0.01 deposit to the receipt contract, which
  sends it to the requester with the unused storage deposit. Code `outlayer_admission_failed`.
- Admitted, then failed or timed out: OutLayer resolves `null` and refunds the unused deposit to `payer_account_id`
  (the requester) itself; the contract refunds only the unused storage. Code `outlayer_run_failed`. Nothing is
  refunded twice.
- The requester pays for all the storage a run uses: the pending record (measured when it is written) and whatever
  the callback stores.
- A rejected receipt stores a fixed code (`receipt_rejected:<check>`); the code never echoes the input.

## Deploy plan (each step needs its own yes)

`node receipts/deploy-testnet.mjs <step>` prints exactly what it would send and sends nothing; `--execute` sends that
step only, after read-only checks (testnet chain id, key file present, pinned wasm bytes, accounts free, balance).

| Step | What | Cost |
| --- | --- | --- |
| D0 | read-only checks | none |
| D1 | create `receipts.`, `query.`, `runner.`, `api.tnlab-718ca9.testnet` with fresh keys | 5.0 NEAR moved to our own accounts, plus gas |
| D2 | deploy and init the receipt contract (admin and pauser `tnlab-718ca9.testnet`, engine pin `360cd473...`) | about 2.55 NEAR code storage (from D1 funds) |
| D3 | register the 4 synthetic tokens, set the runner (1 yocto each) | gas |
| D4 | deploy and init the query contract (fee 0.01 NEAR, redeemer `api.`) | about 1.6 NEAR code storage (from D1 funds) |

Later, separately (OutLayer and the data host):

| Step | What |
| --- | --- |
| H1 | host the mock bank-data API (synthetic data) where the TEE can reach it: the one approved Vercel free-tier project, name and commands to be confirmed |
| O1 | `OUTLAYER_NETWORK=testnet outlayer upload outlayer/engine-v2/target/wasm32-wasip2/release/truenav-engine-v2.wasm` (signed as `receipts.tnlab-718ca9.testnet`), then check FastFS serves sha256 `360cd473...` |
| O2 | `OUTLAYER_NETWORK=testnet outlayer deploy truenav-engine <fastfs url> --hash 360cd473... --target wasm32-wasip2` |
| O3 | `OUTLAYER_NETWORK=testnet outlayer secrets set '<TRUENAV_DATA_URL, TRUENAV_DATA_TOKEN>' --project receipts.tnlab-718ca9.testnet/truenav-engine --profile engine --access whitelist:runner.tnlab-718ca9.testnet --via receipts.tnlab-718ca9.testnet --build 360cd473...` (token read from a file, never shown; see "Who can use the data credentials" below) |
| R1 | first live run: `request_run` for one synthetic token from `runner.`, 0.26 NEAR attached, 300 Tgas |
