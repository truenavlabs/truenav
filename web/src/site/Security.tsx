// Privacy and security: what is real, what is public and private, what the TEE and the contract check, and the honest
// limits. Restates the trust model, the threat model, the security policy and the known limits. Nothing here is a claim
// the code does not back.
import { A } from "../ui";
import { Band, Card, Chip, Cta, Grid, Hero, Note, Pill, Table, type Status } from "./kit";
import { SitePage } from "./Shell";

const S = (s: Status) => <Chip s={s} />;

export function Security() {
  return (
    <SitePage route="security">
      <Hero
        label="privacy and security"
        title="Private where it matters. Honest where it is not."
        lead="TrueNav keeps loan documents inside TEEs and publishes only verdicts, scores and fingerprints. This page says what that protects, who could still see what, and what we do not claim."
        actions={<><Pill href="/trust">Trust page in the demo app <span aria-hidden="true">→</span></Pill><Pill href="/evidence" kind="ghost">Evidence</Pill></>}
      />

      <Band id="real" tone="white" label="what is real" title="Real, and simulated." lead="Checked against the code and the live testnet accounts on 14 Nov 2026.">
        <Table
          head={["Component", "Status", "What that means"]}
          caption="What is real versus simulated"
          rows={[
            ["Registry contract", S("live"), "On NEAR testnet. A host build, not a reproducible build. 16 honest TEE verdicts are on chain."],
            ["NEAR AI Cloud underwriter", S("live"), "A real TEE signed the live verdicts. The offline demo replays recorded, TEE-signed replies and does not call the TEE."],
            ["OutLayer engine", S("live-v2"), "Live on testnet as v2. Receipts v3 and the v3 engine are pinned, not deployed."],
            ["Receipts contract", S("live-v2"), "Live as v2. No receipt is stored on it yet."],
            ["Query contract", S("live"), "Live, and it matches its pinned build."],
            ["Public score engine", S("live"), "Real code, deterministic. The default tables are demo, not calibrated."],
            ["Funds, loans, documents, bank data", S("demo"), "Simulated and fictional. The mock bank serves synthetic data only."],
            ["Base Sepolia mirror", S("built"), "Implemented and tested. Not deployed."],
          ]}
        />
      </Band>

      <Band tone="tint" label="public and private" title="What is public, and what stays private.">
        <Table
          head={["Public, on chain or in a receipt", "Private"]}
          caption="Public versus private"
          rows={[
            ["Loan fingerprint (an HMAC), pledge holder, asset type", "Loan document text"],
            ["Verdict and anomaly codes, request and response hashes", "Borrower details"],
            ["Certificates with fund totals, and timestamps", "Cash evidence documents"],
            ["Blocked attempts and alerts, stored under the fund that tried", "The key that makes loan fingerprints"],
          ]}
        />
        <p className="mk-p" style={{ marginTop: 14 }}><A href="/trust#t-privacy-boundary" className="ln">Who can see what, party by party, on the trust page →</A></p>
        <Note label="what it still reveals">
          A fund's totals are public, so a fund that holds one loan reveals that loan's value. The request hash in a verdict is not salted: someone who already holds a loan document can rebuild the request, try amounts until the hash matches, and link the document to its loan and fund. The signed reply also carries token counts, which show a document's length. A refused pledge says only that the loan is pledged elsewhere and does not name the other fund.
        </Note>
      </Band>

      <Band tone="white" label="the TEE" title="What the TEE proves, and what it does not.">
        <div className="mk-two">
          <div>
            <h3 className="mk-sub">Checked</h3>
            <ul className="mk-list">
              <li>The attestation report is published, and its hash is stored on chain with the signer.</li>
              <li>Anyone can re-check the TDX quote and status, that debug mode is off, the key and nonce binding, and the NVIDIA verdict.</li>
              <li>The registry recovers the reply's signer and checks it is a registered TEE signer, bound to this contract and network, and unexpired.</li>
              <li>The contract limits the reply's size and keys before it checks the signature.</li>
            </ul>
          </div>
          <div>
            <h3 className="mk-sub">Not checked, or not proven</h3>
            <ul className="mk-list">
              <li>The contract does not verify the hardware quote. The registrar registers the signer after an off-chain check anyone can repeat.</li>
              <li>A TEE proves which code ran, not that the model is right. The underwriter is a language model.</li>
              <li>Image measurements are not compared with published expected values, and the NVIDIA token signature is not verified.</li>
              <li>The TLS certificate is not compared with the live connection.</li>
            </ul>
          </div>
        </div>
      </Band>

      <Band id="limits" tone="tint" label="known limits" title="What we have not solved." lead="All open items are low or informational, and none changes the offline demo path.">
        <Table
          head={["Item", "What is true today", "Status"]}
          caption="Known limits"
          rows={[
            ["Roles and keys", "The certificate signer and the pledge key are the same test address. Role separation by prefix stops a bypass, but it is role concentration.", "Open"],
            ["Upgrade authority", "One full-access key on the registry account can replace the contract code. No multisig.", "Disclosed"],
            ["TEE signer age", "A registered TEE signer has no expiry on chain. The registrar removes one by hand.", "Open"],
            ["Expired verdicts", "The chain still returns the latest verdict after it expires. Clients treat it as expired, not as a pass.", "Handled by clients"],
            ["Reproducible build", "The registry is a host build. The receipts and query contracts are pinned builds.", "Open"],
            ["Evaluation", "126 synthetic documents in a few templates, written by the team that wrote the prompt. A perfect score means no failure was found, not that the model cannot fail.", "Disclosed"],
            ["Registry storage", "A 1 testnet NEAR top-up on 14 Nov 2026 left about 100 KB of headroom for new writes.", "Resolved"],
          ]}
        />
      </Band>

      <Band tone="white" label="not claimed" title="What TrueNav does not claim.">
        <Grid cols={3}>
          <Card title="Not zero knowledge"><p>Privacy rests on TEEs and their attestation, not on cryptographic proofs.</p></Card>
          <Card title="Not fair value"><p>TrueVal is a model estimate on demo tables.</p></Card>
          <Card title="Not a rating or advice"><p>TrueNav informs only. It never moves or blocks money, and a red score is information.</p></Card>
        </Grid>
      </Band>

      <Band tone="tint" label="this site" title="No cookies, no analytics, no transactions.">
        <p className="mk-p">The demo reads committed fixtures and public NEAR testnet views. Nothing on this site sends a transaction, and simulations are labeled and run in your browser. Do not use it with real funds or real loan documents.</p>
        <p className="mk-p"><b>Report a vulnerability:</b> open a private security advisory on the repository (GitHub, Security tab). Please do not open a public issue for it.</p>
      </Band>

      <Cta label="next" title="Read the evidence.">
        <Pill href="/evidence" kind="inv">Evidence <span aria-hidden="true">→</span></Pill>
        <Pill href="/docs" kind="ghost inv">Docs</Pill>
      </Cta>
    </SitePage>
  );
}
