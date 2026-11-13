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

import { accountIdOf, clearUnsafeHash, DEBUG_WALLETS_KEY, isTestnetAccountId, noDebugWalletStorage } from "../src/lib/wallet-guards.mjs";
const manifest = JSON.parse(readFileSync(join(here, "..", "src", "lib", "wallet-manifest.json"), "utf8"));
const shell = readFileSync(join(here, "..", "src", "shell", "wallet.tsx"), "utf8");

test("the wallet manifest is pinned in the repo, testnet only, with no page-level external access", () => {
  assert.match(src, /import PINNED_MANIFEST from "\.\/wallet-manifest\.json"/);
  assert.match(src, /manifest: \{ version: PINNED_MANIFEST\.version/);
  assert.match(src, /autoConnect: false/);
  assert.match(src, /storage: noDebugWalletStorage\(\)/);
  assert.deepEqual(manifest.wallets.map((w) => w.id).sort(), ["ethereum-wallets", "intear-wallet", "ledger", "meteor-wallet", "near-cli", "nightly-wallet"]);
  const allowedExternal = { "meteor-wallet": ["meteorCom", "meteorComV2"], "nightly-wallet": ["nightly.near"] };
  for (const w of manifest.wallets) {
    assert.equal(w.type, "sandbox", w.id);
    assert.equal(w.features.testnet, true, w.id);
    assert.match(w.executor, /^https:\/\//, w.id);
    assert.equal("location" in w.permissions, false, w.id);
    assert.equal(!!w.permissions.walletConnect, false, w.id);
    assert.deepEqual(w.permissions.external ?? [], allowedExternal[w.id] ?? [], w.id);
    for (const e of w.permissions.external ?? []) {
      assert.equal(/^(location|localStorage|sessionStorage|document|window|top|parent|opener|fetch|eval|indexedDB)\b/.test(e), false, `${w.id} ${e}`);
    }
    for (const o of w.permissions.allowsOpen ?? []) assert.equal(/^(javascript|data|http):/i.test(o), false, `${w.id} ${o}`);
  }
});

test("the wallet context exposes sendReceiptsCall, not the raw wallet or connector", () => {
  assert.match(shell, /sendReceiptsCall: \(method: string/);
  assert.match(shell, /buildSignAndSendTransaction\(\{ receiverId: RECEIPTS_CONTRACT/);
  const ctx = shell.slice(shell.indexOf("export type WalletCtx"), shell.indexOf("};", shell.indexOf("export type WalletCtx")));
  assert.equal(/\bwallet:|\bconnector:/.test(ctx), false);
  assert.match(shell, /clearUnsafeHash\(\);\s*const connected = await connector\.connect\(\)/);
});

test("pasted debug manifests are never stored or reloaded", async () => {
  const mem = new Map([[DEBUG_WALLETS_KEY, '[{"id":"evil"}]'], ["selected-wallet", "meteor-wallet"]]);
  const inner = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), remove: async (k) => void mem.delete(k) };
  const s = noDebugWalletStorage(inner);
  assert.equal(await s.get(DEBUG_WALLETS_KEY), null);
  await s.set(DEBUG_WALLETS_KEY, '[{"id":"evil2"}]');
  assert.equal(mem.get(DEBUG_WALLETS_KEY), '[{"id":"evil"}]');
  assert.equal(await s.get("selected-wallet"), "meteor-wallet");
  await s.set("selected-wallet", "near-cli");
  assert.equal(mem.get("selected-wallet"), "near-cli");
});

test("only testnet account ids count as connected", () => {
  for (const ok of ["alice.testnet", "a-b_c.sub.testnet", "tnlab-718ca9.testnet", "a".repeat(64).replace(/a/g, "f")]) assert.equal(isTestnetAccountId(ok), true, ok);
  for (const bad of ["alice.near", "alice", "testnet", ".testnet", "Alice.testnet", "alice..testnet", "alice.testnet ", "ed25519:abc", "0x" + "a".repeat(40), "F".repeat(64), "", null, 1]) {
    assert.equal(isTestnetAccountId(bad), false, String(bad));
  }
  assert.equal(accountIdOf([{ accountId: "bob.testnet" }]), "bob.testnet");
  assert.equal(accountIdOf([{ accountId: "bob.near" }]), "");
  assert.equal(accountIdOf(undefined), "");
});

test("a backslash in the fragment is cleared before connect", () => {
  const calls = [];
  const hist = { replaceState: (...a) => calls.push(a) };
  assert.equal(clearUnsafeHash({ hash: "#\\", pathname: "/overview", search: "?tab=1" }, hist), true);
  assert.deepEqual(calls[0], [null, "", "/overview?tab=1"]);
  assert.equal(clearUnsafeHash({ hash: "#faq", pathname: "/", search: "" }, hist), false);
  assert.equal(clearUnsafeHash({ hash: "", pathname: "/", search: "" }, hist), false);
  assert.equal(calls.length, 1);
});
