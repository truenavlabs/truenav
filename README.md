# TrueNav

TrueNav checks tokenized private credit funds on NEAR. It proves two things to an investor without revealing the underlying loans:

1. Every loan in a fund is pledged only once, across all funds using TrueNav.
2. The fund's reported NAV is checked against TrueVal, recomputed from verified loans only.

Three numbers, each decided by owner 5 Nov 2026:

- TrueVal: what the fund's loans are worth after expected losses. Model estimate, not fair value.
- TrueRange: where TrueVal likely falls, assuming loans default independently. Demo estimate.
- TrueNav score: how far you can trust the fund's reported NAV, 0 to 100.

PD tables are demo, not calibrated. The 30 days, 50% and 10% thresholds are TrueNav's own policy, not agency figures. Rules: `spec/nav/NAV_SPEC.md`. Engine and tests: `engine/`, run with `npm test`.

Roadmap: correlated defaults; on-chain certificate history; binding manager_id to the live NEAR registry signer; liability oracle.

Built at NEAR HACKATHON 2026 by TrueNav Labs. Tracks: Privacy & Private AI, Open Innovation.

## Run it

Needs Node 18 or later. The contract checks also need Rust (cargo).

```
npm ci
npm test        # engine tests, certificate tests and the worked-example check
npm run e2e     # engine output -> signed certificate -> verified and stored by the contract (offline)
```

`npm test` scores Harbor Credit Fund 99.17 green and Meridian Yield Fund 42.84 red (57.17 without its blocked attempt) and prints "All worked example numbers match."

## End to end: engine to contract

1. `certify/run.mjs` scores the demo funds with `engine/src/score.mjs` and turns each result into a certificate: fund_id, fund account, manager, status, score, band, raw x 100, TrueVal, TrueRange, Policy NAV and headline in integer cents, blocked attempts, data as-of and signing time, and the engine commit.
2. It signs each certificate with EIP-191 `personal_sign` (secp256k1) over a canonical message that includes the contract account id.
3. The contract in `contract/` (Rust, near-sdk 5.30.1) recovers the signer with `env::ecrecover`, checks it is a registered signer, checks the fund_id is registered to that account and manager (so a fund cannot rename itself), checks the signing time moves forward, and stores the certificate. Its certificate history is the score engine's cert store.

`npm run e2e` runs steps 1 to 3 offline: it writes `contract/tests/fixtures/engine-certificates.json` with a fixed throwaway test key and runs the contract tests, which verify every engine-signed certificate and reject one with an edited score. The contract also handles one-time loan pledges as NEP-171 tokens and the blocked-attempt counter; see `contract/README.md`.

## TEE underwriter (NEAR AI Cloud)

Each pledged loan's private document is read by a model running in a NEAR AI Cloud TEE (`Qwen/Qwen3-VL-30B-A3B-Instruct`, NEAR-operated). The model compares the document with the fund's claimed loan data and answers only `{loan_hash, verdict: pass|flag, anomalies}`. The TEE signs `"<model>:<sha256(request)>:<sha256(response)>"` (EIP-191). Only the request hash, the verdict-only reply and the signature go on chain; the document never does. The contract recomputes the reply hash, recovers the signer, and accepts the verdict only from a registered TEE signer and only for the loan_hash the reply names. The score reads the latest stored verdict: a flag makes the loan unverified; no verdict is pending for 7 days after the pledge, then unverified (`spec/nav/NAV_SPEC.md` R25).

1. `npm run tee:demo` (no key needed). You should see the three tampered documents flagged (altered amount, hidden prompt injection, duplicate re-issued as new), `honest documents: 16 of 16 pass, every signature checked`, and Harbor going from `99.17 green` to `51.59 red` when the TEE flags H-RE-01. It replays the TEE-signed replies in `tee/fixtures/verdicts.json` and re-checks every signature locally.
2. With a NEAR AI Cloud key in `NEAR_AI_CLOUD_API_KEY`: `npm run tee:attest` fetches gateway and model attestation with a fresh nonce and prints a PASS line per check (Intel TDX quote and TCB status, debug mode off, signer and nonce bound in the quote, measured config, RTMR3 event log, NVIDIA GPU attestation). `npm run tee:underwrite -- --only T` reruns the tampered documents through the TEE live.

Phase 1 trust path: the admin registers the TEE signing address after the off-chain attestation check (`add_tee_signer`, with the nonce and time as `attestation_ref`). The demo documents in `tee/docs/` are fictional and watermarked "DEMO, NOT A REAL DOCUMENT".

## Testnet run

`npm run e2e:testnet` does the whole flow live on NEAR testnet, on a contract instance of your own. Testnet only; the script refuses any account that does not end in `.testnet`.

1. Build the contract (needs Rust 1.95+, the `wasm32-unknown-unknown` target and cargo-near 0.23.0, which needs `libudev-dev` and `pkg-config` on Linux):
   `cd contract && cargo near build non-reproducible-wasm && cd ..`
2. Create a throwaway testnet account funded by the faucet (about 10 testnet NEAR). Its key goes to `~/.near-credentials/testnet/`, never into the repo:
   `cargo near create-dev-account use-specific-account-id <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
3. Run: `TRUENAV_TESTNET_ACCOUNT=<name>.testnet npm run e2e:testnet`

You should see, with an explorer link per transaction:

- sub-accounts `registry.<name>` (the contract, about 4 NEAR), `harbor.<name>` and `meridian.<name>` created; the contract deployed and initialized with your account as admin and servicer;
- a fresh certificate signer registered. **This is a test key, not TEE**: a random secp256k1 key the script keeps in `.keys/` (gitignored). It is replaced by a key proven to run in a NEAR AI Cloud TEE (next step);
- all 16 demo loans pledged by their fingerprint (one NEP-171 token each), the attested TEE signer registered, and the 16 TEE verdicts verified on chain; a TEE reply edited from flag to pass is rejected;
- both funds registered, scored from the TEE verdicts read back from chain, the engine's signed certificates stored, and `PASS` lines showing they read back from chain as Harbor 99.17 green and Meridian 42.84 red;
- the same certificate signed with the public fixed test key (32 bytes of 0x07) rejected: `PASS public test key rejected: signer not registered`;
- Meridian tries to pledge Harbor's H-RE-03 and is refused with `already pledged elsewhere`, Meridian's blocked-attempt count goes up by one, Harbor gets an alert that does not name Meridian;
- `Run record: out/testnet-run.json (all checks passed)`.

Running it again reuses the accounts, redeploys the code with the state kept (an older deployment is upgraded with `migrate`), and adds one more certificate and one more refused pledge. Admin, servicer and pledge calls attach exactly 1 yoctoNEAR (full-access key check).

Loan fingerprint: `loan_hash = sha256("truenav-demo-v1|" + asset type + "|" + document id)`. This is a demo fingerprint and is guessable for real identifiers; production uses an HMAC computed inside a TEE (next step).

### Live instance (6 Nov 2026, upgraded with TEE verdicts the same day)

- Contract: [`registry.tnlab-07775b.testnet`](https://explorer.testnet.near.org/accounts/registry.tnlab-07775b.testnet)
- Certificate signer: `0xde953f62fd6efc50937caa3772ed734a3d72f96f` (test key, not TEE)
- Deploy and init: [B2bNN42K...](https://explorer.testnet.near.org/transactions/B2bNN42KTPzdZsUVz6Wzk2Hdq3ukjrp7WkZJqi1dL1zE)
- Signer registered: [DSDqCMvn...](https://explorer.testnet.near.org/transactions/DSDqCMvnBTJ1Sr8pENuEAxfEHRdFfHMdhzksdZtMeHjz)
- Harbor certificate stored: [BTwUomTE...](https://explorer.testnet.near.org/transactions/BTwUomTE86dYphxZW6kYe39uZneu2PdQPzwDNfPT48zg)
- Meridian certificate stored: [qDaCGQwZ...](https://explorer.testnet.near.org/transactions/qDaCGQwZ1Y7vP27rLDqFfH6miomwZAAvCxjwNzk7zhs)
- Public test key rejected: [BAjUjAqy...](https://explorer.testnet.near.org/transactions/BAjUjAqyERmCSRzpwymFBwnGtPy5MrgLJV8C2KsD4w1x)
- Harbor pledge (token minted): [7FxxtutR...](https://explorer.testnet.near.org/transactions/7FxxtutRugy3NHvQVeCC8Q5gLGob6VBr1FZJHqJJiiVR)
- Meridian refused, attempt counted: [24MiWPZC...](https://explorer.testnet.near.org/transactions/24MiWPZCzbH45mc433LAY8DHkw2hjKSVR8UcRFDFMhar)
- Latest deploy: [FFAAty6n...](https://explorer.testnet.near.org/transactions/FFAAty6nzrPKaP2eBEZz36hHCayv3D5CWCEGBpwYLcus)
- Edited TEE verdict rejected: [3XdaXxtt...](https://explorer.testnet.near.org/transactions/3XdaXxttBezPWcmBQPEwt2dPLg9moJuzcBEvJREw7938)
- Meridian refused on Harbor's H-RE-03: [2DNEmE8B...](https://explorer.testnet.near.org/transactions/2DNEmE8BhGX6rRH5MgYPBogMJoYnsi2rhFdms7NMN1Zu)
- TEE signer: `0x2665cce942fa427ef30d87f4b0bff67fb7645462` (Qwen/Qwen3-VL-30B-A3B-Instruct); upgrade with migrate: [Au4SXuyv...](https://explorer.testnet.near.org/transactions/Au4SXuyvRBHgHRdKEREvr5Y62oumgSC2QhyfNYyKiera); signer registered: [6DKxf9zV...](https://explorer.testnet.near.org/transactions/6DKxf9zVyrMhu9sKHLNU1whazCwt4RC734i6wwy1EcKy); TEE verdict H-RE-01: [51HdEHZd...](https://explorer.testnet.near.org/transactions/51HdEHZdv3Se2XTLQSEeU9axWWjS3M1hcAcgWrLjbx6y)

### Investor view from chain

`npm run chain:read` (no account or key). It reads the live contract and recomputes each fund's TrueNav score from chain data only: TEE verdicts, pledge times, pledge tokens, blocked attempts and alerts. You should see Harbor `99 green (raw 99.17)` and Meridian `43 red (raw 42.84)`, each followed by `Signed certificate on chain: ... -> matches the recomputed score`. Point it at your own instance with `TRUENAV_CONTRACT=registry.<name>.testnet`. The reader is `web/chain.mjs` (plain fetch, runs in the browser too).

### Verify the deployed code

The contract is built reproducibly (NEP-330): `contract/Cargo.toml` pins the build image `sourcescan/cargo-near:0.22.0-rust-1.99.0` by digest.

1. `cd contract && cargo near build reproducible-wasm` (needs Docker and network access to crates.io). It prints `SHA-256 checksum bs58: <hash>` for the checked-out commit.
2. Compare with the code hash on chain: `curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"registry.tnlab-07775b.testnet"}}'` returns the same value as `"code_hash"` when you build the commit named in step 3.
3. The contract names its own source: view method `contract_source_metadata` returns the repository commit, the build image and the build command.

Read it yourself without any account:

```
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"registry.tnlab-07775b.testnet","method_name":"get_attempts_page","args_base64":"'$(printf '{"fund_id":"meridian-yield-fund","from_index":0,"limit":10}' | base64 -w0)'"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

Scores are computed as of the demo valuation time in `spec/nav/fixtures.json`; certificates are signed at run time, because the contract refuses a signing time in the future.

## Docs

- `ARCHITECTURE.md`: diagram and where each part lives.
- `TRUST_MODEL.md`: what is proven on chain, what is trusted, privacy, what is not claimed.
- `THREAT_MODEL.md`: attacks, mitigations and the test that shows each.
- `SECURITY.md`: reporting and practices. `WHY_NEAR.md`: what NEAR enables here.

## Limits

- Testnet only; fictional funds, loans and documents.
- One admin key registers signers and funds; the certificate signer is a test key, not TEE; the TEE signer is registered after an off-chain attestation check (phase 1).
- The loan fingerprint is a demo hash, guessable for real identifiers.
- The TEE underwriter is an LLM: it can miss a forgery or flag an honest document.
- PD tables are demo, not calibrated; TrueRange assumes independent defaults.

## Prior art

Existing proof-of-asset and proof-of-reserve dashboards for tokenized funds publish holdings and a last-update time. TrueNav adds a cross-fund pledge registry that refuses a second pledge, a TEE check of each private loan document, and a 0 to 100 score of how far the reported NAV can be trusted (gap, coverage, freshness, blocked attempts).

## Built with

near-sdk 5.30.1 and near-contract-standards (Rust), near-api-js 7.3.1, near-sandbox 0.3.4, @noble/curves and @noble/hashes, @phala/dcap-qvl (TDX quote verification), NEAR AI Cloud (`Qwen/Qwen3-VL-30B-A3B-Instruct`), NVIDIA NRAS (GPU attestation), cargo-near and the sourcescan/cargo-near build image. Exact versions are pinned in `package-lock.json` and `contract/Cargo.lock`.

AI disclosure: the code, tests and docs were written with AI coding agents (Claude Code and others), directed and reviewed by the team. Outside models gave second opinions on scoring rules and audited the contract (GPT-5.5, Gemini 3.1 Pro, Claude Opus 5.5 via OpenRouter); every finding was checked by running code.

All data in this repository is fictional demo data.

License: Business Source License 1.1 (see LICENSE). Non-production use, including evaluation and judging, is permitted.
