# Mirror build verification

The signing-recovery and civil-date fix is based on `65c3ce0960d173e245d01b922eb550d6358bc812`, including the gas-cap
candidate `c4da4c5d1d6fed7c18c2553a2b87c16d5b76c065`. Built locally on 9 Nov 2026 Bangkok, not deployed.
Query code and its artifact are unchanged. The Q&A branch is not included.

Pinned image:
`sourcescan/cargo-near:0.22.0-rust-1.99.0@sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e`.
Command inside the receipts crate: `cargo near build non-reproducible-wasm --locked`.

| Artifact | SHA-256 | Bytes |
| --- | --- | --- |
| receipts recovery/date candidate | `c19fc647d96d13f288d928d6495901c1e542a1e0ff043408c6ec3791a08508f1` | 305346 |
| unchanged local-only mock signer | `ebaabe0480d5c28897c9b54d31a7e0618f814b0659ca97f40fca5238c385b30b` | 140591 |
| unchanged query dist | `ec1f9f3a67e69b802efa7be64feee15ac869cf12a1e73014defaf45c52505156` | 155543 |

This candidate was built in the pinned image as uid 1000 at `/home/near/code`. The committed receipt dist and pins
match that output. This fix was not independently rebuilt in a second clone, and no CI result exists on the local
commit. Updated build pins are not authorization to deploy.

Fresh verification for this fix:

- Receipts `cargo +1.99.0 test --locked`: 24 contract tests and 12 mirror tests, all passed.
- Receipts `cargo +1.99.0 clippy --locked --all-targets -- -D warnings`: passed.
- `npm test`: 284 tests, no failures on lab/mirror. The separately committed Q&A tests are not on this branch.
- Recovery tests prove admin/one-yocto/pause enforcement, byte-identical state apart from the signing flag, unchanged
  nonce and unsigned payload, rejection of late callbacks, and a successful higher-fee retry.
- Date tests cover Gregorian leap/century rules, impossible month/day combinations, pre-epoch timestamps and invalid
  clock values. Invalid receipts return a fixed rejection code, clear the pending request and are not stored.
- The existing state-layout regression still passes; no fields or migration were added to Receipts.
- Gitleaks scans cover full history and the fix's changed content. No live transaction, deployment or funding occurred.
- Local NEAR sandbox suites remain skipped: hard nofile is 16384, below required 65535. CI must verify them after an
  approved push. The earlier unchanged mock-signer and local EVM checks are documented in mirror/README.md.
