# Network: testnet, and what mainnet would change

[Back to the README](../README.md).

TrueNav runs on NEAR testnet only, on purpose. The rulebook makes testnet-only projects eligible on every track (Q-010). TrueNav uses no mainnet-only integration: it does not use NEAR Intents (Q-007), and OutLayer has a testnet (`outlayer.testnet`). On testnet a judge needs no funds for any step in [Try it](TRY_IT.md).

A mainnet move would change this:

- The contract already maps a `.near` account to network `mainnet` (`network_of` in `contract/src/lib.rs`), and the TEE binding uses the same rule (`networkOf` in `tee/underwrite.mjs`).
- Each TEE verdict is bound to one contract, network and expiry, so none of the 16 testnet verdicts would carry over. A mainnet registry would need a fresh underwrite, a new attestation report, new pledges and new `submit_verdict` calls.
- Contract storage would be paid in real NEAR (1 NEAR per 100,000 bytes; the live registry uses 399065 bytes).
- Several scripts refuse mainnet today: `api/main.mjs`, `agent/run.mjs`, `certify/testnet.mjs`, `receipts/deploy-args.mjs` and `mirror/config.mjs`. The OutLayer engine-v3 accepts only testnet RPC endpoints, and `receipts/src/attestations.rs` accepts only `https://testnet-api.outlayer.ai` proof URLs.
- Views would stay free, but any write (a pledge, a paid report) would cost the caller real NEAR.
- The open items in [Known limits and disclosures](KNOWN_LIMITS.md#known-limits-and-disclosures) should be closed first.
