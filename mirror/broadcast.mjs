import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, createPublicClient, http } from "viem";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { abi, CHAIN_ID } from "./abi.mjs";

export function signedEvent(logs) {
  const events = logs.filter((s) => s.startsWith("EVENT_JSON:")).map((s) => JSON.parse(s.slice(11)))
    .filter((e) => e.standard === "truenav-receipts" && e.version === "1.0.0" && e.event === "mirror_signed");
  if (events.length !== 1 || events[0].data.length !== 1) throw Error("exactly one signed mirror event required");
  return events[0].data[0];
}
export async function validateSigned(event, { mirrorAddress, mpcAddress }) {
  if (!Number.isSafeInteger(event.nonce) || event.nonce < 0 || !Number.isSafeInteger(event.seq) || event.seq < 1) throw Error("unsafe mirror index");
  if (!/^[0-9a-f]+$/.test(event.signed_tx) || event.signed_tx.length % 2) throw Error("invalid signed transaction");
  const raw = `0x${event.signed_tx}`;
  if (keccak256(raw).slice(2) !== event.tx_hash) throw Error("transaction hash mismatch");
  const tx = parseTransaction(raw);
  if (tx.type !== "eip1559" || tx.chainId !== CHAIN_ID || tx.nonce !== event.nonce ||
      tx.to?.toLowerCase() !== mirrorAddress.toLowerCase() || (tx.value ?? 0n) !== 0n ||
      tx.gas !== 150000n || (tx.accessList?.length ?? 0) !== 0 ||
      !tx.maxFeePerGas || tx.maxFeePerGas > 100000000000n || tx.maxFeePerGas !== tx.maxPriorityFeePerGas) throw Error("unexpected mirror transaction");
  const decoded = decodeFunctionData({ abi, data: tx.data });
  if (decoded.functionName !== "update" || decoded.args[1] !== BigInt(event.seq)) throw Error("unexpected mirror call");
  if ((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== mpcAddress.toLowerCase()) throw Error("wrong MPC signer");
  return { raw, hash: keccak256(raw), tx, args: decoded.args };
}
export async function broadcast(event, options) {
  const checked = await validateSigned(event, options);
  if (await options.client.getChainId() !== CHAIN_ID) throw Error("Base Sepolia only");
  const balance = await options.client.getBalance({ address: options.mpcAddress });
  if (balance < checked.tx.gas * checked.tx.maxFeePerGas) throw Error("insufficient testnet gas balance");
  const hash = await options.client.sendRawTransaction({ serializedTransaction: checked.raw });
  if (hash.toLowerCase() !== checked.hash.toLowerCase()) throw Error("broadcast hash mismatch");
  return hash;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mirrorAddress, mpcAddress, rpc, execute] = process.argv.slice(2);
  const event = signedEvent(JSON.parse(await readFile(file, "utf8")));
  const checked = await validateSigned(event, {mirrorAddress,mpcAddress});
  if (execute !== "--execute") console.log(JSON.stringify({ dry_run: true, tx_hash: checked.hash }));
  else console.log(await broadcast(event,{mirrorAddress,mpcAddress,client:createPublicClient({transport:http(rpc)})}));
}
