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
(cd receipts && cargo test --locked)     # 17: the 4 real engine receipts and a rental in severe arrears (late_share_bps 40000), closed-schema rejections with fixed codes, malformed UTF-8 dates, JSON-string receipts, admission vs run failure refunds, storage charge, method snapshot, roles, contract-built input
(cd query && cargo test --locked)        # 8: exact fee, 24 h, uses, redeemer, withdraw bound, 1 yocto admin calls
node --test api/test/api.test.mjs        # 7: free score, 402, one-use report, ask spends nothing, score unchanged
npm run e2e:receipts                     # 67 checks on a local sandbox, engine run natively as the worker
```

## Demo agent (agents track)

`agent/` is a small script agent for the synthetic tokens. For one token it:

1. reads the free public score from the receipt contract (`get_latest`, `get_token`) and checks the stored receipt
   against its own `receipt_sha256` and index fields (score, band, method, caps, holds, as_of);
2. buys one `report` entitlement on the query contract with `buy_query` for exactly the fee (0.01 NEAR; it refuses a
   higher fee or a paused contract), and, given the API's URL, spends it on `GET /fund/<token>/report` and checks the
   served receipt is the one the score came from;
3. acts on the score: red (below 60) declines with the caps as reasons, any hold or yellow goes to review, a receipt
   older than 45 days goes to review, a green score with any cap goes to review with the caps as reasons, and only
   green with no caps and no holds is approved. With no receipt, or a record that does not match its receipt, it
   declines and buys nothing. `runAgent` buys nothing unless it is called with `execute: true`.

It prints the decision with the receipt reference (contract, token, seq, `receipt_sha256`, method, pinned build) and
the entitlement it bought.

```bash
node --test agent/test/agent.test.mjs      # 8: the rule on the real engine receipts, green with a cap, index mismatches, the flow, no execute by default
npm run e2e:receipts                       # includes the agent on the sandbox: DEMO-CREDIT and HONEST-RENTAL declined, HONEST-CREDIT approved
node agent/run.mjs DEMO-CREDIT             # testnet, print only: views, the decision, the exact buy_query it would send
```

On testnet, `--execute` signs `buy_query` with the agent's own account (`TRUENAV_AGENT_ACCOUNT`, key file
`TRUENAV_AGENT_KEYFILE` whose `account_id` must match); it refuses the master, `receipts.`, `query.`, `runner.` and
`api.` accounts. It needs about 0.0103 NEAR per token (the 0.01 fee plus gas).

## Pinned builds

`sourcescan/cargo-near:0.22.0-rust-1.99.0@sha256:51ab40ef...`, `cargo near build non-reproducible-wasm --locked`,
two fresh clones at different paths (as root and as the image user), source commit dc0b6c6:

| Contract | sha256 | bytes |
| --- | --- | --- |
| receipts | `e321077fa7f57358c23fc308f335f942db9899c83676d822bcd57e5329c2ab81` | 264542 |
| query | `ec1f9f3a67e69b802efa7be64feee15ac869cf12a1e73014defaf45c52505156` | 155543 |

`receipts/pinned-builds.json` holds the same hashes; the deploy script refuses any other bytes, and CI fails if its
build differs. Previous receipts pins, never deployed: `1a04e120...` (591db60, rental late share capped at 10000), `57ae8fa8...`
(0c49d30, before the review fixes).

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
- A failed promise that is not an admission failure: OutLayer's own callback (`on_execution_response`) panicking
  or running out of gas after it admitted the request. Its contract returns a value on every path, including
  `null` for failed and timed-out runs and for an unknown request, so this should not happen, but the receipt
  contract cannot tell it from an admission failure: both reach it as a FAILED promise. It then stores
  `outlayer_admission_failed` and refunds 0.01 NEAR the contract did not get back (OutLayer kept the deposit), paid
  from its own balance. The loss is at most 0.01 NEAR per run, only listed runners can request runs, and the admin
  can pause; the `receipts.` balance (about 0.54 NEAR above storage) covers a few.
- Cleared, then the callback arrives late: `clear_pending` (admin) refunds the storage deposit less a small
  late-callback record (requester, OutLayer deposit, about 0.001 NEAR of storage). If OutLayer's promise then FAILED,
  the requester gets the OutLayer deposit back with those bytes (`late_refunded`); any other late result refunds only
  the bytes and stores nothing (`late_ignored`). The record is deleted on the first callback, so nothing is refunded
  twice; a callback with no record refunds nothing. Before this, a FAILED promise after a clear refunded nothing.
- The requester pays for all the storage a run uses: the pending record (measured when it is written) and whatever
  the callback stores.
- A rejected receipt stores a fixed code (`receipt_rejected:<check>`); the code never echoes the input.
- Metric bounds follow `outlayer/engine-v2/src/metrics.rs` (`receipts/src/validate.rs` lists why each holds). Rental
  `late_share_bps` is all arrears 60+ days late over one period's rent due, so months of arrears exceed 10000
  (HONEST-RENTAL with no rent since August: 40000, stored red at 59); it is allowed up to 1,000,000 (100 periods).

## Deploy plan (each step needs its own yes)

`node receipts/deploy-testnet.mjs <step>` prints exactly what it would send and sends nothing; `--execute` sends that
step only, after read-only checks: testnet chain id; the signer key file's public key is a full-access key of the
master on chain; the pinned wasm bytes; which accounts exist; the master balance against what D1 still has to fund.

- Signer: `TRUENAV_SIGNER_KEYFILE=<path>` (its `account_id` must equal the master, else the script stops); default
  `~/.near-credentials/testnet/<master>.json`. Only `private_key` is used; no key is ever printed.
- D1 is resumable: an account that already exists is skipped only if its local key file's public key is a
  full-access key on chain; otherwise D1 stops. New key files are created exclusively (mode 600), never overwritten.
  The preflight checks the funding of the accounts not created yet plus 0.05 NEAR for gas, before every account.
- Wasm: `target/near` of each crate, or `TRUENAV_WASM_DIR=receipts/dist`, the pinned-image builds committed there
  (same sha256 as above), so a machine without Docker can deploy. Any other bytes are refused.

| Step | What | Cost |
| --- | --- | --- |
| D0 | read-only checks | none |
| D1 | create `receipts.` (3.2), `query.` (1.7), `runner.` (0.4), `api.tnlab-718ca9.testnet` (0.1) with fresh keys | 5.4 NEAR moved to our own accounts, plus gas; the preflight needs 5.45 |
| D2 | deploy and init the receipt contract (admin and pauser `tnlab-718ca9.testnet`, engine pin `360cd473...`) | about 2.66 NEAR storage: 265,957 bytes after D2 and D3 on the sandbox, of the 3.2 NEAR D1 gives `receipts.` (about 0.54 left for gas and refunds; the e2e checks it fits) |
| D3 | register the 4 synthetic tokens, set the runner (1 yocto each) | gas |
| D4 | deploy and init the query contract (fee 0.01 NEAR, redeemer `api.`) | about 1.6 NEAR code storage (from D1 funds) |

Later, separately (OutLayer and the data host):

| Step | What |
| --- | --- |
| H1 | host the mock bank-data API (synthetic data) where the TEE can reach it: the one approved Vercel free-tier project, root directory `hosting/mockbank` (one all-funds token from env `TRUENAV_DATA_TOKEN`, fail closed without it; steps in `hosting/mockbank/README.md`) |
| O1 | `OUTLAYER_NETWORK=testnet outlayer upload outlayer/engine-v2/target/wasm32-wasip2/release/truenav-engine-v2.wasm` (signed as `receipts.tnlab-718ca9.testnet`), then check FastFS serves sha256 `360cd473...` |
| O2 | `OUTLAYER_NETWORK=testnet outlayer deploy truenav-engine <fastfs url> --hash 360cd473... --target wasm32-wasip2` |
| O3 | `OUTLAYER_NETWORK=testnet outlayer secrets set '<TRUENAV_DATA_URL, TRUENAV_DATA_TOKEN>' --project receipts.tnlab-718ca9.testnet/truenav-engine --profile engine --access whitelist:runner.tnlab-718ca9.testnet --via receipts.tnlab-718ca9.testnet --build 360cd473...` (token read from a file, never shown; see "Who can use the data credentials" below) |
| R1 | first live run: `request_run` for one synthetic token from `runner.`, 0.26 NEAR attached, 300 Tgas |
