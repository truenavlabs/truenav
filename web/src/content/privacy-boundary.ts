// Privacy boundary: what each party can see and what stays hidden. Data only, no layout.
// Every row names the code or the repository document that says it (`sources`: a file and a sentence that must appear
// in it; web/data/test/privacy-boundary.test.mjs checks both). The honest leaks are listed once in LEAKS, tied to the
// whitepaper section that states them, and to docs/KNOWN_LIMITS.md. Where a row relies on a hardware assumption, the
// cell says "assumed", never "hidden". This module claims nothing beyond the sourced sentences.

export type PartyId = "public" | "verifier" | "lender" | "fund" | "tee_operator" | "truenav_operator";
/** sees: can read it. partial: sees a derived, banded or hashed view, or learns it only by already holding the input.
 *  assumed: hidden only if a stated trust assumption holds. hidden: no path in the code or contract exposes it. */
export type Level = "sees" | "partial" | "assumed" | "hidden";
export type Status = "live" | "design" | "mixed";
export type LeakId = "hash_guessing" | "document_holder_link" | "singleton_aggregates" | "v2_receipt_granularity" | "metadata" | "operators_see_inputs" | "history_stays_public";

export type Party = { id: PartyId; label: string; who: string };
export type Cell = { level: Level; note: string };
export type Source = { file: string; needle: string };
export type Row = {
  id: string;
  item: string;
  lives: string;
  status: Status;
  cells: Record<PartyId, Cell>;
  sources: Source[];
  leaks: LeakId[];
};
export type Leak = { id: LeakId; title: string; text: string; whitepaper: string };

export const LEVELS: Record<Level, string> = {
  sees: "Can see it",
  partial: "Sees a bounded or derived view",
  assumed: "Hidden if a stated assumption holds",
  hidden: "Cannot see it",
};

export const PARTIES: Party[] = [
  { id: "public", label: "Public chain", who: "Anyone reading NEAR testnet state and transactions, with no keys and no repository." },
  { id: "verifier", label: "Judge or verifier", who: "Someone running the repository checks: public chain data, the published attestation reports, the committed demo files and the public reference engine." },
  { id: "lender", label: "Lender or allocator", who: "An investor reading a fund's score and receipt, with or without a paid one-use report entitlement." },
  { id: "fund", label: "Fund", who: "The fund manager's account, which pledges its own loans and supplies its own documents and claims." },
  { id: "tee_operator", label: "TEE operator", who: "The hosts of the enclaves: NEAR AI Cloud for the underwriter model and OutLayer for fingerprints and the receipt engine." },
  { id: "truenav_operator", label: "TrueNav operator", who: "TrueNav Labs, which on testnet runs the servicer, the registrar, the certificate signer, the report API and the fingerprint requests." },
];

const c = (level: Level, note: string): Cell => ({ level, note });

export const ROWS: Row[] = [
  {
    id: "loan_documents",
    item: "Loan document text and the fund's claimed amount",
    lives: "Sent inside the underwriter request to the NEAR AI Cloud enclave over TLS. The registry stores no document content.",
    status: "live",
    cells: {
      public: c("hidden", "No registry field can carry it: the contract rejects any reply key outside a short allowed list."),
      verifier: c("hidden", "Not on chain. The demo documents committed in the repository are fictional, so reading them reveals nothing real."),
      lender: c("hidden", "Not on chain and not in any receipt or report."),
      fund: c("sees", "The fund supplies its own documents and claims."),
      tee_operator: c("assumed", "Processed inside Intel TDX with NVIDIA confidential computing. Hardware isolation is the stated assumption. The registrar checks the attestation off chain and does not pin the image measurements."),
      truenav_operator: c("sees", "The servicer builds the request and sends it, so the operator holds the document it submits."),
    },
    sources: [
      { file: "tee/underwrite.mjs", needle: "The document never leaves this process except inside the TEE request" },
      { file: "contract/src/lib.rs", needle: "reply has a key outside the allowed list" },
      { file: "TRUST_MODEL.md", needle: "The underwriter request (document plus claim) is sent to NEAR AI Cloud over TLS" },
    ],
    leaks: [],
  },
  {
    id: "verdict",
    item: "Verdict, anomaly codes, signer, expiry and hashes of each underwriter run",
    lives: "Registry contract, stored by submit_verdict after the TEE signature, signer, model, binding and expiry checks.",
    status: "live",
    cells: {
      public: c("sees", "Public chain state: pass or flag, anomaly codes, request and response hashes, signer and expiry."),
      verifier: c("sees", "Same chain data, and can recompute the signer from the reply in the transaction arguments."),
      lender: c("sees", "Same chain data."),
      fund: c("sees", "Same chain data."),
      tee_operator: c("sees", "It produced and signed the reply."),
      truenav_operator: c("sees", "The servicer submits every stored verdict."),
    },
    sources: [
      { file: "contract/src/lib.rs", needle: "One TEE underwriter verdict for a loan. No document content is stored." },
      { file: "TRUST_MODEL.md", needle: "the latest one counts" },
    ],
    leaks: [],
  },
  {
    id: "reply_metadata",
    item: "Token counts, timestamps, asset type and pledge counts",
    lives: "Signed reply (usage block), pledge token metadata, and block times of every pledge, verdict, attempt and certificate.",
    status: "live",
    cells: {
      public: c("sees", "Token counts reveal the document's length and cannot be stripped, because the TEE signature covers the whole reply."),
      verifier: c("sees", "Same chain data."),
      lender: c("sees", "Same chain data."),
      fund: c("sees", "Same chain data."),
      tee_operator: c("sees", "It sees the request size and timing."),
      truenav_operator: c("sees", "It submits the transactions."),
    },
    sources: [
      { file: "TRUST_MODEL.md", needle: "The signed body carries `usage`" },
      { file: "contract/src/lib.rs", needle: "extra: Some(format!(" },
    ],
    leaks: ["metadata"],
  },
  {
    id: "request_hash",
    item: "Request hash of each verdict (unsalted sha256 of the whole request)",
    lives: "Registry contract, request_sha256 inside each stored verdict.",
    status: "live",
    cells: {
      public: c("partial", "Sees only a hash. It means nothing unless the reader already holds the document."),
      verifier: c("partial", "Can recompute it only from a document it already has, such as the fictional demo files."),
      lender: c("partial", "Sees only a hash, unless it already holds the document."),
      fund: c("sees", "Holds the document, so can rebuild the request and match its own loan."),
      tee_operator: c("assumed", "Sees the request inside the enclave under the same hardware assumption as the document."),
      truenav_operator: c("sees", "Builds the request, so holds everything the hash commits to."),
    },
    sources: [
      { file: "TRUST_MODEL.md", needle: "`request_sha256` is sha256 of the request with no salt" },
      { file: "TRUST_MODEL.md", needle: "Anyone who holds the document can rebuild the request, try amounts until the hash matches" },
    ],
    leaks: ["hash_guessing", "document_holder_link"],
  },
  {
    id: "loan_hash",
    item: "Loan fingerprint, the fund holding it, pledge time and asset type",
    lives: "Registry contract: pledge lock, pledge token and its metadata. get_lock is a public view.",
    status: "live",
    cells: {
      public: c("sees", "Public by design: it is what makes a second pledge of the same loan detectable. It does not name the borrower or the document."),
      verifier: c("sees", "Same chain data."),
      lender: c("sees", "Same chain data."),
      fund: c("sees", "Same chain data, including its own pledges."),
      tee_operator: c("sees", "OutLayer computes the fingerprint for each request."),
      truenav_operator: c("sees", "Requests the fingerprints and submits the pledge tickets."),
    },
    sources: [
      { file: "contract/src/lib.rs", needle: "pub fn get_lock(&self, loan_hash: String) -> Option<Lock>" },
      { file: "TRUST_MODEL.md", needle: "a caller that is allowed to use the service can request a fingerprint for any guessed asset class" },
    ],
    leaks: ["hash_guessing"],
  },
  {
    id: "fingerprint_key",
    item: "The key that makes loan fingerprints (a MAC key)",
    lives: "Derived and used only inside the OutLayer enclave. The fingerprint module never sees it.",
    status: "live",
    cells: {
      public: c("hidden", "Never published and never an input to any call."),
      verifier: c("hidden", "Never published. The repository checks the OutLayer proof that the pinned module ran, not the key."),
      lender: c("hidden", "Never published."),
      fund: c("hidden", "A fund's own payment key derives a different key, so it cannot make or check a fingerprint the engine will accept."),
      tee_operator: c("assumed", "OutLayer holds the root secret that the key is derived from. Trusting OutLayer's enclave is an assumption this repository does not check."),
      truenav_operator: c("hidden", "The operator can ask for fingerprints, which is the guessing exposure listed under the leaks, but cannot read the key."),
    },
    sources: [
      { file: "tee/fingerprint.mjs", needle: "The module never sees the key." },
      { file: "TRUST_MODEL.md", needle: "A fund payment key derives a different key." },
    ],
    leaks: [],
  },
  {
    id: "fingerprint_request",
    item: "Asset class and document id sent to get a fingerprint",
    lives: "HTTPS request to OutLayer with a random nonce. The public attestation carries only the sha256 of the input.",
    status: "live",
    cells: {
      public: c("hidden", "Not on chain. The nonce stops the attestation's input hash being matched against guesses."),
      verifier: c("sees", "Only for the fictional demo loans, whose inputs are committed so each attestation can be re-checked. Real inputs would not be published."),
      lender: c("hidden", "Not on chain and not in any receipt."),
      fund: c("sees", "The fund knows its own document ids."),
      tee_operator: c("assumed", "The module reads the input inside the enclave."),
      truenav_operator: c("sees", "The operator submits the reference, so it sees document identifiers when a fingerprint is requested."),
    },
    sources: [
      { file: "TRUST_MODEL.md", needle: "The operator still sees document identifiers when a fingerprint is requested." },
      { file: "tee/fingerprint.mjs", needle: "with a random nonce so the run's public" },
    ],
    leaks: ["operators_see_inputs"],
  },
  {
    id: "attempts_alerts",
    item: "Blocked double-pledge attempts and alerts",
    lives: "Registry contract, stored under the id of the fund that tried.",
    status: "live",
    cells: {
      public: c("sees", "A refusal stores one attempt and one alert under the refusing fund. The refusal reply does not name the fund that holds the loan, although get_lock shows the holder to anyone who knows the loan hash."),
      verifier: c("sees", "Same chain data, including the refused transaction."),
      lender: c("sees", "Same chain data. Attempts lower a fund's score."),
      fund: c("sees", "Sees its own attempts and alerts."),
      tee_operator: c("sees", "Public chain data."),
      truenav_operator: c("sees", "Public chain data."),
    },
    sources: [
      { file: "contract/src/lib.rs", needle: "stores one blocked attempt and one alert under the refused fund's id" },
      { file: "TRUST_MODEL.md", needle: "They never name the other fund, but they are not private." },
    ],
    leaks: [],
  },
  {
    id: "certificates",
    item: "Registry certificates: exact fund totals, score and band",
    lives: "Registry contract. TrueVal, TrueRange, Policy NAV, headline and the unrounded raw score in hundredths.",
    status: "live",
    cells: {
      public: c("sees", "Exact fund-level figures. A fund holding one loan therefore reveals that loan's figures."),
      verifier: c("sees", "Same chain data, and can recompute every number with the public reference engine."),
      lender: c("sees", "Same chain data."),
      fund: c("sees", "Same chain data."),
      tee_operator: c("hidden", "The certificate path does not run in either enclave."),
      truenav_operator: c("sees", "The operator runs the engine and signs the certificate."),
    },
    sources: [
      { file: "contract/src/lib.rs", needle: "pub true_val_cents: U128," },
      { file: "TRUST_MODEL.md", needle: "A fund that holds one loan exposes that loan's figures through its certificate totals." },
    ],
    leaks: ["singleton_aggregates"],
  },
  {
    id: "certificate_key",
    item: "Certificate signing key",
    lives: "Held by the operator. A test key, not a TEE key.",
    status: "live",
    cells: {
      public: c("hidden", "Only the signer address is on chain."),
      verifier: c("hidden", "Only the signer address is on chain. The engine is public, so the numbers can be recomputed without the key."),
      lender: c("hidden", "Only the signer address is on chain."),
      fund: c("hidden", "Not shared with funds."),
      tee_operator: c("hidden", "Not an enclave key."),
      truenav_operator: c("sees", "The operator holds it. The same test address is also the servicer pledge key."),
    },
    sources: [
      { file: "TRUST_MODEL.md", needle: "The certificate signer is a test key, not TEE." },
      { file: "docs/KNOWN_LIMITS.md", needle: "Shared certificate signer and pledge key (N-07)" },
    ],
    leaks: [],
  },
  {
    id: "score_inputs",
    item: "Loan tapes, bank feeds and fund administrator data that feed a score",
    lives: "The public reference engine takes them as inputs today. The v3 design reads them only inside the OutLayer enclave.",
    status: "mixed",
    cells: {
      public: c("hidden", "Not on chain."),
      verifier: c("hidden", "Not on chain. The demo inputs in the repository are fictional."),
      lender: c("hidden", "Not on chain and not in any receipt."),
      fund: c("sees", "The fund and its servicer, bank and administrator hold their own data."),
      tee_operator: c("hidden", "Not used today, because the reference engine runs outside any enclave. In the v3 design, which is not deployed, OutLayer would read them under the hardware assumption."),
      truenav_operator: c("sees", "Today the engine runs outside any enclave, so the operator sees the payload it scores."),
    },
    sources: [
      { file: "TRUST_MODEL.md", needle: "The engine runs outside any TEE" },
      { file: "outlayer/engine-v3/README.md", needle: "All exact money, cash matches, individual positions, precision parts" },
    ],
    leaks: ["operators_see_inputs"],
  },
  {
    id: "receipt_v2",
    item: "Live receipt body (receipts contract, method cashflow-v2.1.0)",
    lives: "Receipts contract on testnet. It publishes aggregate cash metrics with cohorts under five units suppressed.",
    status: "live",
    cells: {
      public: c("partial", "Would see aggregate cash metrics, including cohort balances and exact ratios. In a small book two aggregates can be enough to solve for a hidden balance. No receipt is stored on chain right now."),
      verifier: c("partial", "Same view, and the recorded capture shows zero stored receipts."),
      lender: c("partial", "Same view. A paid report returns the stored public receipt, not the private inputs."),
      fund: c("sees", "Knows its own inputs."),
      tee_operator: c("assumed", "The engine reads the sealed sources inside OutLayer under the hardware assumption."),
      truenav_operator: c("assumed", "Hidden from the operator only if the OutLayer enclave assumption holds."),
    },
    sources: [
      { file: "receipts/README.md", needle: "cohorts under 5 units" },
      { file: "SPEC_RECEIPT_V3.md", needle: "DEMO-CREDIT exposes a non-late/current principal sum of 850M cents" },
      { file: "web/data/recorded/receipts-live.json", needle: "\"method\": \"cashflow-v2.1.0\"" },
      { file: "api/server.mjs", needle: "for (const key of Object.keys(body)) if (!allowed.has(key)) delete body[key];" },
    ],
    leaks: ["v2_receipt_granularity", "history_stays_public"],
  },
  {
    id: "receipt_v3_public",
    item: "v3 public receipt envelope (designed, not deployed)",
    lives: "Would be stored by the v3 receipts contract. The v3 contract and engine are built and pinned and are not deployed on the live account.",
    status: "design",
    cells: {
      public: c("partial", "Would see rounded NAV on a fixed 1-2-5 ladder, coarse bands, suppressed small cohort counts and a whole-number score. Not deployed, so nothing is published in this format today."),
      verifier: c("partial", "Can check the closed schema and the pins offline. Not deployed."),
      lender: c("partial", "Same view as the public. Not deployed."),
      fund: c("sees", "Knows its own exact figures."),
      tee_operator: c("assumed", "The engine would compute it inside OutLayer. Not deployed."),
      truenav_operator: c("partial", "Would see the public envelope only, if the enclave assumption holds. Not deployed."),
    },
    sources: [
      { file: "outlayer/engine-v3/README.md", needle: "Public NAV uses the fixed integer 1-2-5 ladder." },
      { file: "SPEC_RECEIPT_V3.md", needle: "Primary suppression: hide positive counts 1..4 as <5." },
    ],
    leaks: ["singleton_aggregates"],
  },
  {
    id: "receipt_private_report",
    item: "v3 private report: exact NAV, score parts, per-loan rows, cash totals and the salt (designed, not deployed)",
    lives: "Encrypted by the engine host and handed to a sealed store. Only a commitment would be public. The v3 path is not deployed.",
    status: "design",
    cells: {
      public: c("hidden", "Only a salted commitment would be public. Not deployed."),
      verifier: c("hidden", "Cannot open it without the salt and an authorized read. Not deployed."),
      lender: c("hidden", "Buyer authorization, payment and re-encryption are a separate report service that is not built."),
      fund: c("sees", "Knows its own inputs, which are the same figures."),
      tee_operator: c("assumed", "The plaintext would exist only inside the enclave. Not deployed."),
      truenav_operator: c("assumed", "Would hold the ciphertext and the commitment, and would not hold the plaintext only if the enclave assumption holds. Not deployed."),
    },
    sources: [
      { file: "outlayer/engine-v3/README.md", needle: "All exact money, cash matches, individual positions, precision parts and the fresh random 32-byte salt stay in the private report." },
      { file: "outlayer/engine-v3/README.md", needle: "Buyer authorization, payment and re-encryption are a separate report service" },
    ],
    leaks: [],
  },
];

export const LEAKS: Leak[] = [
  {
    id: "hash_guessing",
    title: "Hash guessing",
    text: "The registry's request hashes are unsalted, so a document holder can test guesses against them. Fingerprints can also be guessed by a party that is allowed to request them, and this repository applies no rate limit and keeps no query log.",
    whitepaper: "12.3",
  },
  {
    id: "document_holder_link",
    title: "Document holder link",
    text: "A party that already holds a loan document can rebuild its request, match it to a loan, a fund and a verdict, and recover the claimed amount by search. The document stays private from everyone who does not already hold it.",
    whitepaper: "8.4 item 1",
  },
  {
    id: "singleton_aggregates",
    title: "Singleton aggregates",
    text: "Registry certificates publish exact fund totals, so a fund holding one loan, or very few, reveals that loan's figures. The v3 receipt rounds and bands the values for this reason, but a singleton still narrows what an observer knows.",
    whitepaper: "8.4 item 3",
  },
  {
    id: "v2_receipt_granularity",
    title: "v2 receipt cash granularity",
    text: "The v2 receipt format publishes aggregate cash metrics, including cohort balances and exact ratios, with cohorts under five units suppressed. In small books two such aggregates can solve for hidden balances. The v3 format was designed to close this and is not deployed.",
    whitepaper: "12.1",
  },
  {
    id: "metadata",
    title: "Metadata",
    text: "Token counts in signed verdicts indicate document length. Pledge, verdict, attempt and receipt times, each loan's asset type, the number of pledges per fund and the timing of corrections are public.",
    whitepaper: "8.4 item 5",
  },
  {
    id: "operators_see_inputs",
    title: "Operators see inputs",
    text: "The party that requests a fingerprint sees the reference it submits, and the operator that runs the engine today sees the payload it scores. Hardware isolation protects inputs from the host only if the stated enclave assumption holds.",
    whitepaper: "8.4 item 6",
  },
  {
    id: "history_stays_public",
    title: "History stays public",
    text: "Anything already published on chain, including receipts in an earlier format, stays public. A later design cannot hide it again.",
    whitepaper: "8.4 item 7",
  },
];
