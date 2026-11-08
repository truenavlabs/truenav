# Mirror build verification

Source: `c4f6c853706cbc446ed36355cb9c841260960119`, rebased onto gas-cap candidate
`c4da4c5d1d6fed7c18c2553a2b87c16d5b76c065`. Built locally on 9 Nov 2026 Bangkok, not deployed.
The source contains the gas-cap fix and unchanged query code. It does not contain the separate docs-pass commit.

Pinned image:
`sourcescan/cargo-near:0.22.0-rust-1.99.0@sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e`.
Command inside the crate: `cargo near build non-reproducible-wasm --locked`.

| Artifact | SHA-256 | Bytes |
| --- | --- | --- |
| receipts mirror candidate | `c0be42580304d1f7e4dadd0166ef326c99af30d6d7a5cfaf00edcce8ec4390ec` | 302786 |
| local-only mock signer | `ebaabe0480d5c28897c9b54d31a7e0618f814b0659ca97f40fca5238c385b30b` | 140591 |
| unchanged query dist | `ec1f9f3a67e69b802efa7be64feee15ac869cf12a1e73014defaf45c52505156` | 155543 |

Receipts output is byte-identical between the working checkout at `/home/near/code` as uid 1000 and an independent
fresh clone at `/src` as uid 0. Both built the same source in the pinned image. The committed receipt dist and pins
are updated to this candidate so CI can check the same bytes; this is not authorization to deploy it.

Verification:

- Fresh `npm ci` and `npm test`: 284 tests, no failures. A Darwin-only bundled watcher is marked optional in the
  lockfile so the local EVM dev dependency installs on Linux. No dependency version was floated.
- Receipts: 23 existing/gas-cap tests plus 10 mirror tests, all passed; clippy all targets with warnings denied passed.
- Mock signer: one native fixture test and clippy passed; its wasm compiled. It must never be deployed on a live chain.
- Solidity 0.8.30 compiled locally (Shanghai target, optimizer 200 runs); the local EVM tested access, sequence,
  event emission, broadcasting and the finalized confirmer with a stub NEAR sender. No live transaction was sent.
- The NEAR sandbox mirror harness and `e2e:receipts` were not run: hard nofile is 16384, below required 65535.
  CI now builds the mock signer and runs the mirror harness after the existing receipt sandbox suite.
- Live MPC views and local derivation matched. The Base Sepolia read-only check returned chain id 84532,
  finalized balance 0 and finalized nonce 0 for the derived account. Actual live signing is unverified.

CI results on this unpushed branch do not exist yet. Local success does not certify the unrun sandbox harness.
