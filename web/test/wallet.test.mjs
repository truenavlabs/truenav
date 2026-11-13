// Wallet data-layer constants. Does not open a wallet or send a transaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "lib", "wallet.ts"), "utf8");

test("wallet connector is pinned to testnet and filters for testnet wallets", () => {
  assert.match(src, /export const WALLET_NETWORK = "testnet"/);
  assert.match(src, /network: WALLET_NETWORK/);
  assert.match(src, /features: \{ testnet: true/);
  assert.match(src, /from "@hot-labs\/near-connect"/);
  assert.equal(/signAndSendTransaction/.test(src), false);
});
