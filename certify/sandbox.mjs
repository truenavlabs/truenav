// The same end to end flow as npm run e2e:testnet, on a local NEAR sandbox node: real wasm, real gas, real
// signatures, no testnet account and no network after the sandbox binary is downloaded.
//
//   npm run e2e:sandbox        (needs the built wasm: cd contract && cargo near build non-reproducible-wasm)
//
// The sandbox's root account "sandbox" uses the development key published in the near-sandbox package; it
// controls only this throwaway local chain. Keys for the sub-accounts go to a temporary keychain that is
// deleted afterwards. The node needs an open-file limit of 65535 (GitHub runners allow it).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, DEFAULT_PUBLIC_KEY } from "near-sandbox";

const sandbox = await Sandbox.start({});
const credDir = mkdtempSync(join(tmpdir(), "truenav-sandbox-keys-"));
let status = 1;
try {
  writeFileSync(join(credDir, `${DEFAULT_ACCOUNT_ID}.json`), JSON.stringify({ account_id: DEFAULT_ACCOUNT_ID, public_key: DEFAULT_PUBLIC_KEY, private_key: DEFAULT_PRIVATE_KEY }), { mode: 0o600 });
  console.log(`Sandbox RPC ${sandbox.rpcUrl}, root account ${DEFAULT_ACCOUNT_ID}`);
  const r = spawnSync(process.execPath, [new URL("testnet.mjs", import.meta.url).pathname], {
    stdio: "inherit",
    env: { ...process.env, TRUENAV_NETWORK: "sandbox", TRUENAV_RPC: sandbox.rpcUrl, TRUENAV_TESTNET_ACCOUNT: DEFAULT_ACCOUNT_ID, TRUENAV_CRED_DIR: credDir },
  });
  status = r.status ?? 1;
} finally {
  rmSync(credDir, { recursive: true, force: true });
  await sandbox.tearDown();
}
process.exit(status);
