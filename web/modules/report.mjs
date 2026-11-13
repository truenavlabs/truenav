// JSON report bundle. Browser crypto.subtle, no node: imports.
// The shell passes whatever it has. Missing live sections stay null and are labeled.

const LIMITS = [
  { text: "TrueNav informs only. The registry makes no cross-contract call, sends no NEAR, and its pledge tokens cannot be transferred.", source: "README, How it works, step 5" },
  { text: "Testnet and fictional data only. TrueRange assumes independent defaults.", source: "README, Security and limits" },
  { text: "Pledges, verdicts, attempts, alerts and certificates are public chain state. A refused pledge returns already pledged elsewhere without naming the holder.", source: "README, Security and limits" },
  { text: "The certificate signer is a test key, not a TEE key. Anyone can recompute the numbers.", source: "README, Roles and keys" },
  { text: "The contract does not verify the hardware quote. The registrar checks attestation off chain.", source: "README, Roles and keys" },
  { text: "A TEE proves which code ran, not that the model's judgment is right.", source: "README, Security and limits" },
];

const HOW = [
  "Re-read views with the NEAR CLI or a JSON-RPC query to registry.tnlab-368aa2.testnet. Methods include get_fund, get_latest_certificate, get_lock, nft_token.",
  "npm run chain:read",
  "npm run verify:attestation",
  "Recompute each manifest sha256 from the JSON section with sorted keys.",
];

function stable(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildReportBundle(input = {}) {
  const sections = {
    fund: input.fund || null,
    certificate: input.certificate || null,
    derived: input.derived || null,
    loans: input.loans || [],
    limits: LIMITS,
    how_to_verify: HOW,
  };
  const sha256 = {};
  for (const [key, value] of Object.entries(sections)) {
    sha256[key] = await sha256Hex(stable(value));
  }
  return {
    manifest: {
      publisher: "TrueNav Labs",
      schema: "truenav-report-v1",
      version: "depth-modules",
      contract: "registry.tnlab-368aa2.testnet",
      network: "testnet",
      rpc: input.rpc || null,
      readAt: input.readAt || null,
      block_height: input.blockHeight ?? null,
      block_hash: input.blockHash || null,
      sha256,
      source_tags: input.sourceTags || ["recorded", "computed", "demo"],
      note: "Live chain fields are present only when the shell passed them. Demo loan detail is fictional. Market data is not part of this bundle and does not affect the score.",
    },
    ...sections,
  };
}

export function bundleFileName(fundId, readAt) {
  const stamp = (readAt || "undated").replace(/[:.]/g, "-");
  return `truenav-report-${fundId || "fund"}-${stamp}.json`;
}

export { LIMITS, HOW };
