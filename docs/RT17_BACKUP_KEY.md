# RT-17: the backup full-access keys on the earlier 718ca9 accounts

RT-17 is the open finding that an account has two full-access keys: the owner's key and an operator backup key. Either key can replace the code on that account. Removing the backup key is a chain action for the owner's team. Nothing in this repository signs or sends a transaction.

## Where it applies

Read with `view_access_key_list` at final on testnet, 12 Nov 2026:

| Account | Full-access keys | RT-17 |
| --- | --- | --- |
| `registry.tnlab-718ca9.testnet` (earlier registry) | 2: `ed25519:6gwVY7iF...nFGS`, `ed25519:GVCmuXRX...QvrY` | open |
| `tnlab-718ca9.testnet` (earlier master) | 2: `ed25519:5UHhLqZs...jLPe`, `ed25519:DVBRaGs5...f2dc` | open |
| `registry.tnlab-368aa2.testnet` (current registry) | 1 | closed; checked in CI |
| `tnlab-368aa2.testnet` (current master) | 1 | closed; checked in CI |

The chain does not say which of two full-access keys is the owner's. The owner's team knows.

## CI check for the current accounts

```bash
npm run rt17:check
```

Free RPC view calls only. It fails unless `registry.tnlab-368aa2.testnet` and `tnlab-368aa2.testnet` each have exactly one full-access key (exit 0 pass, 1 fail, 2 usage or network error). It runs in the `judge-path` CI job. Any account can be checked the same way:

```bash
node certify/key-audit.mjs --check --contract registry.tnlab-718ca9.testnet --contract tnlab-718ca9.testnet
```

That command fails today, as expected, until the 718ca9 backup keys are removed.

## Preparing the DeleteKey for a 718ca9 account

```bash
node certify/key-audit.mjs --contract registry.tnlab-718ca9.testnet
node certify/key-audit.mjs --contract registry.tnlab-718ca9.testnet --backup-key ed25519:<public key to remove>
```

The first lists every access key with its permission and nonce. The second, with exactly two full-access keys and one named as the backup (or the other named with `--owner-key`), prints the exact unsigned `DeleteKey` transaction: signed by the key that stays, nonce that key's nonce plus one, as JSON and as base64 of the borsh bytes. It is printed only. The script has no code that signs or sends, and it refuses a secret key without printing it. The block hash in the printed transaction is valid for about a day, so print it again just before signing. Repeat for `tnlab-718ca9.testnet`.

## Tests

`certify/key-audit.test.mjs` (7 tests, in `npm test`) runs the script against a local fake RPC: the report, the check with one, two and no full-access keys, the check over several accounts, the DeleteKey transaction decoded back from its bytes, refusals, a secret key never echoed, and that only `view_access_key_list` queries reach the RPC.
