// Pseudonymous identifiers (spec/v2/SPEC.md section 3). Inside the TEE the key is OutLayer's per-project derived
// `mac` key and never leaves the enclave; this JS reference takes the key as a parameter so tests and the Rust
// port produce the same refs. A ref is the first 16 bytes of HMAC-SHA256(key, "<domain>|<id>") as hex.
import { createHmac } from "node:crypto";

export function ref(key, domain, id) {
  if (!key || key.length < 16) throw new Error("pseudonym key must be at least 16 bytes");
  if (!/^[a-z_]+$/.test(domain)) throw new Error("bad domain");
  return createHmac("sha256", key).update(`truenav-ref-v1|${domain}|${String(id).trim()}`).digest("hex").slice(0, 32);
}
export const unitRef = (key, id) => ref(key, "unit", id);
export const payerRef = (key, name) => ref(key, "payer", String(name).toUpperCase().replace(/\s+/g, " "));
