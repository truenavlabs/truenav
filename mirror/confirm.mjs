import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { signedEvent, validateSigned } from "./broadcast.mjs";
import { CHAIN_ID } from "./abi.mjs";

// One bounded check. Run again if finality has not reached this successful transaction yet.
export async function confirmFinalized(event, { client, near, mirrorAddress, mpcAddress }) {
  const checked = await validateSigned(event,{mirrorAddress,mpcAddress});
  if (await client.getChainId() !== CHAIN_ID) throw Error("Base Sepolia only");
  const receipt = await client.getTransactionReceipt({hash:checked.hash});
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== checked.hash.toLowerCase()) throw Error("successful mirror transaction required");
  const finalized = await client.getBlock({blockTag:"finalized"});
  if (finalized.number === null || finalized.number < receipt.blockNumber) return false;
  const canonical = await client.getBlock({blockNumber:receipt.blockNumber});
  if (canonical.hash !== receipt.blockHash) throw Error("noncanonical receipt");
  await near.confirm({nonce:event.nonce,tx_hash:checked.hash.slice(2)});
  return true;
}

export async function waitForFinality(event, options, { attempts = 240, delay = () => new Promise((r) => setTimeout(r,15000)) } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await confirmFinalized(event,options)) return true;
    if (i + 1 < attempts) await delay();
  }
  throw Error("Base finality wait expired; nonce remains pending");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mirrorAddress, mpcAddress, rpc, execute] = process.argv.slice(2);
  const event = signedEvent(JSON.parse(await readFile(file,"utf8")));
  await validateSigned(event,{mirrorAddress,mpcAddress});
  if (execute !== "--execute") console.log(JSON.stringify({dry_run:true,nonce:event.nonce,tx_hash:event.tx_hash}));
  else {
    const { Account, JsonRpcProvider, actions } = await import("near-api-js");
    const accountId = process.env.TRUENAV_ADMIN_ACCOUNT;
    const contractId = process.env.TRUENAV_RECEIPTS_ACCOUNT;
    if (!accountId?.endsWith(".testnet") || !contractId?.endsWith(".testnet")) throw Error("testnet accounts required");
    let key;
    try { key = JSON.parse(await readFile(process.env.TRUENAV_SIGNER_KEYFILE,"utf8")); }
    catch { throw Error("admin credential could not be loaded"); }
    if (key.account_id !== accountId) throw Error("admin key account mismatch");
    const provider = new JsonRpcProvider({url:process.env.TRUENAV_RPC || "https://test.rpc.fastnear.com"});
    if ((await provider.viewNodeStatus()).chain_id !== "testnet") throw Error("NEAR testnet required");
    const config = await provider.callFunction({contractId,method:"get_config",args:{},blockQuery:{finality:"final"}});
    if (config.admin !== accountId) throw Error("dev account is not the receipts admin");
    const account = new Account(accountId,provider,key.private_key);
    const near = { confirm: (args) => account.signAndSendTransaction({receiverId:contractId,
      actions:[actions.functionCall("confirm_mirror",args,30000000000000n,1n)],waitUntil:"FINAL"}) };
    console.log(await waitForFinality(event,{client:createPublicClient({transport:http(rpc)}),near,mirrorAddress,mpcAddress}));
  }
}
