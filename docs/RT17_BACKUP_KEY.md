# RT-17: the backup full-access key

RT-17 is the open finding that a registry account has two full-access keys: the owner's key and an operator backup key. Either key can upgrade the contract. Removing the backup key is a chain action for the owner's team. Nothing here sends a transaction.

## Read-only commands

Both use free RPC view calls only (`view_access_key_list`). Neither has code that signs or broadcasts.

```bash
npm run rt17:keys
```

Lists every access key on the registry account with its permission and nonce, and the number of full-access keys. The account is `registry.tnlab-368aa2.testnet` unless `--contract <account>` or `TRUENAV_CONTRACT` says otherwise. The chain does not say which full-access key is the owner's.

```bash
npm run rt17:keys -- --backup-key ed25519:<public key to remove>
```

or, naming the key that stays:

```bash
npm run rt17:keys -- --owner-key ed25519:<public key that stays>
```

With exactly two full-access keys and one of them named, it prints the exact unsigned `DeleteKey` transaction, as JSON and as base64 of the borsh bytes. The transaction is signed by the owner key, so its nonce is that key's nonce plus one. It is not sent. The owner's team signs it offline and broadcasts it. A value that is a secret key (64 bytes) is refused and never printed.

```bash
npm run rt17:check
```

Exit 0 if the account has at most one full-access key, exit 1 if it has more, exit 2 on a usage or network error. It is an npm script, not a CI job: the current registry still has its backup key, so a required check would turn CI red until the key is removed. Once the key is gone, the owner can add it to `ci.yml` as a required step.

## Tests

`certify/key-audit.test.mjs` (6 tests, in `npm test`) runs the script against a local fake RPC: the report, the check on one and two keys, the DeleteKey transaction (decoded back from its bytes), refusals, a secret key never echoed, and that only `view_access_key_list` queries reach the RPC.
