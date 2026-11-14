# Try it: every step, with expected output

Moved out of the README so the first screen stays short. Everything here was run from `db601c5` on 14 Nov 2026 unless a line says otherwise. [Back to the README](../README.md).

No keys, no NEAR account, no funds, no Docker. Needs Node 22.22.2 or later and Linux or WSL: the API spend store uses util-linux `flock` (`/usr/bin/flock`), so the tests that cover it do not run on macOS or native Windows. Everything runs offline or against public testnet views. Steps 1 to 6 were re-run from `db601c5` on 14 Nov 2026 (Asia/Bangkok, UTC+7) on Linux x64 with Node v24.22.1, npm 11.21.1, system Python 3 with no importable `jsonschema`, and system Rust 1.85.1 (no Rust 1.99.0). `npm test` is the long step. Full expected output for each step is in [Expected output](#expected-output).

```bash
npm ci --ignore-scripts
npm run judge -- --replay
npm test
npm run demo
npm run eval
npm run check:fixtures
```

1. Do: `npm ci --ignore-scripts`
   See: exit 0 and `added ... packages`. The closing `npm audit` line summarises the whole tree, including development tools (the `ganache` local EVM used by the mirror tests): `37 vulnerabilities` on 14 Nov 2026, all in that development tree. The production audit is the one that matters for shipped code: `npm audit --omit=dev --audit-level=high` exits 0 and prints `2 low severity vulnerabilities` (re-run 14 Nov 2026).
2. Do: `npm run judge -- --replay`
   See: one `PASS` line for each of 10 stages (S1 fixtures, S2 tamper, S3 engine, S4 v3 pin, S5 failed head, S6 paid report, S7 dashboard data, S8 mirror, S9 attest local subset, S10 stamp), then `judge: 10 of 10 stages PASS, 0 skipped not verified, ok true`, and exit 0. It runs offline in about 14 s (13.0 s measured from `db601c5` on 14 Nov 2026; 13.6, 13.7 and 14.1 s were measured on 12 Nov 2026) and writes `out/judge-replay.json`. Details in [Step 2](#step-2-npm-run-judge----replay).
3. Do: `npm test`
   See: exit 0 and `fail 0`, then `All worked example numbers match.` The suite has more than 800 tests. The pass and skip counts depend on the machine: 5 or 6 tests skip when Rust 1.99.0 cargo, an importable Python `jsonschema`, or `web/node_modules` is missing. Recompute with `npm test` (when the output is not a terminal, the same fields print as `# tests`, `# pass`, `# fail`, `# skipped`). The rule is exit 0 and `fail 0`. CI job `fresh-clone` records the counts. The skips are the OutLayer output-parity check in `receipts/attestation/output-parity.test.mjs` (needs Rust 1.99.0 cargo: `rustup +1.99.0`, or cargo 1.99 on `PATH`), the four Python files `receipt-v3-schema.test.py`, `receipt-v3.0.1-schema.test.py`, `receipt-v3-privacy.test.py` and `engine-v3-privacy.test.py` (need an importable `jsonschema` in `python3` or `TRUENAV_PYTHON`; CI pins 4.23.0), and, when `web/node_modules` is not installed, one web CSP test. With those tools present, they run as well. The suite still exits 0 when they are skipped.
4. Do: `npm run demo`
   See: `T1-altered-amount ... -> flag amount_mismatch`, `T2-hidden-injection ... -> flag amount_mismatch, injection_attempt`, `T3-duplicate-as-new ... -> flag duplicate_document`, `honest documents: 16 of 16 pass, every signature checked`, then Harbor `99.17 green` and, after the T1 flag, `51.59 red`.
5. Do: `npm run eval`
   See: `main: 86 cases, 86 signatures verified against the attested TEE key` and `holdout: 40 cases, 40 signatures verified against the attested TEE key`, each with `precision 100%, recall 100%, false positive rate 0%` on this test set. Read the limits in [Security and limits](KNOWN_LIMITS.md#security-and-limits).
6. Do: `npm run check:fixtures`
   See: 5 lines `PASS <fixture file>: <N> days left (minimum 10)` and 2 lines `PASS published attestation report ...`, one for `tee/fixtures/verdicts.json` and one for the current registry's set `tee/fixtures/verdicts-368aa2.json`. N counts down: on 14 Nov 2026 it was 22.6 for the four older files and 27.3 for `tee/fixtures/verdicts-368aa2.json`.

## Expected output

Docker is not needed for these steps. The sandbox end-to-end jobs that need Docker were not run locally. They run in CI. `.github/workflows/ci.yml` has 9 jobs: engine, contract, engine-v2, engine-v3, receipts, sandbox, judge-path, fresh-clone and secrets. Count them in that file. `receipts-pinned-build.yml` is a separate workflow and is not in that count. Check the Actions run for the commit you have checked out; do not treat an older run as the current result. For history: all 9 passed on `5833c91` in [run 43219416646](https://github.com/truenavlabs/truenav/actions/runs/43219416646) (12 Nov 2026).

### Step 2: `npm run judge -- --replay`

```
npm run judge -- --replay                 # S1 to S10, offline
npm run judge -- --replay --with-tests    # the same, then the full npm test as an 11th stage (TESTS)
npm run judge -- --replay --only S1,S4    # only these stages; the summary is marked partial and ok stays false
npm run judge -- --replay --out out/x.json   # summary path inside the repo (default out/judge-replay.json)
```

What each stage checks (from `judge/stages.mjs`):

- S1 fixtures: 4 recorded verdict sets and the live `registry.tnlab-368aa2.testnet` set (`tee/fixtures/verdicts-368aa2.json`, every signature checked offline) have at least 10 days left; each published attestation report hash matches its verdict set.
- S2 tamper: T1 `amount_mismatch`, T2 `injection_attempt`, T3 `duplicate_document`; 16 of 16 honest documents pass, every signature checked; Harbor 99.17 green, then 51.59 red.
- S3 engine: Harbor 99.17 green (public 99), Meridian 42.84 red (public 43), every worked-example field matches; eval 86 plus 40 signatures verified, 0 extra fields.
- S4 v3 pin: the agent accepts only the engine hash in `receipts/v3-build.json`; another engine is declined `engine_hash` and nothing is bought.
- S5 failed head: on DEMO-CREDIT, `/score` and `/report` return 409 `run_failed`, the entitlement is not redeemed, and `runAgent` with `execute` buys nothing. Local API on a fake chain with a random test key.
- S6 paid report: `/score` is free; a one-use entitlement returns 200 once, a second use is refused; no entitlement is 402. Local API on a fake chain.
- S7 dashboard data: writes `out/judge-dashboard.json` with Harbor 99 green, Meridian 43 red, DEMO-CREDIT `run_failed`. Data only, no UI.
- S8 mirror: the Solidity mirror compiles and a local EVM (ganache, chain 84532) accepts only the MPC signer and a rising sequence per token. Not deployed.
- S9 attest, local subset: 19 of 19 `tee/loans.json` hashes match `tee/fixtures/fingerprints.json`, and the attestation report hash matches. The live checks are `npm run verify:fingerprints` and `npm run verify:attestation`.
- S10 stamp: a wasm swapped after stamping reads stale. Uses a fake wasm in a temp tree; it does not show that a real build is fresh.

How it behaves:

- Offline. Each stage runs as a child process with a fixed minimal environment (no keys, RPC URLs or accounts from your shell) and loads `judge/no-network.mjs`, which refuses outside network calls. Any refused call fails that stage.
- Exit 0 only if every selected stage passes; 1 on any failure; 2 on a usage error.
- `out/judge-replay.json` follows `judge/summary.schema.json`. It has each stage's status, claim and evidence, the pins, any skips, and `evidence_hash`, the sha256 of the canonical summary without its `ephemeral` part (time, durations, Node version, fixture days left). The hash includes the commit id, so it differs per commit.
- `--with-tests` adds `npm test` as stage TESTS. It ends with `judge: 11 of 11 stages PASS` when every selected npm test passes. Skipped tests, if any, are listed as not verified. The `npm test` counts themselves are in [Step 3](#step-3-npm-test). Recompute with `npm test`; do not treat an older count as current.
- `--live` is not built. It prints `--live is not built: live reads run in CI only` and exits 2. The live reads are the optional steps below.
- If this machine cannot listen on 127.0.0.1, the judge prints a `WARN` line first, saying loopback is unavailable and that S5, S6, S7 and S8 will fail, and each of those failures is labelled "this is a sandbox limit, not a product failure". Those four stages start a local API or a local EVM.

Last lines of a real run (14 Nov 2026, `db601c5`):

```
PASS S10 stamp (README: "A wasm swapped after stamping is detected as stale.")
judge: 10 of 10 stages PASS, 0 skipped not verified, ok true, evidence_hash <sha256, differs per commit>
judge: wrote out/judge-replay.json, wall 13.0 s
```

### Step 3: `npm test`

```bash
export TRUENAV_PYTHON=python3   # optional: the interpreter that has jsonschema (CI pins 4.23.0); python3 is the default
npm test
```

On 14 Nov 2026 (a machine with no Rust 1.99.0 and no importable `jsonschema`) the summary ended `fail 0`, `skipped 5`, with more than 800 tests run. The counts move as tests are added and differ by machine. The rule is exit 0 and `fail 0`. Then the worked-example check prints:Then the worked-example check prints:

```
Harbor Credit Fund
  gap 40.00  coverage 40.00  freshness 19.17  penalty 0.00  raw 99.17
  ok   headline: expected 9500000, got 9500000
  ok   policy: expected 9500000, got 9500000
  ok   trueVal: expected 9665110, got 9665110
  ok   trueRange: expected 345554, got 345554
  ok   trueRangeLow: expected 9319556, got 9319556
  ok   trueRangeHigh: expected 10010664, got 10010664
  ok   raw: expected 99.2, got 99.2
  ok   score: expected 99, got 99
  ok   band: expected green, got green
  ok   status: expected scored, got scored
Meridian Yield Fund
  gap 3.71  coverage 36.79  freshness 16.67  penalty 14.32  raw 42.84
  ok   headline: expected 3735000, got 3735000
  ok   policy: expected 3435000, got 3435000
  ok   trueVal: expected 3092970, got 3092970
  ok   trueRange: expected 361435, got 361435
  ok   trueRangeLow: expected 2731535, got 2731535
  ok   trueRangeHigh: expected 3454405, got 3454405
  ok   raw: expected 42.8, got 42.8
  ok   score: expected 43, got 43
  ok   band: expected red, got red
  ok   status: expected scored, got scored
All worked example numbers match.
```

The 5 skipped tests on a machine with no Rust 1.99.0 and no importable `jsonschema` are `OutLayer serde_json::to_string(returned B) output_hash equals the stored body_sha256`, with the reason `Rust 1.99.0 cargo not found (rustup +1.99.0 or cargo 1.99 on PATH)`, and the four Python files `receipt-v3-schema.test.py`, `receipt-v3.0.1-schema.test.py`, `receipt-v3-privacy.test.py` and `engine-v3-privacy.test.py`. CI runs those five. The suite still exits 0 when they are skipped.

### Step 4: `npm run demo`

```
TEE: Qwen/Qwen3-VL-30B-A3B-Instruct in NEAR AI Cloud, signer 0x2665cce942fa427ef30d87f4b0bff67fb7645462
Attested 2026-11-07T02:51:16.707Z with fresh nonce d92bebe155f799df...: NEAR AI Cloud gateway PASS; Model Qwen/Qwen3-VL-30B-A3B-Instruct PASS

signed by TEE  T1-altered-amount    expected amount_mismatch  ->  flag amount_mismatch
signed by TEE  T2-hidden-injection  expected injection_attempt  ->  flag amount_mismatch, injection_attempt
signed by TEE  T3-duplicate-as-new  expected duplicate_document  ->  flag duplicate_document
honest documents: 16 of 16 pass, every signature checked

Harbor with every document passing:      99.17 green
Harbor after the TEE flags H-RE-01 (T1): 51.59 red  (TEE flag: amount_mismatch)
```

This replays recorded, TEE-signed replies and checks every signature. It does not call the TEE.

### Step 5: `npm run eval`

```
main: 86 cases, 86 signatures verified against the attested TEE key, 86 replies within the reply rule
  replies echoing extra fields: 0 of 86 (0 field values)
  raw      precision 100%, recall 100%, false positive rate 0% (tp 46, fn 0, fp 0, tn 40)
  grounded precision 100%, recall 100%, false positive rate 0% (tp 46, fn 0, fp 0, tn 40)
holdout: 40 cases, 40 signatures verified against the attested TEE key, 40 replies within the reply rule
  replies echoing extra fields: 0 of 40 (0 field values)
  raw      precision 100%, recall 100%, false positive rate 0% (tp 20, fn 0, fp 0, tn 20)
  grounded precision 100%, recall 100%, false positive rate 0% (tp 20, fn 0, fp 0, tn 20)
```

### Step 6: `npm run check:fixtures`

```
PASS tee/fixtures/verdicts.json: 22.6 days left (minimum 10)
PASS tee/fixtures/verdicts-sandbox.json: 22.6 days left (minimum 10)
PASS tee/fixtures/verdicts-unit.json: 22.6 days left (minimum 10)
PASS contract/tests/fixtures/tee-verdicts.json: 22.6 days left (minimum 10)
PASS tee/fixtures/verdicts-368aa2.json: 27.3 days left (minimum 10)
PASS published attestation report is the one tee/fixtures/verdicts.json was signed under
PASS published attestation report tee/fixtures/attestation-report-368aa2.json.b64 is the one tee/fixtures/verdicts-368aa2.json was signed under
```

Real output on 14 Nov 2026 from `db601c5`. The days-left figures count down. The command fails once any fixture has fewer than 10 days left.

At those figures the four 718ca9 sets reach the 10 day minimum around 27 Nov 2026 and the 368aa2 set around 1 Dec 2026, after judging (16 to 18 Nov). From then on `check:fixtures`, judge S1 and `npm test` fail by design until the sets are re-signed.

### Optional: read the live testnet registry (no keys)

These commands use public network reads only (NEAR testnet RPC; the attestation and fingerprint commands also call Intel and NVIDIA attestation services). No keys and no transactions.

#### Live accounts versus test fixtures

Do not mix these up:

- Live NEAR registry: `registry.tnlab-368aa2.testnet`. This is the default for every live read below.
- Earlier NEAR registry, recorded history only: `registry.tnlab-718ca9.testnet`. CI re-reads it in labelled earlier-instance steps. It is not the default live registry.
- Live receipts and query contracts: `receipts.tnlab-718ca9.testnet` and `query.tnlab-718ca9.testnet`. They sit on the 718ca9 instance. There is no receipts or query contract on the 368aa2 registry account.
- The receipts v3 `source_registry` in `receipts/v3-build.json` is a public TEST fixture only (`engine/v3-core/tests/fixtures/source-registry.TEST.json`). It is a test key set for the engine, not a NEAR account, and not the live registry.
- Receipts printed by `npm run demo` and in the offline judge path are synthetic fixtures. They are not a live read of `receipts.tnlab-718ca9.testnet`.
- `receipts-v3-dryrun.tnlab-718ca9.testnet` is a TEST-only overlay name in the v3 upgrade docs. The account does not exist on testnet (RPC `view_account`, 14 Nov 2026).

#### Deployment evidence

The table below is a read-only RPC snapshot from `https://rpc.testnet.near.org`, finality `final`. Registry, receipts and the earlier registry were read on 14 Nov 2026 at 15:56 to 15:57 Asia/Bangkok (UTC+7), blocks 277635176 to 277635300. Query was re-read after a code-only redeploy on 14 Nov 2026 at 17:29 Asia/Bangkok (UTC+7). Recompute with `view_account` and `view_code`, then sha256 of the wasm. The live `code_hash` is base58 of that sha256. The full table, pins and limits are in `docs/DEPLOYMENT_EVIDENCE.md`.

| Account | Kind | Live `code_hash` / wasm sha256 | Repo pin | Match | Proof |
|---|---|---|---|---|---|
| [`registry.tnlab-368aa2.testnet`](https://testnet.nearblocks.io/address/registry.tnlab-368aa2.testnet) | Live registry (default) | `9Ki2kuenoxie3doBRYbdTPSmzTjwsTosQmUaGwQKCw7o` / `7ba857d3...1735595a` (364904 bytes) | `certify/live-registry.json` `code_hash` | Yes | Deploy and init in [Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE](https://explorer.testnet.near.org/transactions/Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE) (11 Nov 2026). |
| [`receipts.tnlab-718ca9.testnet`](https://testnet.nearblocks.io/address/receipts.tnlab-718ca9.testnet) | Live receipts (v2) | `HNCayZpizjrHK8djD7XpGmwA7R3mLZ8A4GZ864CaaGhS` / `f32949b3...f7b29c9d` (266556 bytes) | `receipts/pinned-builds.json` receipts `5f294c9a...52e8606f` (expected `code_hash` `7QUFsz1UyZRJvRsaWBkHrif83WfbarumTHcVa7ifvchk`) | No. Live v2, v3 pinned not deployed. | No deploy transaction for the live `f32949b3` bytes was found. The v3 pin was built in the pinned CI image, [run 43567288753](https://github.com/truenavlabs/truenav/actions/runs/43567288753). The Level 1B upgrade rehearsal (migration, rollback, code-only re-entry on the exact live bytes) runs green in CI. |
| [`query.tnlab-718ca9.testnet`](https://testnet.nearblocks.io/address/query.tnlab-718ca9.testnet) | Live query | `G16shAw72Dznwxuojy3kdM6er1ksAPndtHdXmQ28MbUt` / `dee5f216...f8169d09` (162201 bytes) | `receipts/pinned-builds.json` query `dee5f216...f8169d09` (expected `code_hash` `G16shAw72Dznwxuojy3kdM6er1ksAPndtHdXmQ28MbUt`) | Yes | Code-only redeploy on 14 Nov 2026 at 17:29 Asia/Bangkok (UTC+7), [tx 2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8](https://testnet.nearblocks.io/txns/2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8). |
| [`registry.tnlab-718ca9.testnet`](https://testnet.nearblocks.io/address/registry.tnlab-718ca9.testnet) | Earlier registry, history only | `Foc9f2oJ8Ja1ddKSt91kXTxVm33nRBMjx3e4LHMP13EW` / `dbf413da...72693db7` (340351 bytes) | On-chain metadata names source `d37b9d2`; tag `registry-tnlab-718ca9` points at that commit. No current wasm pin in `certify/live-registry.json`. | Live hash matches the recorded earlier-instance hash. | Recorded earlier-instance hash and the `registry-tnlab-718ca9` tag. |

The live receipts `get_config` is method `cashflow-v2.1.0` and `version_key` `360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57`, paused false. That is the live v2 config. The pinned v3 config is method `truenav-v3.0.1` and engine `098f5d86a94288d13fac1ca66b8aba9c20a2dc1b3585a64ef91d5bba5aa68788`. Config does not match. Live v2, v3 pinned not deployed.

Known limit: a live v3 cutover needs a sealed live source-key registry for the v3 engine and a key-scope continuity proof, which are not done.

The live query `get_config` was unchanged after the code-only redeploy and is unpaused.

The OutLayer project `p0000000000000177` active engine version is still `360cd473`. The v3 engine `098f5d86` is pinned and not uploaded.

The live registry was deployed and initialised in [Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE](https://explorer.testnet.near.org/transactions/Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE) on 11 Nov 2026 from a local host (non-reproducible) build of the registry wasm, 364904 bytes. That is not a pinned-image or NEP-330 reproducible-build claim (`contract_source_metadata.build_info` is null). TEE is live on this contract: the TEE signer `0x2665cce942fa427ef30d87f4b0bff67fb7645462` was registered in [9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE](https://explorer.testnet.near.org/transactions/9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE) and 16 verdicts, one per honest loan, are on chain (all pass). The 3 trap records in `tee/fixtures/verdicts-368aa2.json` were not submitted. No receipts contract exists on the 368aa2 registry account.

On-chain refusals from that run, found in the repo and logs:

- a public test-key certificate was refused with `signer not registered`: [Gbu7tKHuE2WVfSMduS1MNyuMRf6TQSQyou2gr9ozXrnQ](https://explorer.testnet.near.org/transactions/Gbu7tKHuE2WVfSMduS1MNyuMRf6TQSQyou2gr9ozXrnQ)
- a second pledge of an already pledged loan was refused with `already pledged elsewhere`: [8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs](https://explorer.testnet.near.org/transactions/8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs)

No deploy transaction for the live receipts `f32949b3` bytes was found in the repository or in the local logs. That link is not invented. The query code-only redeploy is [2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8](https://testnet.nearblocks.io/txns/2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8).

Related live accounts with no contract code: `tnlab-368aa2.testnet` (admin and registrar of the live registry), `pauser.tnlab-368aa2.testnet`, `servicer.tnlab-368aa2.testnet`, `harbor.tnlab-368aa2.testnet`, `meridian.tnlab-368aa2.testnet`. On the 718ca9 instance: `tnlab-718ca9.testnet` (admin and pauser of the live receipts contract), `pauser.tnlab-718ca9.testnet`, `servicer.tnlab-718ca9.testnet`, `runner.tnlab-718ca9.testnet`. `registry.tnlab-dd2a56.testnet` is a retired historical registry, not the live one.

The recorded loan fingerprints were made under the 718ca9 OutLayer project, and `tee/fingerprint.mjs` accepts only that scope.

Why the scope matters: a loan hash is an OutLayer MAC of the framed term digest, and the MAC key is derived from the OutLayer project, the caller account and the key path (`loan-terms-v2`). The registry refuses a second pledge of the same `loan_hash`, which only works because the same loan always gives the same hash inside one key scope. A different master account is a different project and caller, so the same loan terms would produce different hashes there. That is why `npm run verify:fingerprints` rejects an attestation from any other scope (it stops a foreign run being passed off as the recorded set), and why the demo loans are never re-pledged from a fresh scope, which would put a second hash for the same real loan on chain.

1. Do: `npm run chain:read`
   See: Harbor `TrueNav score 99 green (raw 99.17)` and Meridian `TrueNav score 43 red (raw 42.84)`, each followed by `-> matches the recomputed score`, and `TEE verdicts on chain: 11 pass, 0 flag, 0 pending, 0 overdue, 0 expired` for Harbor and `TEE verdicts on chain: 5 pass, 0 flag, 0 pending, 0 overdue, 0 expired` for Meridian. Verified exit 0 against `registry.tnlab-368aa2.testnet` on 14 Nov 2026 from `db601c5`. To read the earlier instance: `TRUENAV_CONTRACT=registry.tnlab-718ca9.testnet npm run chain:read`.
2. Do: `npm run verify:attestation`
   See: PASS lines for the Intel TDX quote signature and TCB status, debug mode off, the signing address and our nonce bound in the quote's report data, MRCONFIGID equal to the report's own `app_compose`, RTMR3 equal to the replayed event log, and the NVIDIA NRAS verdict, the line `PASS the attested model key signed all 19 recorded verdicts`, `PASS the contract accepts exactly that key`, and a closing line that starts `Attestation checks passed: the report hash is on chain, the TDX quote and TCB status verify, debug is off, ...` and ends by saying that this does not prove which image runs (re-run 14 Nov 2026, exit 0) The measurement checks are consistency checks inside one report: MRTD and RTMR0 to RTMR2 are not compared with pinned expected values (see [Known limits and disclosures](KNOWN_LIMITS.md#known-limits-and-disclosures)). This reads the current registry's recorded set, `tee/fixtures/verdicts-368aa2.json`. For the earlier instance: `npm run verify:attestation -- --contract registry.tnlab-718ca9.testnet`.
3. Do: `npm run verify:fingerprints`
   See: a `PASS` line per demo loan, then `Fingerprints verified: every loan_hash came from the attested OutLayer TEE.` These fingerprints are the recorded demo set, not a live read of 368aa2.
   Why 18 `PASS` lines here and "19 of 19" in judge S9: `tee/loans.json` has 19 rows (16 honest loans and 3 tampered variants T1, T2, T3), while `tee/fixtures/fingerprints.json` has 17 records, one per distinct document id. T1 and T2 are altered copies of the documents for H-RE-01 and H-RE-02, so they reuse those fingerprints; T3 has its own document id. The command prints one `PASS` per record (17) plus one for all 19 loans (1). Judge S9 reports the same check per row.
4. Do: `npm run check:chain-replies`
   See: `registry.tnlab-368aa2.testnet: 45 transactions, 16 submit_verdict calls decoded` (counts on 11 Nov 2026, unchanged on 12 Nov 2026; they grow if the account is used) and `PASS every submit_verdict reply from our accounts is within the allowed keys`. For the earlier instance (55 transactions, 18 calls): `npm run check:chain-replies -- --contract registry.tnlab-718ca9.testnet`.
5. Optional: `npm run tee:chain-check` (read only; see `docs/TEE_FLIP.md`). It confirms the registered TEE signer, the binding and expiry, and that each of the 16 honest verdicts in `tee/fixtures/verdicts-368aa2.json` is on chain; the 3 trap records are not.
