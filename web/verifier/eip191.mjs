// Browser-safe EIP-191 recovery and sha256 for the verifier panel. Same primitives and same message format as
// tee/underwrite.mjs eip191Recover (which uses Buffer and pulls in node:fs, so the browser cannot import it).
// web/verifier/test/verifier-data.test.mjs checks this function returns exactly what eip191Recover returns on every
// recorded verdict and on a corrupted signature.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("not hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** sha256 of a UTF-8 string or bytes, lowercase hex. */
export const sha256Hex = (data) => toHex(sha256(typeof data === "string" ? enc.encode(data) : data));

/** Lowercase 0x address that signed `text` (EIP-191 personal_sign) with the 65-byte `sigHex`. Throws on a malformed signature. */
export function eip191Recover(text, sigHex) {
  const msg = enc.encode(text);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const buf = new Uint8Array(prefix.length + msg.length);
  buf.set(prefix);
  buf.set(msg, prefix.length);
  const digest = keccak_256(buf);
  const sig = hexToBytes(sigHex);
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(digest).toBytes(false);
  return `0x${toHex(keccak_256(pub.subarray(1)).subarray(12))}`;
}

/** Bytes of a base64 text (whitespace ignored); uses atob, no Node APIs */
export function base64ToBytes(b64) {
  const s = String(b64).replace(/\s+/g, "");
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error("no base64 decoder");
}
