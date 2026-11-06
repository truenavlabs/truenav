# Architecture

## Trust flow

```mermaid
flowchart TB
  NAC[NEAR AI Cloud TEE<br/>Intel TDX + NVIDIA CC] -- "attestation report<br/>(published, hash on chain)" --> REG
  ANY[Anyone] -. "npm run verify:attestation" .-> NAC
  REG[Registrar] -- add_tee_signer(key, report hash) --> C[(Registry contract)]
  ADM[Admin] -- register_fund (allowlist), set_role --> C
  PAU[Pauser] -- pause / unpause --> C
  FUND[Fund account] -- pledge_loan --> C
  SRV[Servicer] -- "submit_verdict<br/>(TEE-signed, bound to contract, network, version, expiry)" --> C
  SRV -- release_loan --> C
  ENG[Score engine<br/>public, deterministic] -- reads chain --> C
  ENG -- "certificate (test key, not TEE)" --> C
  INV[Investor] -- "npm run chain:read" --> C
```

## Data flow

```mermaid
flowchart LR
  subgraph Fund side
    D[Loan documents<br/>private] --> U
    C[Fund's claimed loan data] --> U
  end
  subgraph NEAR AI Cloud TEE
    U[Underwriter model<br/>Qwen3-VL, Intel TDX + NVIDIA CC]
  end
  A[tee/attest.mjs<br/>fresh nonce, quote, GPU] -.checks.-> U
  U -- "verdict-only reply<br/>+ ECDSA signature" --> V
  subgraph NEAR testnet: registry contract
    P[pledge_loan<br/>lock + NEP-171 token<br/>refuse second fund]
    V[submit_verdict<br/>ecrecover, registered TEE signer,<br/>same loan_hash, once]
    S[submit_certificate<br/>registered signer, forward signed_at]
  end
  F[Fund accounts] --> P
  V --> R[(verdicts, locks,<br/>attempts, certificates)]
  P --> R
  R -- read --> E[Score engine<br/>engine/src/score.mjs<br/>deterministic, public]
  E -- "certificate<br/>(test key, not TEE)" --> S
  S --> R
  R -- read --> I[Investor view<br/>in progress]
```

| Part | Where | Tests |
| --- | --- | --- |
| Score engine (TrueVal, TrueRange, TrueNav score, R1 to R25) | `engine/`, rules in `spec/nav/NAV_SPEC.md` | `npm test` |
| Certificates (engine result to signed message) | `certify/certificate.mjs` | `npm test`, `npm run e2e` |
| Registry contract (Rust, near-sdk 5.30.1) | `contract/` | `cd contract && cargo test` |
| TEE attestation, documents, underwriter | `tee/` | `npm run tee:demo`, `npm run tee:attest` |
| Live flows | `certify/testnet.mjs`, `certify/sandbox.mjs` | `npm run e2e:testnet`, `npm run e2e:sandbox` |

Data flow for one fund: the fund pledges each loan (one token per loan); the TEE checks each loan's document against the fund's claim and its signed verdict is stored; the engine reads verdicts and pledge times from the chain (the certificate history it uses in the demo still comes from `spec/nav/fixtures.json`; reading it from `get_certificate_history` is next), computes the score, and a certificate with the result is stored. The investor reads everything from the chain.
