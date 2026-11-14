// Built on NEAR: the tracks (privacy first, open second), the stack, why NEAR, and what NEAR does not do for us.
// Sources: README (What is real, How NEAR is used, Tracks), WHY_NEAR, the known limits, the contracts.
// NEAR Intents is not used, so it is not listed anywhere. Chain Signatures is built, not deployed.
import { PUBLIC_V3_FIELDS } from "../public";
import { DOCS_BASE, HACKATHON_URL } from "./content";
import { StackDiagram } from "./diagrams";
import { Band, Card, Chip, Cta, Figure, Grid, Hero, Note, Num, Pill, PillExt, Steps, Table, type Status } from "./kit";
import { SitePage } from "./Shell";

const S = (s: Status) => <Chip s={s} />;

export function BuiltOnNear() {
  return (
    <SitePage route="built-on-near">
      <Hero
        label="built on NEAR"
        title="The private part runs in NEAR's TEEs. The public part lives on NEAR."
        lead="A tokenized fund needs a record no fund controls, private computation whose result a contract can check, and a way for anyone to re-check it without our help. TrueNav is built from NEAR's parts, not around them."
        actions={<><Pill href="/evidence">See the evidence <span aria-hidden="true">→</span></Pill><PillExt href={`${DOCS_BASE}WHY_NEAR.md`} kind="ghost">The one-page note ↗</PillExt></>}
      />

      <Band tone="white" label="tracks" title="Two tracks, privacy first." lead={<>TrueNav was built for NEAR HACKATHON 2026 (<a className="ln" href={HACKATHON_URL} target="_blank" rel="noopener noreferrer">nearhackathon.com ↗</a>) and entered two tracks. Here is what each one asks and where TrueNav answers.</>}>
        <Grid cols={2}>
          <Card label="primary track" title="Privacy and Private AI" chip="live">
            <p><b>Private by design.</b> Loan documents and cashflow evidence are checked inside TEEs. Only signed verdicts, aggregates and private fingerprints go on chain.</p>
          </Card>
          <Card label="second track" title="Open Innovation" chip="live">
            <p><b>Something we haven't seen.</b> A public scorecard for private-credit NAVs that anyone can recompute, with a path to try it that needs no funds.</p>
          </Card>
        </Grid>

        <h3 className="mk-sub">Privacy and Private AI</h3>
        <Table
          head={["What a judge would test", "What answers it", "Where to see it", "Status"]}
          caption="Privacy track map"
          rows={[
            ["Is private proven, or only claimed?", "NEAR AI Cloud attestation with a fresh nonce, and the response signature checked against the attested key.", "Evidence", <>{S("live")} The command line check runs on the real report. The app's checker is simulated on fixtures.</>],
            ["What is revealed to whom?", `Verdict-only replies, loan ids made by an HMAC inside OutLayer, and a ${PUBLIC_V3_FIELDS.length} field public receipt.`, "Technology", S("live")],
            ["Is the trust model stated honestly?", "A published trust model, a threat model and a table of known limits.", "Privacy and security", S("live")],
            ["Does privacy enable something new?", "A fund proves checks on private loans without publishing them, and a contract acts on the result.", "Home", S("live")],
            ["Does the contract verify before it acts?", "The registry recovers the TEE's signature and checks the signer is registered before it stores a verdict.", "Technology", <>{S("live")} It checks the signature, not the hardware quote.</>],
            ["Is anything sensitive kept server side?", "The only state the API keeps on disk is a spend store of spent nonces and a rate counter.", "Privacy and security", S("live")],
            ["Is the data fictional?", "Demo funds and mock bank data only.", "The notice on every page", S("demo")],
          ]}
        />

        <h3 className="mk-sub">Open Innovation</h3>
        <Table
          head={["What a judge would test", "What answers it", "Where to see it", "Status"]}
          caption="Open track map"
          rows={[
            ["Is it new for NEAR?", "A scorecard anyone can recompute, fed by a TEE verdict that a contract checks.", "Home", <>{S("live")} Testnet.</>],
            ["Does it work?", "A replayable path that runs 10 of 10 stages offline, and a live chain read.", "Evidence", <>{S("live")} No funds needed.</>],
            ["Does NEAR make it possible, or much easier?", "First-party private inference with attestation, OutLayer runs a contract can call, access keys, NEP-171 tokens and sub-accounts, in one ecosystem.", "Below", <>{S("live")} An argument, not a benchmark.</>],
            ["Would someone use it next month?", "Allocators and administrators doing diligence on tokenized private credit.", "For investors, For managers", <>{S("limit")} Testnet only.</>],
          ]}
        />
        <p className="mk-p" style={{ marginTop: 14 }}>In our search we found no NEAR project that checks private loan documents in a TEE and also refuses a second fund's pledge of the same loan. That is a search result, not proof that none exists.</p>
      </Band>

      <Band tone="tint" label="the stack" title="How it works, end to end." lead="Six steps. The dashed line in the diagram is the privacy boundary.">
        <Figure wide caption="the end to end stack. Chips show what is live, and what is not">
          <StackDiagram />
        </Figure>
        <div style={{ marginTop: 32 }}>
          <Steps>
            <Num n={1} title="Documents stay private">A loan's on-chain id is an HMAC computed inside an OutLayer TEE with a key nobody holds, so a document id cannot be tested against it.</Num>
            <Num n={2} title="The fund pledges the loan">The registry mints a non-transferable NEP-171 token and refuses a second fund's pledge of the same loan.</Num>
            <Num n={3} title="A NEAR AI Cloud TEE reads the document">A model in an Intel TDX enclave with NVIDIA confidential computing compares the document with the fund's claim and returns a verdict-only reply, signed by a key that never leaves the enclave.</Num>
            <Num n={4} title="The registry checks and stores the verdict">It recovers the signer, checks it is a registered TEE signer, checks the contract, network and expiry binding, and stores the verdict.</Num>
            <Num n={5} title="A public engine computes the score">Open, deterministic code computes TrueVal, TrueRange and the score from verified loans and chain data. A signed certificate goes on the registry.</Num>
            <Num n={6} title="Anyone re-checks it">No key and no account: public chain reads, a command line check and the receipt checker.</Num>
          </Steps>
        </div>
        <p className="mk-p" style={{ marginTop: 18 }}>Cash evidence takes a second path. The receipts contract can request a pinned OutLayer run over private cashflow evidence and store a public checks receipt. That path is live as v2 and runs on mock bank data.</p>
      </Band>

      <Band tone="white" label="why NEAR" title="Each NEAR part, and what it buys a fund.">
        <Table
          head={["NEAR part", "What TrueNav uses it for", "Why it matters for a fund", "Status"]}
          caption="NEAR components"
          rows={[
            ["NEAR AI Cloud private inference", "A model reads each private loan document and signs a verdict-only reply. The attestation is fetched with a fresh nonce.", "The loans are the secret. Without private inference, checking a document means handing it to a third party.", S("live")],
            ["A signature a contract can check", "The registry recovers the signer and checks it is registered, bound to this contract and network, and unexpired.", "A private check becomes a public, checkable fact on a ledger no fund controls.", S("live")],
            ["The registry contract", "Stores verdicts and certificates. Refuses a second fund's pledge of the same loan. Makes no cross-contract call and sends no NEAR.", "Double pledging is the core trust failure in private credit. A neutral registry is the place to stop it.", S("live")],
            ["NEP-171 pledge tokens", "One standard token per pledged loan, minted on first pledge, burned on release, not transferable.", "Wallets and explorers can see who holds a pledge with no custom tooling.", S("live")],
            ["Access keys", "Admin, servicer and pledge calls attach exactly 1 yoctoNEAR, so only a full-access key can make them.", "Roles come from the chain's key model: a leaked function-call key cannot pledge or certify.", S("live")],
            ["OutLayer", "Computes the loan fingerprint with a key held only in the TEE, and runs the cash evidence checks with a callback to a contract.", "Private bank data is checked in a TEE and a public receipt lands on chain.", S("live-v2")],
            ["Pinned, reproducible builds", "The receipts and query contracts are built in a pinned image, so their code can be matched to source.", "Anyone can check that deployed code is the published code.", <>{S("live")} The query contract matches its pin. The registry is a host build.</>],
            ["Sub-accounts", "One account per fund under one parent: the registry, Harbor and Meridian.", "One fund, one account. A new deployment can be isolated in minutes.", S("live")],
            ["Chain Signatures", "A Base Sepolia mirror of the public score fields.", "Investors on other chains could read the same proof.", S("built")],
          ]}
        />
      </Band>

      <Band tone="tint" label="design argument" title="Why NEAR, rather than a generic chain." lead="A design argument, not a benchmark. We make no claim about gas cost, finality speed or mainnet readiness.">
        <Table
          head={["What a fund needs", "On a generic chain", "On NEAR, for TrueNav"]}
          caption="NEAR versus a generic chain"
          rows={[
            ["Private inference a contract can check", "You bring your own private compute and your own way to prove it ran. Checking a signature on chain is not special to any chain.", "A first-party service, NEAR AI Cloud, runs open models in TEEs and signs each response with a key that never leaves the enclave. The registry checks that signature. No custom enclave to build or trust."],
            ["Private compute a contract can call", "Off-chain workers or oracles you assemble yourself.", "OutLayer runs code in a TEE with an attestation per run, and calls back into the receipts contract."],
            ["Roles and standards", "Custom role contracts and custom token events.", "Access keys gate admin, servicer and pledge calls. NEP-171 tokens that wallets and explorers already read. Named sub-accounts per fund."],
            ["Verify it yourself", "Often an archive node or a paid indexer.", "Public RPC views, a command line check and a receipt checker. On testnet, a judge needs no account and no funds."],
          ]}
        />
        <Note label="what NEAR does not do for us">
          The contract does not check the TEE hardware quote. A TEE is not zero knowledge, and it proves which code ran, not that the model is right. The registry is a host build today, and receipts v3 and the Base mirror are not deployed. We use testnet only.
        </Note>
      </Band>

      <Cta label="next" title="Check the claims yourself.">
        <Pill href="/evidence" kind="inv">Evidence <span aria-hidden="true">→</span></Pill>
        <Pill href="/security" kind="ghost inv">Privacy and security</Pill>
      </Cta>
    </SitePage>
  );
}
