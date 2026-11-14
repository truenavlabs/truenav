# Deployment evidence

Read-only snapshot of the live NEAR testnet accounts this repository talks about, compared with the pins in the tree. Recompute with `view_account` and `view_code` on `https://rpc.testnet.near.org` (finality `final`), then sha256 of the wasm. The live `code_hash` is base58 of that sha256.

Snapshot: 14 Nov 2026, 15:56 to 15:57 Asia/Bangkok (UTC+7), blocks 277635176 to 277635300.

This file was written against tree `952bad9`. Later docs commits on this branch do not change the pins.

## Pins in the repository

| Pin | File | sha256 | Expected `code_hash` (base58 of the sha256) |
|---|---|---|---|
| Receipts wasm | `receipts/pinned-builds.json` (`receipts`) and `receipts/v3-build.json` | `5f294c9a447d515d6b56fd8b2396b5c00e83dee4f622ac3ceede2edf52e8606f` | `7QUFsz1UyZRJvRsaWBkHrif83WfbarumTHcVa7ifvchk` |
| Query wasm | `receipts/pinned-builds.json` (`query`) | `dee5f216c7ed6a0b75e597b2c5dce643dfcb88dc6517e71e85c5bb96f8169d09` | `G16shAw72Dznwxuojy3kdM6er1ksAPndtHdXmQ28MbUt` |
| Engine v3 wasm | `receipts/v3-build.json` (`engine.sha256`) | `098f5d86a94288d13fac1ca66b8aba9c20a2dc1b3585a64ef91d5bba5aa68788` | Not a NEAR account pin. This is the OutLayer `version_key` the receipts config should use after the v3 redeploy. |
| Live registry code hash | `certify/live-registry.json` | No sha256 pin. The live registry is a host build. | `9Ki2kuenoxie3doBRYbdTPSmzTjwsTosQmUaGwQKCw7o` |

The live registry wasm is 364904 bytes and `contract_source_metadata.build_info` is null. That is not a NEP-330 reproducible-build pin.

## Live accounts

### `registry.tnlab-368aa2.testnet` (live registry)

- Role: current live registry. Default for every live read (`npm run chain:read`, `verify:attestation`, and the web verifier).
- Live `code_hash`: `9Ki2kuenoxie3doBRYbdTPSmzTjwsTosQmUaGwQKCw7o`.
- Live wasm sha256: `7ba857d3c4d05f98503c5170a7bf3cb0172b233ca035c8c8c11269801735595a` (364904 bytes).
- Repo pin: `certify/live-registry.json` `code_hash`. They match.
- `get_roles`: admin and registrar `tnlab-368aa2.testnet`, pauser `pauser.tnlab-368aa2.testnet`, servicer `servicer.tnlab-368aa2.testnet`, paused false. This matches `certify/live-registry.json`.
- Deploy and init transaction, found in the repo and logs: [Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE](https://explorer.testnet.near.org/transactions/Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE) (11 Nov 2026).
- TEE signer registered in [9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE](https://explorer.testnet.near.org/transactions/9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE).

Related live accounts with no contract code (`view_account` `code_hash` is the empty-account value): `tnlab-368aa2.testnet` (admin and registrar), `pauser.tnlab-368aa2.testnet`, `servicer.tnlab-368aa2.testnet`, `harbor.tnlab-368aa2.testnet`, `meridian.tnlab-368aa2.testnet`.

### `receipts.tnlab-718ca9.testnet` (live receipts)

- Role: live receipts contract. This is the `receipts_contract` value pinned in the v3 schemas and engine, and the scope of the recorded loan fingerprints.
- Live `code_hash`: `HNCayZpizjrHK8djD7XpGmwA7R3mLZ8A4GZ864CaaGhS`.
- Live wasm sha256: `f32949b38eef2547d1bbe4441d0d2c5db215846db1a57a95f4f46dbcf7b29c9d` (266556 bytes), prefix `f32949b3`.
- Repo pin: `5f294c9a447d515d6b56fd8b2396b5c00e83dee4f622ac3ceede2edf52e8606f` (expected `code_hash` `7QUFsz1UyZRJvRsaWBkHrif83WfbarumTHcVa7ifvchk`, 555924 bytes).
- They do not match. Redeploy pending.
- Live `get_config`: method `cashflow-v2.1.0`, `version_key` `360cd47346db7060ffb213288e25a6d5e39050133bd4e20ad2f6f9280b1daa57`, project `receipts.tnlab-718ca9.testnet/truenav-engine`, paused false, `outlayer` `outlayer.testnet`. The pinned v3 config is method `truenav-v3.0.1` and engine `098f5d86a94288d13fac1ca66b8aba9c20a2dc1b3585a64ef91d5bba5aa68788`. Config also does not match. Redeploy pending.
- No deploy transaction for the live `f32949b3` bytes was found in the repository or in the local logs. Not invented.

### `query.tnlab-718ca9.testnet` (live query)

- Role: live query contract on the same 718ca9 instance. Demo buy fixtures name this account.
- Live `code_hash`: `GtjBdg3Zht9xm1rVuBvJGVEPABi1rQhSnXkodgtEwGQd`.
- Live wasm sha256: `ec1f9f3a67e69b802efa7be64feee15ac869cf12a1e73014defaf45c52505156` (155543 bytes).
- Repo pin: `dee5f216c7ed6a0b75e597b2c5dce643dfcb88dc6517e71e85c5bb96f8169d09` (expected `code_hash` `G16shAw72Dznwxuojy3kdM6er1ksAPndtHdXmQ28MbUt`).
- They do not match. The live sha256 equals the stale dist hash recorded under `receipts/pinned-builds.json` (`dist.receipts/dist/truenav_query.wasm`), not the current query pin.
- No deploy transaction for this account was found in the repository or in the local logs. Not invented.

### `registry.tnlab-718ca9.testnet` (earlier registry, recorded history)

- Role: earlier registry instance. Not the default live read. CI re-reads it in labelled earlier-instance steps (`--contract registry.tnlab-718ca9.testnet` or `TRUENAV_CONTRACT=...`).
- Live `code_hash`: `Foc9f2oJ8Ja1ddKSt91kXTxVm33nRBMjx3e4LHMP13EW`.
- Live wasm sha256: `dbf413da9e56ef26dfe7435443402eac7402a538725b29f92275f09c72693db7` (340351 bytes).
- On-chain `contract_source_metadata` names source commit `d37b9d2033f69da121c9a69a615cd7ed027f4eef`. The repo tag `registry-tnlab-718ca9` points at `d37b9d2`. There is no current wasm pin for this account in `certify/live-registry.json`.
- Related accounts with no contract code: `tnlab-718ca9.testnet` (admin and pauser of the live receipts contract), `pauser.tnlab-718ca9.testnet`, `servicer.tnlab-718ca9.testnet`, `runner.tnlab-718ca9.testnet`.

### Retired history, not the live registry

`registry.tnlab-dd2a56.testnet` still has code on testnet (`code_hash` `FKiqEe3GZ2Wae3iuKG1riCQPi99V6sZQXftWAbi2yK6D`). `AUDIT_FINDINGS.md` records it as a replaced instance. Do not use it as the live registry.

## What is not a live NEAR account

- The receipts v3 `source_registry` in `receipts/v3-build.json` is classified `public TEST fixture only`. The snapshot is `engine/v3-core/tests/fixtures/source-registry.TEST.json`. It is a public test key set for the engine, not a NEAR registry account, and not `registry.tnlab-368aa2.testnet`.
- `receipts-v3-dryrun.tnlab-718ca9.testnet` is a TEST-only overlay name in the v3 upgrade docs. RPC `view_account` on 14 Nov 2026 returned UNKNOWN_ACCOUNT: the account does not exist on testnet.
- Receipts printed by `npm run demo` and in the offline judge path are synthetic fixtures. They are not a live read of `receipts.tnlab-718ca9.testnet`.
- The Base Sepolia mirror is not deployed.

## CI and artifacts

`.github/workflows/ci.yml` has 9 jobs. `receipts-pinned-build.yml` is a separate workflow that reproduces the receipts and query wasm pins. A CI run id for commit `952bad9` is not recorded in this file (unverified here). No live v3 receipt transaction exists yet, because the v3 receipts build is not deployed.
