import { A } from "../ui";
import { PageHead, Panel } from "../shell/kit";
import { AttestationEvidence, EvidenceLedger, PrivacyBoundary } from "./trust/PrivacyProof";

const CLAIMS: [string, string][] = [
  ["Refused pledges", "A pledge for a loan another fund holds is refused and stores one blocked attempt and one alert against the fund that tried. They are public and do not name the other fund."],
  ["Reply checks", "The contract checks the reply body's keys and value types, the signature, the signer, the model, the loan hash echo, the binding and the expiry. It does not check the outer reply fields (id, created, model, usage, finish_reason, logprobs); our client and CI do."],
  ["Amounts", "The chain never stores a document or a borrower. A fund's totals are public, so a fund holding one loan reveals that loan's value. Someone who already holds a loan document can recompute its request hash and recover the amount and the link from document to loan to fund."],
  ["What a pass proves", "A signed pass proves the attested model replied. It does not prove which prompt the servicer sent."],
  ["Verdict expiry", "Verdict expiry is set by the servicer when submitting, up to 30 days. The enclave run time is not read."],
  ["Removed signers", "Removing a signer does not invalidate verdicts it already signed."],
  ["Certificate key", "The certificate key is a test key held by TrueNav Labs, not a TEE key. The engine is public, so anyone can recompute the numbers."],
  ["Contract build", "The deployed contract is not reproducibly built from source yet."],
  ["Hardware quote", "The contract does not verify the TEE hardware quote. The registrar registers the TEE signer after an off-chain attestation check anyone can repeat with npm run verify:attestation."],
  ["Informs only", "A red score is information. It does not block a subscription, a redemption, or any other transfer. The registry makes no cross-contract call and sends no NEAR."],
];

const LIMITS: [string, string, string][] = [
  ["TLS binding", "A report's TLS certificate fingerprint is checked inside the report data, not against the live HTTPS connection to NEAR AI Cloud.", "Not checked"],
  ["Image measurement pins (N-06)", "MRTD, RTMR0 to RTMR2 and the compose hash are not compared with published expected values; container image provenance is not checked.", "Open, Low"],
  ["NVIDIA GPU token (N-05)", "The overall result is read; the token's signature, issuer, expiry, nonce claim and per-GPU tokens are not verified.", "Open, Low"],
  ["Shared signer and pledge key (N-07)", "The certificate signer and the servicer pledge key are the same test address. Domain prefixes stop a signature for one being used as the other: role concentration, not a bypass.", "Open, Low"],
  ["TEE signer age", "A registered TEE signer has no expiry on chain; the registrar removes one by hand.", "Open"],
  ["Upgrade authority", "One full-access key on the registry account can replace the contract code. No multisig.", "Disclosed"],
  ["Storage headroom (N-01)", "The registry had 628 bytes of storage headroom. A 1 testnet NEAR top-up on 14 Nov 2026 (transaction 7wjnse7nQxVyZLn29RRH4nxQmVGCNfWDBkucnSwC5Eka) raised the balance to 4.9969 NEAR, which leaves about 100 KB of headroom for new writes.", "Resolved"],
];

export default function Trust() {
  return (
    <>
      <PageHead title="Trust and privacy" lead="What TrueNav proves, what it does not, and what is public. Wording follows the repository's TRUST_MODEL.md, README and SECURITY.md." />
      <Panel title="What is true today" pad={false}>
        {CLAIMS.map(([h, t]) => (
          <div className="faqi" key={h}><strong>{h}.</strong> <span style={{ color: "#c3ccd8" }}>{t}</span></div>
        ))}
      </Panel>
      <Panel className="mt" title="Known limits" sub="Open items from the README's known limits table, all Low or Info. None changes the offline judge path." pad={false}>
        <div className="tscroll">
          <table className="dt"><thead><tr><th>Item</th><th>What is true today</th><th>Status</th></tr></thead>
            <tbody>{LIMITS.map(([a, b, c]) => <tr key={a}><td>{a}</td><td style={{ whiteSpace: "normal" }}>{b}</td><td>{c}</td></tr>)}</tbody></table>
        </div>
      </Panel>
      <PrivacyBoundary />
      <AttestationEvidence />
      <EvidenceLedger />
      <Panel className="mt" title="This site">
        <div className="prose">
          <ul>
            <li>Testnet demo. Funds, loans and documents are fictional. Do not use it with real funds or real loan documents.</li>
            <li>No cookies, no analytics, no chat widget. The site reads public NEAR testnet views and the market data providers listed on <A href="/status">Data status</A>.</li>
            <li>Nothing on this site sends a transaction. Simulations are labeled and run only in your browser.</li>
          </ul>
        </div>
      </Panel>
    </>
  );
}
