import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { signedEvent, validateSigned } from "./broadcast.mjs";
import { CHAIN_ID } from "./abi.mjs";
import { guard, guardClient, RedactedError, runMain } from "./safe.mjs";

// One bounded check; false means not final yet, so run again. Safety order, unchanged: a successful receipt for this
// exact hash, the finalized block at or past the receipt's block, then the canonical hash of that block (read after
// finality), and only then confirm_mirror. A transaction not mined yet (receipt not found) and a receipt from a block
// that is no longer canonical (a reorg; the transaction may be re-included) are both "not final yet", never a confirm.
export async function confirmFinalized(event, { client: rawClient, near, mirrorAddress, mpcAddress }) {
  const checked = await validateSigned(event,{mirrorAddress,mpcAddress});
  // every Base RPC call is guarded: an error names only its class, never the RPC URL
  const client = guardClient(rawClient);
  if (await client.getChainId() !== CHAIN_ID) throw Error("Base Sepolia only");
  let receipt;
  try { receipt = await client.getTransactionReceipt({hash:checked.hash}); }
  catch (e) { if (e instanceof RedactedError && e.rpcName === "TransactionReceiptNotFoundError") return false; throw e; }
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== checked.hash.toLowerCase()) throw Error("successful mirror transaction required");
  const finalized = await client.getBlock({blockTag:"finalized"});
  if (finalized.number === null || finalized.number < receipt.blockNumber) return false;
  const canonical = await client.getBlock({blockNumber:receipt.blockNumber});
  if (canonical.hash !== receipt.blockHash) return false;
  await guard("near", () => near.confirm({nonce:event.nonce,tx_hash:checked.hash.slice(2)}));
  return true;
}

export async function waitForFinality(event, options, { attempts = 240, delay = () => new Promise((r) => setTimeout(r,15000)) } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await confirmFinalized(event,options)) return true;
    if (i + 1 < attempts) await delay();
  }
  throw Error("Base finality wait expired; nonce remains pending");
}

// node mirror/confirm.mjs <logs.json> [--mirror 0x..] [--mpc 0x..] [--execute]
// env: TRUENAV_RECEIPTS_ACCOUNT, TRUENAV_RPC (NEAR, optional); for --execute also BASE_RPC_URL, TRUENAV_ADMIN_ACCOUNT,
// TRUENAV_SIGNER_KEYFILE
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(async () => {
    const { parseArgs, nearView, mirrorAddresses, baseRpcUrl, baseTimeoutMs } = await import("./config.mjs");
    const args = parseArgs(process.argv.slice(2));
    const event = signedEvent(JSON.parse(await readFile(args.file,"utf8")));
    const contractId = process.env.TRUENAV_RECEIPTS_ACCOUNT;
    const { provider, view } = await nearView(process.env.TRUENAV_RPC || "https://test.rpc.fastnear.com");
    const { mirrorAddress, mpcAddress } = await mirrorAddresses({ view, receipts: contractId, mirror: args.mirror, mpc: args.mpc });
    await validateSigned(event,{mirrorAddress,mpcAddress});
    if (!args.execute) { console.log(JSON.stringify({dry_run:true,nonce:event.nonce,tx_hash:event.tx_hash,mirror_address:mirrorAddress,mpc_address:mpcAddress})); return; }
    const { Account, actions } = await import("near-api-js");
    const accountId = process.env.TRUENAV_ADMIN_ACCOUNT;
    if (!accountId?.endsWith(".testnet") || !contractId?.endsWith(".testnet")) throw Error("testnet accounts required");
    const baseUrl = baseRpcUrl();
    let key;
    try { key = JSON.parse(await readFile(process.env.TRUENAV_SIGNER_KEYFILE,"utf8")); }
    catch { throw Error("admin credential could not be loaded"); }
    if (key.account_id !== accountId) throw Error("admin key account mismatch");
    const config = await view(contractId,"get_config");
    if (config.admin !== accountId) throw Error("dev account is not the receipts admin");
    const account = new Account(accountId,provider,key.private_key);
    const near = { confirm: (a) => account.signAndSendTransaction({receiverId:contractId,
      actions:[actions.functionCall("confirm_mirror",a,30000000000000n,1n)],waitUntil:"FINAL"}) };
    console.log(await waitForFinality(event,{client:createPublicClient({transport:http(baseUrl,{timeout:baseTimeoutMs()})}),near,mirrorAddress,mpcAddress}));
  });
}
