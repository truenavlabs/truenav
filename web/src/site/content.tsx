// Copy shared by more than one page. Every line restates the README, WHY_NEAR, the known limits or the contracts.
// Status words: live (real on NEAR testnet), built (not deployed), pinned (not deployed), planned (not live).
import { type Status } from "./kit";

export const REGISTRY = "registry.tnlab-368aa2.testnet";
export const CODE_HASH = "9Ki2kuenoxie3doBRYbdTPSmzTjwsTosQmUaGwQKCw7o";
export const HACKATHON_URL = "https://nearhackathon.com";
export const TENDAI = "https://tendaicustody.app";
export const EXPLORER_TX = "https://explorer.testnet.near.org/transactions/";
export const NEARBLOCKS_ADDR = "https://testnet.nearblocks.io/address/";
export const NEARBLOCKS_TX = "https://testnet.nearblocks.io/txns/";
export const DOCS_BASE = "https://github.com/truenavlabs/truenav/blob/main/";

export const SHOTS = {
  overview: { src: "/shots/overview.png", alt: "The TrueNav demo app overview with the demo funds scored", w: 1440, h: 900 },
  harbor: { src: "/shots/fund-harbor.png", alt: "Harbor Credit Fund in the demo app: score 99, green, reported NAV inside the TrueRange", w: 1440, h: 900 },
  meridian: { src: "/shots/fund-meridian.png", alt: "Meridian Yield Fund in the demo app: score 43, red, reported NAV outside the TrueRange", w: 1440, h: 900 },
  verify: { src: "/shots/verify-tamper.png", alt: "The receipt checker in the demo app with a tampered reply, failing rows shown in red", w: 1440, h: 900 },
} as const;

export type NearCard = { n: number; title: string; body: string; chip: Status };
export const NEAR_CARDS: NearCard[] = [
  { n: 1, title: "Private inference", body: "Loan documents are read by a model inside a NEAR AI Cloud TEE. Only a signed verdict leaves it.", chip: "live" },
  { n: 2, title: "A signature a contract can check", body: "The registry recovers the TEE's signature before it stores anything.", chip: "live" },
  { n: 3, title: "One loan, one fund", body: "A second pledge of the same loan is refused on chain. Each pledge is a standard NEP-171 token that cannot be transferred.", chip: "live" },
  { n: 4, title: "Keys that mean something", body: "Admin, servicer and pledge calls need a full-access key, so a leaked function-call key cannot act.", chip: "live" },
  { n: 5, title: "Private compute with a callback", body: "OutLayer computes loan fingerprints and cash evidence checks in a TEE and reports back to a contract. Receipts v3 is pinned, not deployed.", chip: "live-v2" },
  { n: 6, title: "Proof on other chains", body: "A Base mirror through Chain Signatures is built and tested. It is not deployed, and no receipt is mirrored today.", chip: "built" },
];

export const ROADMAP: { horizon: "Next" | "Later"; title: string; body: string; status: Status; note?: string }[] = [
  { horizon: "Next", title: "Correlated defaults", body: "Replace the independent-default TrueRange with a one-factor Monte Carlo run in the TEE, with a published seed.", status: "planned" },
  { horizon: "Next", title: "Receipts v3 and paid reports on chain", body: "The query contract is live on its pinned build. The receipts contract is live as v2. The v3 receipts build is pinned and not deployed. A live agent purchase against these contracts is still outstanding.", status: "pinned" },
  { horizon: "Next", title: "Receipts mirrored to Base", body: "Chain Signatures sign the public score fields to an EVM contract that accepts only the MPC signer and a rising sequence. Built and tested, not deployed.", status: "built" },
  { horizon: "Next", title: "Manager-signed NAV", body: "Let a fund account publish its own reported NAV, so the engine scores the manager's own signed figure.", status: "planned" },
  { horizon: "Next", title: "Certificates from a TEE key", body: "Today the certificate key is a test key held by TrueNav Labs. The engine is public, so anyone can recompute the numbers.", status: "planned" },
  { horizon: "Next", title: "Pinned image measurements", body: "Compare the TEE image measurements with published expected values, and verify the NVIDIA token fully.", status: "planned" },
  { horizon: "Next", title: "Reproducible registry build", body: "A registry build that matches the on-chain code hash. The live registry is a host build today.", status: "planned" },
  { horizon: "Later", title: "Liability oracle", body: "An independent source for a fund's liabilities.", status: "planned" },
  { horizon: "Later", title: "Wallet sign-in for managers", body: "NEP-413 message signing so a fund manager can see their own fund, with no transactions. The wallet library is in the app. The manager view is not wired.", status: "planned" },
  { horizon: "Later", title: "Pilots on a fund's own data", body: "An invitation, not a status: no pilot is running. Everything here is testnet with fictional funds.", status: "planned" },
];
