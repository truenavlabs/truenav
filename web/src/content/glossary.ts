// Glossary. Every metric label's "?" explainer comes from here. Wording follows README, TRUST_MODEL and NAV_SPEC.
export type Term = { id: string; term: string; text: string; link?: string };

export const GLOSSARY: Term[] = [
  { id: "nav", term: "NAV", text: "Net asset value: what a fund says its holdings are worth, minus what it owes." },
  { id: "reported-nav", term: "Reported NAV", text: "The NAV the fund manager publishes. TrueNav checks it; it does not set it." },
  { id: "headline-nav", term: "Headline NAV", text: "The reported NAV as the fund states it to investors, before any policy markdowns." },
  { id: "policy-nav", term: "Policy NAV", text: "The book after the fund's own valuation policy marks down delinquent loans (for example 15% off loans more than 90 days late)." },
  { id: "trueval", term: "TrueVal", text: "What the fund's loans are worth after expected losses. Model estimate, not fair value.", link: "/methodology" },
  { id: "truerange", term: "TrueRange", text: "Where TrueVal likely falls, assuming loans default independently. Demo estimate. It is TrueVal plus or minus 1.96 standard deviations of loss.", link: "/methodology" },
  { id: "score", term: "TrueNav score", text: "How far you can trust the fund's reported NAV, 0 to 100. Green 85 and up, yellow 60 to 84, red below 60.", link: "/methodology" },
  { id: "band", term: "Band", text: "The colour of a score: green 85 and up, yellow 60 to 84, red below 60." },
  { id: "pd", term: "PD", text: "Probability of default for a loan's delinquency bucket. Demo table, not calibrated: current 2%, 1 to 30 days late 10%, 31 to 60 days 25%, 61 to 90 days 45%, over 90 days 100%." },
  { id: "lgd", term: "LGD", text: "Loss given default: the share lost if a loan defaults. Demo values: real estate 31%, invoices 67%." },
  { id: "ead", term: "EAD", text: "Exposure at default: principal plus accrued interest minus repayments." },
  { id: "pledge", term: "Pledge", text: "A fund locking a loan to itself on the registry. One loan, one fund." },
  { id: "pledge-token", term: "Pledge token", text: "A non-transferable NEP-171 token the registry mints per pledged loan. It cannot be sold or moved." },
  { id: "double-pledge", term: "Double pledge", text: "The same loan pledged to two funds. The registry refuses the second pledge with \"already pledged elsewhere\"." },
  { id: "blocked-attempt", term: "Blocked attempt", text: "A refused double pledge, stored on the fund that tried. The holder is not named." },
  { id: "alert", term: "Alert", text: "A timestamp stored with every blocked attempt, on the fund that tried." },
  { id: "servicer", term: "Servicer", text: "The party that keeps the loan tape and submits verdicts. In this demo it is TrueNav Labs." },
  { id: "verdict", term: "Verdict", text: "The enclave's answer for one loan document: pass or flag, with anomaly codes. Stored on chain only if a registered TEE signer signed it." },
  { id: "anomaly", term: "Anomaly code", text: "Why a document was flagged: amount_mismatch, id_mismatch, asset_mismatch, duplicate_document, duplicate_evidence_line, injection_attempt, unreadable." },
  { id: "tee", term: "TEE", text: "Trusted execution environment: sealed hardware that can prove which code is running. Here, NEAR AI Cloud on Intel TDX with NVIDIA confidential GPUs." },
  { id: "attestation", term: "Attestation", text: "A signed hardware report proving the enclave is genuine, up to date and not in debug mode, and binding its signing key." },
  { id: "tdx", term: "Intel TDX", text: "Intel Trust Domain Extensions: the CPU side of the enclave. Its quote is checked against Intel collateral." },
  { id: "eip191", term: "EIP-191 signature", text: "The signature format the enclave uses. Anyone can recover the signer address from the message and signature." },
  { id: "loan-hash", term: "Loan hash", text: "A 64 character fingerprint of a loan, used on chain instead of the loan itself." },
  { id: "certificate", term: "Certificate", text: "A fund's signed score record on chain: score, band, TrueVal, TrueRange, NAVs and engine commit. Signed by a test key held by TrueNav Labs, not a TEE key." },
  { id: "recompute", term: "Recompute", text: "Running the public scoring engine in your browser on the same inputs to check the certificate's numbers." },
  { id: "testnet", term: "Testnet", text: "NEAR's public test network. Tokens have no value. Everything here runs on testnet with fictional funds." },
  { id: "rpc", term: "RPC", text: "The public NEAR endpoint your browser reads the registry from. Read-only view calls, no keys." },
  { id: "code-hash", term: "Code hash", text: "The hash of the contract code deployed on chain. Compared with the hash the repository expects." },
  { id: "entitlement", term: "Entitlement", text: "A one-use right to fetch a paid report, bought for 0.01 testnet NEAR. Query is live on its pin. Receipts is live v2; v3 is pinned, not deployed." },
];

export const TERM = Object.fromEntries(GLOSSARY.map((t) => [t.id, t])) as Record<string, Term>;
