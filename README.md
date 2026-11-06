# TrueNav

TrueNav checks tokenized private credit funds on NEAR. It proves two things to an investor without revealing the underlying loans:

1. Every loan in a fund is pledged only once, across all funds using TrueNav.
2. The fund's reported NAV is checked against TrueVal, recomputed from verified loans only.

Three numbers, each decided by owner 5 Nov 2026:

- TrueVal: what the fund's loans are worth after expected losses. Model estimate, not fair value.
- TrueRange: where TrueVal likely falls, assuming loans default independently. Demo estimate.
- TrueNav score: how far you can trust the fund's reported NAV, 0 to 100.

PD tables are demo, not calibrated. The 30 days, 50% and 10% thresholds are TrueNav's own policy, not agency figures. Rules: `spec/nav/NAV_SPEC.md`. Engine and tests: `engine/`, run with `npm test`.

Built at NEAR HACKATHON 2026 by TrueNav Labs. Tracks: Privacy & Private AI, Open Innovation.

## Try it: no keys, no account (start here)

Needs Node 18 or later. Every step below runs from a fresh clone with no API key and no NEAR account; CI runs the same steps (`judge-path` job).

1. `npm ci`
2. `npm test`. You should see `# pass 144` and "All worked example numbers match." (Harbor Credit Fund 99.17 green, Meridian Yield Fund 42.84 red).
3. `npm run demo`. Replays the TEE-signed verdicts and re-checks every signature: the three tampered documents are flagged, `honest documents: 16 of 16 pass, every signature checked`, and Harbor goes from `99.17 green` to `51.59 red` when the TEE flags one of its loans.
4. `npm run chain:read`. Reads the live contract on NEAR testnet and recomputes both scores from chain data only; you should see each fund followed by `-> matches the recomputed score`.
5. `npm run verify:attestation`. Checks the published NEAR AI Cloud attestation yourself: the Intel TDX quote, that the TEE signing key and nonce are bound into it, the measurements and the NVIDIA GPU evidence, that this key signed every verdict, and that it is the key the live contract accepts. Ends with `Attestation verified`.
6. `npm run eval`. Re-checks the 86 signed replies of the TEE eval and prints precision and recall (see below).

The contract tests need Rust: `npm run e2e` (engine output, signed certificates, 80 contract tests).

## How it works

### Engine to contract

1. `certify/run.mjs` scores the demo funds with `engine/src/score.mjs` and turns each result into a certificate: fund_id, fund account, manager, status, score, band, raw x 100, TrueVal, TrueRange, Policy NAV and headline in integer cents, blocked attempts, data as-of and signing time, and the engine commit.
2. It signs each certificate with EIP-191 `personal_sign` (secp256k1) over a canonical message that includes the contract account id.
3. The contract in `contract/` (Rust, near-sdk 5.30.1) recovers the signer with `env::ecrecover`, checks it is a registered signer, checks the fund_id is registered to that account and manager (so a fund cannot rename itself), checks the signing time moves forward, and stores the certificate. Its certificate history is the score engine's cert store.

`npm run e2e` runs steps 1 to 3 offline: it writes `contract/tests/fixtures/engine-certificates.json` with a fixed throwaway test key and runs the contract tests, which verify every engine-signed certificate and reject one with an edited score. The contract also handles one-time loan pledges as NEP-171 tokens and the blocked-attempt counter; see `contract/README.md`.

### TEE underwriter (NEAR AI Cloud)

Each pledged loan's private document is read by a model running in a NEAR AI Cloud TEE (`Qwen/Qwen3-VL-30B-A3B-Instruct`, NEAR-operated). The model compares the document with the fund's claimed loan data and answers only `{loan_hash, binding, verdict: pass|flag, anomalies}`. The TEE signs `"<model>:<sha256(request)>:<sha256(response)>"` (EIP-191). Only the request hash, the verdict-only reply and the signature go on chain; the document never does.

The contract accepts a verdict only when:

- the servicer submits it (a fund cannot grade itself or a rival), on a loan that is pledged;
- the signature recovers to a registered TEE signer for that model;
- the reply names the same loan_hash and carries the binding `truenav-verdict-v1|<this contract>|<this network>|<expiry>`, unexpired and valid for at most 30 days;
- the signed reply has not been submitted before.

Every stored verdict records the signer, the model, the attestation report hash, the expiry and the submitter. The score reads the latest verdict for the current pledge: a flag makes the loan unverified; no verdict is pending for 7 days after the pledge, then unverified (`spec/nav/NAV_SPEC.md` R25). A flag clears only with a later servicer pass from a different request; the servicer controls the request anyway, so this is a speed bump, not a lock.

With a NEAR AI Cloud key in `NEAR_AI_CLOUD_API_KEY`: `npm run tee:attest` attests the TEE with a fresh nonce; `node tee/underwrite.mjs --contract <id> --out <file>` signs verdicts bound to your contract. The recorded verdicts expire 30 days after signing; CI fails 10 days before (`npm run check:fixtures`).

### TEE eval (86 documents)

`tee/eval/`: 40 honest documents and 46 tampered ones (amount edits, id edits, asset swaps, six prompt-injection styles, duplicates, unreadable scans), one first answer each from the attested TEE, every reply signed. Result: recall 100% (46 of 46 tampered flagged), precision 93.9%, false positive rate 7.5% (3 honest title reports flagged as duplicates). Findings, open items and limits: `tee/eval/REPORT.md`.

### Testnet run (your own instance)

`npm run e2e:testnet` does the whole flow live on NEAR testnet, on a contract instance of your own. Testnet only; the script refuses any account that does not end in `.testnet`.

1. Build the contract (needs Rust 1.95+, the `wasm32-unknown-unknown` target and cargo-near 0.23.0, which needs `libudev-dev` and `pkg-config` on Linux):
   `cd contract && cargo near build non-reproducible-wasm && cd ..`
2. Create a throwaway testnet account funded by the faucet (about 10 testnet NEAR). Its key goes to `~/.near-credentials/testnet/`, never into the repo:
   `cargo near create-dev-account use-specific-account-id <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
3. Run: `TRUENAV_TESTNET_ACCOUNT=<name>.testnet npm run e2e:testnet`

You should see, with an explorer link per transaction: sub-accounts for the contract, both funds, the pauser and the servicer; roles set (`PASS roles: ...`); a fresh certificate signer (**a test key, not TEE**, kept in gitignored `.keys/`); both funds registered and all 16 demo loans pledged (one NEP-171 token each); certificates stored and read back as Harbor 99.17 green and Meridian 42.84 red; a certificate signed with the public fixed test key rejected; Meridian's pledge of Harbor's H-RE-03 refused with `already pledged elsewhere` and counted; `Run record: out/testnet-run.json (all checks passed)`. TEE verdicts are bound to one contract, so on your own instance the loans stay pending (score unchanged) unless you sign verdicts for it with a NEAR AI Cloud key.

### Live instance

Contract [`registry.tnlab-dd2a56.testnet`](https://explorer.testnet.near.org/accounts/registry.tnlab-dd2a56.testnet), deployed 6 Nov 2026. Roles: admin and registrar `tnlab-dd2a56.testnet`, pauser `pauser.tnlab-dd2a56.testnet`, servicer `servicer.tnlab-dd2a56.testnet`. Certificate signer `0x287be84d0a5adf8625f6f46e8e45c6706a1da2d0` (test key, not TEE). TEE signer `0x2665cce942fa427ef30d87f4b0bff67fb7645462` (attestation report hash `6914a054ec8b29ce...`).

- Deploy and init: [7aeCGRHJ...](https://explorer.testnet.near.org/transactions/7aeCGRHJ3e29k5UZgGFdxsJnAwAENcrvERuhtHYdCauE)
- Pauser role moved: [C6ENiXd7...](https://explorer.testnet.near.org/transactions/C6ENiXd7h5jrjyGqo5tDYLqPAip7c4LPcriSLWd5iiJx)
- Servicer role moved: [99HzaxEJ...](https://explorer.testnet.near.org/transactions/99HzaxEJEuuAeAKNsmBTdG7ZtM6ZXagvpPhV73C9Kgco)
- TEE signer registered by the registrar: [CMJWpFrN...](https://explorer.testnet.near.org/transactions/CMJWpFrNGm8BFyXpEKqTRWL5vp2mdZhY859hBmKJPB3F)
- Servicer submits the TEE verdict for H-RE-01: [J8X8dSNG...](https://explorer.testnet.near.org/transactions/J8X8dSNG5DD6U6kcELEQtfBdBRNVaJ3iWR8AuGSk1CSW)
- Rival submits a genuine TEE flag on Harbor's loan: rejected: [F5pH6F8a...](https://explorer.testnet.near.org/transactions/F5pH6F8adz4sTCkerSz8XuMN5Pw5DwLXMUAhScDS7mJE)
- Edited TEE verdict: rejected: [G3LiR4by...](https://explorer.testnet.near.org/transactions/G3LiR4bypH6635ZMEYh3rCWaSFWyc5R9mSXDCLxPHFk9)
- Harbor certificate stored: [DFYV31zA...](https://explorer.testnet.near.org/transactions/DFYV31zABx2CC1zi7R8gy13KjeYa1jHnTnBQPTfuTGwQ)
- Public test key certificate: rejected: [2cUYTan2...](https://explorer.testnet.near.org/transactions/2cUYTan2sx2oGL3686ft7ieAACi99YsABdSwvmWu5tNd)
- Meridian pledges Harbor's loan: refused, attempt counted: [FYXZ447c...](https://explorer.testnet.near.org/transactions/FYXZ447c8vDh3HP3vCgiems5Z8ganc46M1EvnQHC2PdS)

The first instance, `registry.tnlab-07775b.testnet`, ran the earlier contract layout and is kept as history.

### Investor view from chain (no key)

`npm run chain:read` (no account or key). It reads the live contract and recomputes each fund's TrueNav score from chain data only: TEE verdicts, pledge times, pledge tokens, blocked attempts and alerts. You should see Harbor `99 green (raw 99.17)` and Meridian `43 red (raw 42.84)`, each followed by `Signed certificate on chain: ... -> matches the recomputed score`. Point it at your own instance with `TRUENAV_CONTRACT=registry.<name>.testnet`. The reader is `web/chain.mjs` (plain fetch, runs in the browser too; falls back to two backup RPC endpoints from the NEAR docs if the default fails).

### Verify the deployed code

The contract is built reproducibly (NEP-330): `contract/Cargo.toml` pins the build image `sourcescan/cargo-near:0.22.0-rust-1.99.0` by digest.

1. `cd contract && cargo near build reproducible-wasm` (needs Docker and network access to crates.io). It prints `SHA-256 checksum bs58: <hash>` for the checked-out commit.
2. Compare with `code_hash` from `curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"registry.tnlab-dd2a56.testnet"}}'` when you build the commit named in step 3.
3. The contract names its own source: view method `contract_source_metadata` returns the repository commit, the build image and the build command.

Read it yourself without any account:

```
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"registry.tnlab-dd2a56.testnet","method_name":"get_attempts_page","args_base64":"'$(printf '{"fund_id":"meridian-yield-fund","from_index":0,"limit":10}' | base64 -w0)'"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

Scores are computed as of the demo valuation time in `spec/nav/fixtures.json`; certificates are signed at run time, because the contract refuses a signing time in the future.

## Roles, pause, upgrades and storage

- Roles: **admin** assigns roles and registers funds (the allowlist: only registered fund accounts can pledge); **registrar** adds and removes certificate and TEE signers; **pauser** pauses and unpauses; **servicer** releases repaid loans and submits TEE verdicts. Each role is refused every other role's job (`contract/tests/roles.rs`). Sensitive calls need exactly 1 yoctoNEAR, so only a full-access key can make them.
- Pause stops pledges, releases, certificate and verdict submissions; views and role changes keep working.
- Upgrades: the code can be changed only with the contract account's full-access key. On testnet that is one key held by the operator. For mainnet: the contract account controlled by a multisig or DAO, upgrades announced and built reproducibly, and the full-access key removed after deployment.
- Storage: on testnet the contract pays for storage and only allowlisted funds can write, which bounds spam. For mainnet: callers attach storage deposits.

## Docs

- `ARCHITECTURE.md`: diagram and where each part lives.
- `TRUST_MODEL.md`: what is proven on chain, what is trusted, privacy, what is not claimed.
- `THREAT_MODEL.md`: attacks, mitigations and the test that shows each.
- `SECURITY.md`: reporting and practices. `AUDIT_FINDINGS.md`: every audit finding, fixed or accepted. `WHY_NEAR.md`: what NEAR enables here.
- `tee/eval/REPORT.md`: TEE underwriter eval and red-team report.

## Limits

- Testnet only; fictional funds, loans and documents.
- The roles sit on testnet accounts held by the operator; the certificate signer is a test key, not TEE; the TEE signer is registered by the registrar after an attestation check that anyone can repeat (`npm run verify:attestation`), not by an on-chain quote check.
- Privacy: the demo loan fingerprint `sha256("truenav-demo-v1|" + asset type + "|" + document id)` is guessable for real identifiers. Real use needs salted commitments: an HMAC whose key never leaves a TEE (next step). Pledges, verdicts, attempts and alerts are public chain state; they never name the other fund or show a loan, but they are not hidden.
- The TEE underwriter is an LLM: in the eval it flagged 3 of 40 honest documents (see `tee/eval/REPORT.md`).
- With chain data, a loan counts only for the fund whose on-chain pledge holds it. Offline mode (no chain data, used by `npm test`) falls back to "verified in neither" for an nft_id two funds list; offline mode is for tests and the chain path is the real score.
- PD tables are demo, not calibrated; TrueRange assumes independent defaults.

## Next steps

HMAC loan fingerprints inside a TEE (OutLayer); certificate signer running in a TEE; on-chain quote verification; a multisig or DAO admin; storage deposits; the Chain Signatures certificate mirror to EVM chains and NEAR Intents settlement (not built, to keep the surface small).

## Prior art

Existing proof-of-asset and proof-of-reserve dashboards for tokenized funds publish holdings and a last-update time. TrueNav adds a cross-fund pledge registry that refuses a second pledge, a TEE check of each private loan document, and a 0 to 100 score of how far the reported NAV can be trusted (gap, coverage, freshness, blocked attempts).

## Built with

near-sdk 5.30.1 and near-contract-standards (Rust), near-api-js 7.3.1, near-sandbox 0.3.4, @noble/curves and @noble/hashes, @phala/dcap-qvl (TDX quote verification), NEAR AI Cloud (`Qwen/Qwen3-VL-30B-A3B-Instruct`), NVIDIA NRAS (GPU attestation), cargo-near and the sourcescan/cargo-near build image. Exact versions are pinned in `package-lock.json` and `contract/Cargo.lock`.

AI disclosure: the code, tests and docs were written with AI coding agents (Claude Code and others), directed and reviewed by the team. Outside models gave second opinions on scoring rules and audited the contract (GPT-5.5, Gemini 3.1 Pro, Claude Opus 5.5 via OpenRouter); every finding was checked by running code.

All data in this repository is fictional demo data.

License: Business Source License 1.1 (see LICENSE). Non-production use, including evaluation and judging, is permitted.
