// RT-17 helper: list the access keys on a registry account, read only. No keys, no signing, no transactions sent.
//
//   node certify/key-audit.mjs [--contract <account>] [--rpc <url>] [--owner-key <pub>] [--backup-key <pub>]
//   node certify/key-audit.mjs --check [--contract <account>] [--rpc <url>]
//
// Default report: every access key on the account with its permission and nonce, and how many are full access.
// The chain does not say which full-access key belongs to whom. If you name one of two full-access keys with
// --owner-key (the one that stays) or --backup-key (the one to remove), the script works out the other and prints
// the exact unsigned DeleteKey transaction that the owner's key must sign to remove the backup key. The transaction
// is only printed, as JSON and as base64 of the borsh bytes. This file has no code that signs or broadcasts, and it
// refuses a value that is a secret key.
//
// --check: exit 0 if the account has at most one full-access key, exit 1 if it has more, exit 2 on a usage or
// network error. It is an npm script (npm run rt17:check), not a CI job.
//
// Only the RPC methods `query` (view_access_key_list) are called.
import { PublicKey, createTransaction, actions, encodeTransaction, baseDecode } from "near-api-js";
import { DEFAULT_RPC, BACKUP_RPCS, DEFAULT_CONTRACT } from "../web/chain.mjs";

export class UsageError extends Error {}

/** A NEAR public key string "ed25519:<base58 of 32 bytes>", or throws. A 64 byte value is a secret key: refused, not echoed. */
export function parsePublicKey(text, flag) {
  const s = String(text ?? "");
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,90})$/.exec(s);
  if (!m) throw new UsageError(`${flag} must be a public key like ed25519:<base58>`);
  let n;
  try { n = baseDecode(m[1]).length; } catch { throw new UsageError(`${flag} must be a public key like ed25519:<base58>`); }
  if (n === 64) throw new UsageError(`${flag} looks like a SECRET key (64 bytes). Never paste a secret key. Give the public key.`);
  if (n !== 32) throw new UsageError(`${flag} must be a public key like ed25519:<base58>`);
  return PublicKey.from(s).toString();
}

export function parseArgs(argv, env = process.env) {
  const out = { contract: env.TRUENAV_CONTRACT || DEFAULT_CONTRACT, rpc: env.TRUENAV_RPC || DEFAULT_RPC, ownerKey: null, backupKey: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === "--check") out.check = true;
    else if (a === "--contract") out.contract = val();
    else if (a === "--rpc") out.rpc = val();
    else if (a === "--owner-key") out.ownerKey = parsePublicKey(val(), "--owner-key");
    else if (a === "--backup-key") out.backupKey = parsePublicKey(val(), "--backup-key");
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (!/^[a-z0-9._-]{2,64}$/.test(out.contract)) throw new UsageError("--contract must be a NEAR account id");
  if (out.ownerKey && out.backupKey && out.ownerKey === out.backupKey) throw new UsageError("--owner-key and --backup-key are the same key");
  if (out.check && (out.ownerKey || out.backupKey)) throw new UsageError("--check does not take --owner-key or --backup-key");
  return out;
}

async function rpcOnce(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "rt17", method, params }) });
  if (!r.ok) throw new Error(`RPC ${method} failed: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method} failed: ${j.error.message || JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}
async function rpc(url, method, params) {
  const urls = url === DEFAULT_RPC ? [DEFAULT_RPC, ...BACKUP_RPCS] : [url];
  let last;
  for (const u of urls) { try { return await rpcOnce(u, method, params); } catch (e) { last = e; } }
  throw last;
}

/** view_access_key_list at final, normalised: { block_hash, block_height, keys: [{ public_key, nonce, full_access, permission }] } */
export async function loadKeys(contract, rpcUrl) {
  const res = await rpc(rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: contract });
  const keys = (res.keys || []).map((k) => {
    const perm = k.access_key.permission;
    const full = perm === "FullAccess";
    return {
      public_key: k.public_key,
      nonce: BigInt(k.access_key.nonce),
      full_access: full,
      permission: full ? "FullAccess" : `FunctionCall ${perm?.FunctionCall?.receiver_id ?? "?"} [${(perm?.FunctionCall?.method_names || []).join(",") || "any method"}]`,
    };
  });
  return { block_hash: res.block_hash, block_height: res.block_height, keys };
}

/** The unsigned DeleteKey transaction: signed by `signingKey` (the key that stays), deleting `deleteKey` from `account`. */
export function buildDeleteKey({ account, signingKey, signingNonce, deleteKey, blockHash }) {
  const nonce = signingNonce + 1n;
  const tx = createTransaction(account, PublicKey.from(signingKey), account, nonce, [actions.deleteKey(PublicKey.from(deleteKey))], baseDecode(blockHash));
  return {
    json: { signer_id: account, public_key: signingKey, receiver_id: account, nonce: nonce.toString(), block_hash: blockHash, actions: [{ DeleteKey: { public_key: deleteKey } }] },
    borsh_base64: Buffer.from(encodeTransaction(tx)).toString("base64"),
  };
}

/** Work out which full-access key is which. Returns { fullAccess, owner, backup, why } with owner/backup null when unknown. */
export function identify(keys, { ownerKey, backupKey }) {
  const fullAccess = keys.filter((k) => k.full_access);
  const has = (pk) => fullAccess.find((k) => k.public_key === pk);
  if (ownerKey && !has(ownerKey)) throw new UsageError("--owner-key is not a full-access key on this account");
  if (backupKey && !has(backupKey)) throw new UsageError("--backup-key is not a full-access key on this account");
  if (fullAccess.length !== 2) return { fullAccess, owner: null, backup: null, why: `the account has ${fullAccess.length} full-access keys; a DeleteKey for a backup key is only prepared when there are exactly 2` };
  if (!ownerKey && !backupKey) return { fullAccess, owner: null, backup: null, why: "the chain does not say which full-access key is the owner's; pass --owner-key (the key that stays) or --backup-key (the key to remove)" };
  const owner = ownerKey ? has(ownerKey) : fullAccess.find((k) => k.public_key !== backupKey);
  const backup = backupKey ? has(backupKey) : fullAccess.find((k) => k.public_key !== ownerKey);
  return { fullAccess, owner, backup, why: null };
}

export async function main(argv, env = process.env, out = console.log) {
  const a = parseArgs(argv, env);
  const { block_hash, block_height, keys } = await loadKeys(a.contract, a.rpc);
  const fa = keys.filter((k) => k.full_access);
  out(`access keys on ${a.contract} (final block ${block_height}, ${block_hash}):`);
  for (const k of keys) out(`  ${k.public_key}  ${k.permission}  nonce ${k.nonce}`);
  out(`full-access keys: ${fa.length}`);
  if (a.check) {
    if (fa.length > 1) { out(`FAIL ${a.contract} has ${fa.length} full-access keys, expected at most 1 (RT-17)`); return 1; }
    out(`PASS ${a.contract} has ${fa.length} full-access key${fa.length === 1 ? "" : "s"}`);
    return 0;
  }
  const id = identify(keys, a);
  if (!id.owner) { out(`no transaction prepared: ${id.why}`); return 0; }
  const tx = buildDeleteKey({ account: a.contract, signingKey: id.owner.public_key, signingNonce: id.owner.nonce, deleteKey: id.backup.public_key, blockHash: block_hash });
  out(`owner key (stays):    ${id.owner.public_key}`);
  out(`backup key (removed): ${id.backup.public_key}`);
  out("unsigned DeleteKey transaction (NOT SENT; this script cannot sign or send):");
  out(JSON.stringify(tx.json, null, 2));
  out(`unsigned transaction, borsh, base64: ${tx.borsh_base64}`);
  out("Sign it offline with the owner key and broadcast it yourself. After it lands, run: npm run rt17:check");
  out("The block hash is valid for about a day; re-run this script for a fresh one.");
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof UsageError ? `usage error: ${e.message}` : `error: ${e.message}`);
    process.exitCode = 2;
  });
}
