// A05: what the Attestation page may claim. A matching report hash only says the registry points at this report.
// The signer claim also needs the report's own model signing address to equal the registry's TEE signer.

/** The model signing address named in an attestation report (JSON bytes), lowercase, or null when unreadable. */
export function reportSigningAddress(bytes) {
  try {
    const report = JSON.parse(new TextDecoder().decode(bytes));
    const a = Array.isArray(report.model_attestations) ? report.model_attestations[0] : null;
    const addr = a && typeof a.signing_address === "string" ? a.signing_address.trim().toLowerCase() : "";
    return /^0x[0-9a-f]{40}$/.test(addr) ? addr : null;
  } catch {
    return null;
  }
}

const lower = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const tail = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a || "none");

/**
 * Result of comparing the published report with what the registry stores.
 * state: "match" (hash and address both agree), "no-match" (report hash differs), "address-differs" (hash agrees,
 * address does not or cannot be read).
 */
export function bindingResult({ computedSha, storedSha, registryAddress, reportAddress } = {}) {
  if (!computedSha || !storedSha || computedSha !== storedSha) return { state: "no-match", text: "does not match" };
  const reg = lower(registryAddress);
  const rep = lower(reportAddress);
  if (!reg) return { state: "address-differs", text: "The report hash matches, but the registry has no TEE signer address to compare with the report." };
  if (!rep) return { state: "address-differs", text: "The report hash matches, but the signing address in the report could not be read, so the key is not confirmed." };
  if (reg !== rep) return { state: "address-differs", text: `The report hash matches, but the report's signing address ${tail(rep)} differs from the registry's TEE signer ${tail(reg)}.` };
  return { state: "match", text: `match: the report hashes to the value stored on chain, and its signing address is the registry's TEE signer ${tail(reg)}` };
}
