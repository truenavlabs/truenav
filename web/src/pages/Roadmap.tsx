import { PageHead, Panel } from "../shell/kit";

const ITEMS: [string, string, string][] = [
  ["Correlated defaults", "Replace the independent-default TrueRange with a one-factor Monte Carlo run in the TEE with a published seed.", "spec/nav/NAV_SPEC.md section 7"],
  ["Paid reports on chain", "Deploy the receipts and query contracts so an agent can buy a one-use report entitlement for 0.01 testnet NEAR. Built and tested; not deployed.", "receipts/README.md"],
  ["Receipts mirrored to Base", "Chain Signatures sign the public score fields to an EVM contract that accepts only the MPC signer and a rising sequence.", "mirror/README.md"],
  ["Manager-signed NAV", "Let a fund account publish its own reported NAV, so the engine scores the manager's own signed figure.", "contract/src/lib.rs has no NAV submit method today"],
  ["Certificates from a TEE key", "Today the certificate key is a test key held by TrueNav Labs.", "README, Roles and keys"],
  ["Pinned image measurements", "Compare MRTD, RTMR0 to RTMR2 and the compose hash with published expected values (N-06), and verify the NVIDIA token fully (N-05).", "README, Known limits"],
  ["Reproducible registry build", "A registry build that matches the on-chain code hash.", "SECURITY.md"],
  ["Liability oracle", "Independent source for fund liabilities.", "spec/nav/NAV_SPEC.md section 7"],
  ["Wallet sign-in", "NEP-413 message signing to show a fund manager their own fund, with no transactions.", "needs a wallet library, not added yet"],
];

export default function Roadmap() {
  return (
    <>
      <PageHead title="Roadmap" lead="Roadmap. None of this is live." />
      <Panel title="Next" pad={false}>
        {ITEMS.map(([h, t, s]) => (
          <div className="faqi" key={h}><strong>{h}.</strong> <span style={{ color: "#c3ccd8" }}>{t}</span><div className="dim small">Source: {s}</div></div>
        ))}
      </Panel>
    </>
  );
}
