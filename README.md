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

Needs Node 18 or later. Every step below runs from a fresh clone with no API key and no NEAR account. In CI, the `engine` job runs steps 2 and 3 (step 3 as `npm run tee:demo`, the same script) and `npm run eval`; the `judge-path` job runs steps 3 to 8 from a fresh checkout with no secrets set.

1. `npm ci`
2. `npm test`. You should see `# pass 290` and `# fail 0`, then "All worked example numbers match." (Harbor Credit Fund 99.17 green, Meridian Yield Fund 42.84 red).
3. `npm run demo`. Replays the TEE-signed verdicts and re-checks every signature: the three tampered documents are flagged, `honest documents: 16 of 16 pass, every signature checked`, and Harbor goes from `99.17 green` to `51.59 red` when the TEE flags one of its loans.
4. `npm run chain:read`. Reads the live contract on NEAR testnet and recomputes both scores from chain data only; you should see each fund followed by `-> matches the recomputed score`.
5. `npm run verify:attestation`. Checks the published NEAR AI Cloud attestation yourself: the Intel TDX quote, that the TEE signing key and nonce are bound into it, the measurements and the NVIDIA GPU evidence, that this key signed every verdict, and that it is the key the live contract accepts. Ends with `Attestation verified`.
6. `npm run verify:fingerprints`. Checks every loan fingerprint against the public attestation of the OutLayer TEE run that produced it: each Intel TDX quote with Intel collateral, its report data bound to that run (code, input, output, caller), the worker's measurements on OutLayer's approved list, and that `tee/loans.json` uses exactly these fingerprints. Ends with `Fingerprints verified`.
7. `npm run check:fixtures`. Every recorded TEE verdict set is valid for at least 10 more days, and the published attestation report is the one the live set was signed under.
8. `npm run check:chain-replies`. Decodes every `submit_verdict` call ever sent to the live contract, including failed ones, and checks that no reply carries anything beyond the allowed keys. Ends with `PASS every submit_verdict reply from our accounts is within the allowed keys`.
9. `npm run eval`. Re-checks the 126 signed replies of the TEE eval (main set and frozen hold-out set) and prints precision and recall, raw and grounded (see below). `npm run eval -- 2026-11-06` replays the earlier 6 Nov run.

The contract tests need Rust 1.95 or later (near-sdk 5.30.1's minimum; `rust-toolchain.toml` pins 1.97.0, the version CI uses): `npm run e2e` (engine output, signed certificates, then `cargo test`: 91 contract tests). The circuit-breaker vault has its own: `cd vault && cargo test` (5 tests). CI's `contract` job runs both, with clippy and a RustSec audit; the `sandbox` job runs the full flow on a local NEAR node.

## How it works

### Engine to contract

1. `certify/run.mjs` scores the demo funds with `engine/src/score.mjs` and turns each result into a certificate: fund_id, fund account, manager, status, score, band, raw x 100, TrueVal, TrueRange, Policy NAV and headline in integer cents, blocked attempts, data as-of and signing time, and the engine commit.
2. It signs each certificate with EIP-191 `personal_sign` (secp256k1) over a canonical message that includes the contract account id.
3. The contract in `contract/` (Rust, near-sdk 5.30.1) recovers the signer with `env::ecrecover`, checks it is a registered signer, checks the fund_id is registered to that account and manager (so a fund cannot rename itself), checks the signing time moves forward, and stores the certificate. Its certificate history is the score engine's cert store.

`npm run e2e` runs steps 1 to 3 offline: it writes `contract/tests/fixtures/engine-certificates.json` with a fixed throwaway test key and runs the contract tests, which verify every engine-signed certificate and reject one with an edited score. The contract also handles one-time loan pledges as NEP-171 tokens and the blocked-attempt counter; see `contract/README.md`.

### TEE underwriter (NEAR AI Cloud)

Each pledged loan's private document is read by a model running in a NEAR AI Cloud TEE (`Qwen/Qwen3-VL-30B-A3B-Instruct`, NEAR-operated). The model compares the document with the fund's claimed loan data and answers only fixed keys (`tee/reply.mjs`): the loan_hash, the binding, six check results (ok or fail), a line number for duplicate evidence, the verdict and the anomaly codes. The TEE signs `"<model>:<sha256(request)>:<sha256(response)>"` (EIP-191). Only the request hash, the verdict-only reply and the signature go on chain; the document never does.

The contract accepts a verdict only when:

- the servicer submits it (a fund cannot grade itself or a rival), on a loan that is pledged;
- the signature recovers to a registered TEE signer for that model;
- the reply names the same loan_hash and carries the binding `truenav-verdict-v1|<this contract>|<this network>|<expiry>`, unexpired and valid for at most 30 days;
- the signed reply has not been submitted before.

Every stored verdict records the signer, the model, the attestation report hash, the expiry and the submitter. The score reads the latest verdict for the current pledge: a flag makes the loan unverified; no verdict is pending for 7 days after the pledge, then unverified (`spec/nav/NAV_SPEC.md` R25). A flag clears only with a later servicer pass from a different request; the servicer controls the request anyway, so this is a speed bump, not a lock.

With a NEAR AI Cloud key in `NEAR_AI_CLOUD_API_KEY`: `npm run tee:attest` attests the TEE with a fresh nonce; `node tee/underwrite.mjs --contract <id> --out <file>` signs verdicts bound to your contract. The recorded verdicts expire 30 days after signing; CI fails 10 days before (`npm run check:fixtures`).

### TEE eval (86 documents plus a 40-document hold-out)

`tee/eval/`: 40 honest documents and 46 tampered ones (amount edits, id edits, asset swaps, six prompt-injection styles, duplicates, unreadable scans); `tee/eval/holdout/`: 40 more in new wording (20 honest with near-miss words such as "certified by" and "INVOICE COPY"), frozen in its own commit before the current prompt ran. One first answer each from the attested TEE, every reply signed. Before and after (main set). The 6 Nov column is printed by `npm run eval -- 2026-11-06` (the kept run, `tee/eval/results-2026-11-06.json`), the 7 Nov column and the hold-out row by `npm run eval`:

| | 6 Nov | 7 Nov |
| --- | --- | --- |
| Honest documents flagged (false positives) | 3 of 40 (7.5%), all `duplicate_document` with no line to point at | 0 of 40 |
| Tampered documents flagged (recall) | 46 of 46 | 46 of 46 |
| Replies echoing document fields that would reach public transaction data | 22 of 86 replies (66 field values) | 0 of 86 |
| Frozen hold-out set (40 new documents, 20 honest) | not run | 0 of 20 honest flagged, 20 of 20 tampered flagged |

What changed: the model must give the number of the evidence line for a duplicate flag (never a quote), only the exact words count, a repeated line or watermark is not a duplicate, and the reply may hold only fixed keys. Raw and grounded counts are the same on 7 Nov: every duplicate flag pointed at a line with the phrase.

Read the 7 Nov numbers with care (limits, word for word from the eval report): 126 synthetic documents in four templates, written by the same team that wrote the prompt; real loan documents vary far more. One model, one prompt, one run each; LLM answers can vary between runs even at temperature 0. A perfect score here means no failure was found in these documents, not that the underwriter cannot fail. Findings, what changed and limits: `tee/eval/REPORT.md`.

### Testnet run (your own instance)

`npm run e2e:testnet` does the whole flow live on NEAR testnet, on a contract instance of your own. Testnet only; the script refuses any account that does not end in `.testnet`.

1. Build the contract (needs Rust 1.95+, the `wasm32-unknown-unknown` target and cargo-near 0.23.0, which needs `libudev-dev` and `pkg-config` on Linux):
   `cd contract && cargo near build non-reproducible-wasm && cd ..`
2. Create a throwaway testnet account funded by the faucet (about 10 testnet NEAR). Its key goes to `~/.near-credentials/testnet/`, never into the repo:
   `cargo near create-dev-account use-specific-account-id <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
3. Run: `TRUENAV_TESTNET_ACCOUNT=<name>.testnet npm run e2e:testnet`

You should see, with an explorer link per transaction: sub-accounts for the contract, both funds, the pauser and the servicer; roles set (`PASS roles: ...`); a fresh certificate signer (**a test key, not TEE**, kept in gitignored `.keys/`); both funds registered and all 16 demo loans pledged (one NEP-171 token each); certificates stored and read back as Harbor 99.17 green and Meridian 42.84 red; a certificate signed with the public fixed test key rejected; Meridian's pledge of Harbor's H-RE-03 refused with `already pledged elsewhere` and counted; `Run record: out/testnet-run.json (all checks passed)`. TEE verdicts are bound to one contract, so on your own instance the loans stay pending (score unchanged) unless you sign verdicts for it with a NEAR AI Cloud key.

### Live instance

Contract [`registry.tnlab-718ca9.testnet`](https://explorer.testnet.near.org/accounts/registry.tnlab-718ca9.testnet), deployed 7 Nov 2026 and redeployed with state kept from truenav commit `d37b9d2` (code hash `Foc9f2oJ8Ja1ddKSt91kXTxVm33nRBMjx3e4LHMP13EW`; `contract_source_metadata` links that commit). Every loan_hash on it is a private fingerprint from the OutLayer TEE (`npm run verify:fingerprints`). Roles: admin, registrar and pauser `truenav-admin.testnet` (the owner's account), servicer `servicer.tnlab-718ca9.testnet` (also the account that requests fingerprints). The contract account holds two full-access keys: the owner's and the operator's backup. Certificate signer `0x6b5be4ca4d2a0c454fd2aa30f8b47577f8d21c7b` (test key, not TEE). TEE signer `0x2665cce942fa427ef30d87f4b0bff67fb7645462` (attestation report hash `529cbac44368739b...`, published and re-checkable with `npm run verify:attestation`). Every `submit_verdict` transaction on it holds only the allowed reply keys (`npm run check:chain-replies`).

- Code redeployed from `d37b9d2` (state kept): [8SdmXZjU...](https://explorer.testnet.near.org/transactions/8SdmXZjUrZKpt75XS4ugoZ7DsLiqsFqBDERANHs9CL3e)
- Deploy and init: [7MgbSEK9...](https://explorer.testnet.near.org/transactions/7MgbSEK9oLZb3a2R5m1Jx9Jsrk8xVR26Tz8Nhb6yBZHM)
- TEE signer registered by the registrar: [H2kjsK24...](https://explorer.testnet.near.org/transactions/H2kjsK24my1CQyj3CMgMzF7hZdc2cA34ndDNhRiGgW4r)
- Servicer submits the TEE verdict for H-RE-01: [DnNE4rm7...](https://explorer.testnet.near.org/transactions/DnNE4rm7imbYnygoRpTTw9eGCroTaxS1iacbYGFm2czd)
- Rival submits a genuine TEE flag on Harbor's loan: rejected: [6uRV227L...](https://explorer.testnet.near.org/transactions/6uRV227LzHRUDp6pVBTYqEAygEoGAPBjS4zBDNg3JVrP)
- Edited TEE verdict: rejected: [2Jm59t8Y...](https://explorer.testnet.near.org/transactions/2Jm59t8YoDKYM3wQuVYbjf8K8sAbwiuTPCjR6SdYZHVH)
- Harbor certificate stored: [86jUBckM...](https://explorer.testnet.near.org/transactions/86jUBckMG6eKcXYuaQKCejmT8y7you3sDPYpvECxgqjT)
- Public test key certificate: rejected: [CjVff4Ct...](https://explorer.testnet.near.org/transactions/CjVff4CtcfKTEqJgXdA7FUpkz4tFDSFsGXYs7NtN9syv)
- Meridian pledges Harbor's loan: refused, attempt counted: [BKLPfvpi...](https://explorer.testnet.near.org/transactions/BKLPfvpiyvue4ZXTfLRfDuhyyT3E9hrbsoxJiHzY7aqd)
- Roles handed to the owner: [HzkL7Fq2...](https://explorer.testnet.near.org/transactions/HzkL7Fq2NK8hGcVSwUfUibWp16ie2T1S3zePfupRpLiX) (owner key added), [QVCbH2q6...](https://explorer.testnet.near.org/transactions/QVCbH2q6oFVV4kJLUWY8cjUWFJpdshFdw5XEE1nLSba) (registrar), [4HzBZZvi...](https://explorer.testnet.near.org/transactions/4HzBZZviMeWHvhzCiwf1DMTV7HXBuPkq3mWW9uvm7N6G) (pauser), [AfGCwbQ3...](https://explorer.testnet.near.org/transactions/AfGCwbQ3cdRuaJC7pjLErLW84xz97TfNN6DjbvJV6bEw) (admin)

Earlier instances, kept as history: `registry.tnlab-07775b.testnet` (first contract layout); `registry.tnlab-dd2a56.testnet` (its TEE replies echoed document fields into public transaction data, AUDIT_FINDINGS 21); `registry.tnlab-94f355.testnet` (its TEE signer's registered attestation hash points at a report overwritten before it was published); `registry.tnlab-22cfb2.testnet` (correct, but its loan hashes are the old guessable demo fingerprint; replaced so old and new hashes never sit side by side on one contract).

### NAV circuit breaker (a vault that reads the score)

`vault/` is a testnet fund-share vault that reads the fund's latest TrueNav certificate from the registry before it takes money. A subscription is refused, and the deposit refunded in the same transaction, when the certificate is missing, not scored, red, or older than the vault's maximum age (default 7 days, the engine's 168-hour freshness window; set by the vault's owner). Otherwise the vault mints demo shares 1:1. This is how a tokenized credit vault would plug TrueNav in. Tests: `cd vault && cargo test`. Live run (`npm run vault:testnet`):

- Harbor (green, 99): subscription accepted: [4tSHv8Am...](https://explorer.testnet.near.org/transactions/4tSHv8AmK2AMxe3tDNbGf12iS7qfTyefX5b5AJVPStvm)
- Meridian (red, 43): refused, 0.1 NEAR refunded: [22WaytPM...](https://explorer.testnet.near.org/transactions/22WaytPMLYCruFQmprSU1kDbri4Euamyxo1DqTDsQU2j)
- Harbor with its certificate older than the vault's maximum age (owner set it to 1 minute: [HSCBKak5...](https://explorer.testnet.near.org/transactions/HSCBKak5SVyMrq9ePBRy7rfnFnmotrZk4EKvZq9vMsvE)): refused as stale, refunded: [4PNiNDEd...](https://explorer.testnet.near.org/transactions/4PNiNDEdVP7Zxr821XpvTta6XfU94hVN79M1tmeRcXuk); age restored to 7 days: [FzsAKqfV...](https://explorer.testnet.near.org/transactions/FzsAKqfVokYnzpjNqi31kcZ5TYhh51PJMP1dcjxVSHCF)
- A fund with no certificate: refused: [DMKw7Z1k...](https://explorer.testnet.near.org/transactions/DMKw7Z1k5JEs5sBjjyKHte6HASQshbq4JYxVUTBbYxVC)

Vaults: `vault-harbor.tnlab-718ca9.testnet`, `vault-meridian.tnlab-718ca9.testnet`, `vault-nocert.tnlab-718ca9.testnet` (code hash `9wUGnaG6N2npBfJaSvZHAsRcsSdAypLALyrMRcJWqQjH`, redeployed with state kept from `d37b9d2`: [GjKSNVzn...](https://explorer.testnet.near.org/transactions/GjKSNVznQiq2G8bpdiw9RaTWdPkkBp1oeKC4AayE3wjr), [4mfSHxmR...](https://explorer.testnet.near.org/transactions/4mfSHxmRJ2Mrs1kZ2j7gGkHC1YkksY21bozgqHhH6Nza), [CrmtF1g9...](https://explorer.testnet.near.org/transactions/CrmtF1g9cyws36m1P77rua8L9pft7gsNKYtdmPN7qxA4); the refusals above ran on the first build of the same code). Demo vaults are owned by their own operator accounts.

### Investor view from chain (no key)

`npm run chain:read` (no account or key). It reads the live contract and recomputes each fund's TrueNav score from chain data only: TEE verdicts, pledge times, pledge tokens, blocked attempts and alerts. You should see Harbor `99 green (raw 99.17)` and Meridian `43 red (raw 42.84)`, each followed by `Signed certificate on chain: ... -> matches the recomputed score`. Point it at your own instance with `TRUENAV_CONTRACT=registry.<name>.testnet`. The reader is `web/chain.mjs` (plain fetch, runs in the browser too; falls back to two backup RPC endpoints from the NEAR docs if the default fails).

### Verify the deployed code

The contract is built reproducibly (NEP-330): `contract/Cargo.toml` pins the build image `sourcescan/cargo-near:0.22.0-rust-1.99.0` by digest.

1. Check out the commit that `contract_source_metadata` names (step 3) and build it in the pinned image with the same build info (needs Docker and network access to crates.io):

   ```bash
   REV=d37b9d2033f69da121c9a69a615cd7ed027f4eef
   IMG=sourcescan/cargo-near:0.22.0-rust-1.99.0@sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e
   git checkout $REV && docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/home/near/code" -w /home/near/code/contract \
     -e NEP330_BUILD_INFO_BUILD_ENVIRONMENT="$IMG" -e NEP330_BUILD_INFO_CONTRACT_PATH=contract \
     -e NEP330_BUILD_INFO_SOURCE_CODE_SNAPSHOT="git+https://github.com/truenavlabs/truenav?rev=$REV" \
     -e NEP330_LINK="https://github.com/truenavlabs/truenav/tree/$REV" \
     "$IMG" cargo near build non-reproducible-wasm --locked
   ```

   It prints `SHA-256 checksum bs58: Foc9f2oJ8Ja1ddKSt91kXTxVm33nRBMjx3e4LHMP13EW` for that commit. The same command with `-w /home/near/code/vault` and `NEP330_BUILD_INFO_CONTRACT_PATH=vault` builds the circuit-breaker vault: `9wUGnaG6N2npBfJaSvZHAsRcsSdAypLALyrMRcJWqQjH`.
2. Compare with `code_hash` from `curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"registry.tnlab-718ca9.testnet"}}'` when you build the commit named in step 3.
3. The contract names its own source: view method `contract_source_metadata` returns the repository commit, the build image and the build command.

Read it yourself without any account:

```
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"registry.tnlab-718ca9.testnet","method_name":"get_attempts_page","args_base64":"'$(printf '{"fund_id":"meridian-yield-fund","from_index":0,"limit":10}' | base64 -w0)'"}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

Scores are computed as of the demo valuation time in `spec/nav/fixtures.json`; certificates are signed at run time, because the contract refuses a signing time in the future.

## Roles, pause, upgrades and storage

- Roles: **admin** assigns roles and registers funds (the allowlist: only registered fund accounts can pledge); **registrar** adds and removes certificate and TEE signers; **pauser** pauses and unpauses; **servicer** releases repaid loans and submits TEE verdicts. Each role is refused every other role's job (`contract/tests/roles.rs`). Sensitive calls need exactly 1 yoctoNEAR, so only a full-access key can make them.
- Pause stops pledges, releases, certificate and verdict submissions; views and role changes keep working.
- Upgrades: the code can be changed only with a full-access key of the contract account. On the live testnet instance there are two: the owner's and an operator backup, which is removed before the repository goes public. For mainnet: the contract account controlled by a multisig or DAO, upgrades announced and built reproducibly, and the full-access key removed after deployment.
- Storage: on testnet the contract pays for storage and only allowlisted funds can write, which bounds spam. For mainnet: callers attach storage deposits.

## Docs

- `ARCHITECTURE.md`: diagram and where each part lives.
- `TRUST_MODEL.md`: what is proven on chain, what is trusted, privacy, what is not claimed.
- `THREAT_MODEL.md`: attacks, mitigations and the test that shows each.
- `SECURITY.md`: reporting and practices. `AUDIT_FINDINGS.md`: every audit finding, fixed or accepted. `WHY_NEAR.md`: what NEAR enables here.
- `tee/eval/REPORT.md`: TEE underwriter eval and red-team report.

## Limits

- Testnet only; fictional funds, loans and documents.
- Admin, registrar and pauser sit on the owner's testnet account; the servicer is held by the operator; the certificate signer is a test key, not TEE; the TEE signer is registered by the registrar after an attestation check that anyone can repeat (`npm run verify:attestation`), not by an on-chain quote check.
- Privacy: a loan's on-chain `loan_hash` is an HMAC computed in an OutLayer TEE with a key that nobody holds (`tee/fingerprint.mjs`, `outlayer/fingerprint`); nobody can recompute it from a document id or test a guess against it. The servicer is the one place fingerprints come from, because the TEE derives the key per calling account (see TRUST_MODEL). Each run's public attestation proves which code produced which hash (`npm run verify:fingerprints`); requests go over HTTPS with a random nonce, so neither the chain nor the attestation carries a guessable value. The demo documents are fictional, so their fingerprint inputs are published for re-checking; real inputs would stay private. Pledges, verdicts, attempts and alerts are public chain state; they never name the other fund or show a loan, but they are not hidden. Each `submit_verdict` transaction publishes the whole signed TEE reply, so the reply may hold only fixed keys (`tee/reply.mjs`, enforced by the client, the contract and CI). A duplicate flag carries a line number, never a quote: nothing from the document goes on chain, and the trade-off is that nobody outside the TEE can check that evidence from chain alone; the eval checks it against the documents.
- The TEE underwriter is an LLM. On 6 Nov it flagged 3 of 40 honest documents; with the 7 Nov prompt it flagged none of 40 (main set) and none of 20 (frozen hold-out set), and missed no tampered document. One run each on synthetic documents (see `tee/eval/REPORT.md`).
- With chain data, a loan counts only for the fund whose on-chain pledge holds it. Offline mode (no chain data, used by `npm test`) falls back to "verified in neither" for an nft_id two funds list; offline mode is for tests and the chain path is the real score.
- PD tables are demo, not calibrated; TrueRange assumes independent defaults.

## Base Sepolia mirror

The cashflow receipt mirror implementation is in `mirror/` and `receipts/src/mirror.rs`, following spec 8.3.
It is not deployed. The NEAR contract builds a constrained EIP-1559 update from an already-stored receipt and asks
the MPC signer for a signature. The Base contract accepts only that derived address and strictly increasing
sequence per token. It copies the receipt reference, score, band, method hash and timestamp; it does not independently
verify private data or recompute a score. NEAR trusts an admin confirmation for Base finality. See
[`mirror/README.md`](mirror/README.md) for the verified signer interface, local checks, unverified live steps and
separate approvals required before any deployment or transaction, and [`TRUST_MODEL.md`](TRUST_MODEL.md) for trust.

## Known limitations

- Rental late share has no 100% ceiling, by design. `late_share_bps` for a rental fund compares all rent that is 60
  or more days late, across every month, with the rent due for one month, so a tenant who has paid nothing for four
  months shows 40,000 bps. The receipt contract accepts values up to 1,000,000 bps (100 months of rent). The score
  only counts late share up to 2,000 bps (20%), so a higher value never changes a score.
- If OutLayer accepts a run and its own callback then fails, the receipt contract cannot tell that apart from a run
  that was refused at the start. It refunds the requester's 0.01 NEAR from its own balance in both cases. It can
  therefore pay back money it did not get back, at most 0.01 NEAR per run, but it never pays back less than the
  requester is owed. This should not happen in practice, because OutLayer's callback returns a value on every path.
- Everything is synthetic: every fund, tenant, borrower, servicer, manager and bank account, and all bank data. No
  real party, account or record is used anywhere.

## Next steps

keyword rules such as the duplicate phrases run as attested code inside a TEE (OutLayer) before the reply is signed, instead of being asked of the model; certificate signer running in a TEE; on-chain quote verification; a multisig or DAO admin; storage deposits; the Chain Signatures certificate mirror to EVM chains and NEAR Intents settlement (not built, to keep the surface small).

## Prior art: how tokenized funds get their NAV today

From each platform's public documentation as read on 7 Nov 2026, not confirmed with the teams. "Not found" means we found no such mechanism in the public docs, not that none exists. Ondo and Midas tokenize Treasury and other strategies rather than loan books; they are listed because their NAV path is the common pattern.

| | Where NAV comes from | Does anyone check the private loan file | Cross-fund double pledge detected | Does anything on chain consume the result |
| --- | --- | --- | --- | --- |
| Maple | On-chain pool accounting: cash plus outstanding loans and accrued interest; impairments and defaults recognized by the pool manager change the exit rate ([pool accounting](https://docs.maple.finance/technical-resources/pools/accounting/pool-accounting), [exchange rates](https://docs.maple.finance/technical-resources/pools/accounting/pool-exchange-rates)) | Underwriting by the pool manager, off chain; investors see the pool's numbers | Not found | Yes: the pool's deposit and exit exchange rates |
| Ondo (OUSG, USDY) | NAV of the fund share class, computed off chain, then pushed to an on-chain price oracle ([OUSG docs](https://docs.ondo.finance/qualified-access-products/ousg)) | Not applicable (Treasury holdings held off chain) | Not applicable | Yes: subscription and redemption contracts read the oracle |
| Midas | NAV per token published to an on-chain data feed; the token does not rebase, its price rises (third-party integration docs: [web3-ethereum-defi](https://web3-ethereum-defi.readthedocs.io/vaults/midas/index.html)) | Not applicable (strategy holdings held off chain) | Not applicable | Yes: issuance and redemption vaults and integrations read the feed |
| Centrifuge | Issuer-set NAV pushed on chain, or on-chain accounting with a valuation contract per holding ([publish NAV](https://docs.centrifuge.io/developer/protocol/guides/publish-nav-and-oracles/), [on-chain accounting](https://docs.centrifuge.io/developer/protocol/features/onchain-accounting/)) | The issuer and its legal structure, off chain | Not found across platforms | Yes: the pool share price |
| Administrator NAV and proof-of-reserve feeds (generic) | An administrator or attestor publishes a number or a holdings snapshot with a timestamp | The attestor, off chain; investors see only the number | Not found | Yes, as a price or reserve feed |
| **TrueNav** | The fund's reported NAV is checked against TrueVal, recomputed from verified loans only | **Yes, privately:** a model in a NEAR AI Cloud TEE compares each loan document with the fund's claim; only a signed verdict leaves the TEE | **Yes, on chain:** one registry across funds refuses a second pledge of the same private fingerprint (an HMAC computed in an OutLayer TEE) and counts the attempt | **Yes:** the circuit-breaker vault refuses deposits when the fund's certificate is red, missing or stale |

TrueNav is not a NAV source: it is a check on the NAV a fund reports, built to sit next to any of the above.

## Built with

near-sdk 5.30.1 and near-contract-standards (Rust), near-api-js 7.3.1, near-sandbox 0.3.4, @noble/curves and @noble/hashes, @phala/dcap-qvl (TDX quote verification), NEAR AI Cloud (`Qwen/Qwen3-VL-30B-A3B-Instruct`), NVIDIA NRAS (GPU attestation), cargo-near and the sourcescan/cargo-near build image. Exact versions are pinned in `package-lock.json` and `contract/Cargo.lock`.

AI disclosure: the code, tests and docs were written with AI coding agents (Claude Code and others), directed and reviewed by the team. Outside models gave second opinions on scoring rules and audited the contract (GPT-5.5, Gemini 3.1 Pro, Claude Opus 5.5 via OpenRouter); every finding was checked by running code.

All data in this repository is fictional demo data.

License: Business Source License 1.1 (see LICENSE). Non-production use, including evaluation and judging, is permitted.
