// Evidence: real testnet transactions and the commands that re-run each check. Every transaction, hash and block is
// from the README and the deployment evidence notes, as recorded on 14 Nov 2026. Times are UTC as the explorer shows them.
import evidence from "../../data/recorded/attestation-evidence.json";
import registryRead from "../../data/recorded/registry-368aa2.json";
import { lastVerifiedLine, type AttestationEvidence } from "../content/attestation-evidence";
import { A } from "../ui";
import { CODE_HASH, EXPLORER_TX, NEARBLOCKS_ADDR, NEARBLOCKS_TX, REGISTRY, SHOTS } from "./content";
import { Band, Code, Cta, Ext, Facts, Hero, Pill, Shot, Table } from "./kit";
import { SitePage } from "./Shell";

const TXS: { when: string; what: string; hash: string; block: string; base: string }[] = [
  { when: "11 Nov 2026, 15:39:52 UTC", what: "Live registry deployed and initialised", hash: "Hx1Gcbcoq3F7W5DDUYtgLoEsyKVPeVcn7vZ19Hy4BkXE", block: "277235101", base: EXPLORER_TX },
  { when: "11 Nov 2026, 15:41:36 UTC", what: "A public test-key certificate refused: signer not registered", hash: "Gbu7tKHuE2WVfSMduS1MNyuMRf6TQSQyou2gr9ozXrnQ", block: "277235275", base: EXPLORER_TX },
  { when: "11 Nov 2026, 15:41:40 UTC", what: "A second pledge of an already pledged loan refused: already pledged elsewhere", hash: "8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs", block: "277235283", base: EXPLORER_TX },
  { when: "11 Nov 2026, 19:21:11 UTC", what: "TEE signer registered", hash: "9pWmjgBKN37VzMVBUo8vw3ygJ3PsPtnhp5D7wczaktvE", block: "277257550", base: EXPLORER_TX },
  { when: "14 Nov 2026, 10:28:50 UTC", what: "Query contract redeployed to its pinned build", hash: "2UjogapG3eALhSTjq6GXiaymrqGBvBVX8ZrFbvGjhnq8", block: "277644641", base: NEARBLOCKS_TX },
];

const EV = evidence as unknown as AttestationEvidence;
const readAt = new Date(registryRead.readAt).toISOString().replace("T", ", ").slice(0, 17) + " UTC";

export function Evidence() {
  return (
    <SitePage route="evidence">
      <Hero
        label="evidence"
        title="Do not take our word for it."
        lead="Every claim on this site can be re-run. Public transactions on NEAR testnet, and commands that need no key, no account and no funds."
        actions={<><Pill href="/verify">Open the receipt checker <span aria-hidden="true">→</span></Pill><Pill href="/trust" kind="ghost">Trust page</Pill></>}
      >
        <p className="mk-meta mono">Recorded 14 Nov 2026 · NEAR testnet · fictional funds</p>
      </Hero>

      <Band tone="white" label="the registry" title="One live registry on NEAR testnet.">
        <Facts rows={[
          ["registry", <Ext href={`${NEARBLOCKS_ADDR}${REGISTRY}`}>{REGISTRY}</Ext>],
          ["code hash", CODE_HASH],
          ["build", "a host build, not a pinned reproducible build"],
          ["TEE verdicts", "16 honest verdicts on chain, signed by the attested key"],
          ["recorded read", `block ${registryRead.block.height}, ${readAt}. A recorded copy, not live data. The command line check below reads the chain live.`],
          ["a refused double pledge", <Ext href={`${EXPLORER_TX}8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs`}>8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs</Ext>],
        ]} />
        <h3 className="mk-sub" style={{ marginTop: 32 }}>Transactions</h3>
        <Table
          head={["When", "What happened", "Transaction", "Block"]}
          caption="Testnet transactions"
          rows={TXS.map((t) => [t.when, t.what, <Ext key={t.hash} href={`${t.base}${t.hash}`}>{t.hash.slice(0, 10)}…</Ext>, t.block])}
        />
      </Band>

      <Band tone="tint" label="re-run the checks" title="Five commands, with what you should see." lead="From a fresh clone of the repository. Needs Node 22.22.2 or later on Linux or WSL. No keys, no NEAR account, no funds.">
        <Code>{`npm ci --ignore-scripts
npm run judge -- --replay
npm run demo
npm run chain:read
npm run verify:attestation
npm run verify:fingerprints`}</Code>
        <Table
          head={["Command", "You should see"]}
          caption="Expected output"
          rows={[
            [<code key="a">npm run judge -- --replay</code>, "judge: 10 of 10 stages PASS, 0 skipped not verified, ok true. About 13 seconds, offline."],
            [<code key="b">npm run demo</code>, "The recorded, TEE-signed trap case: Harbor 99.17 green, then 51.59 red after one altered document is flagged. It does not call the TEE."],
            [<code key="c">npm run chain:read</code>, "Harbor: TrueNav score 99 green (raw 99.17). Meridian: 43 red (raw 42.84). Each followed by: matches the recomputed score."],
            [<code key="d">npm run verify:attestation</code>, "Attestation checks passed: the report hash is on chain, the TDX quote and TCB status verify, debug is off. It also states what it does not prove."],
            [<code key="e">npm run verify:fingerprints</code>, "The recorded demo loan fingerprints are checked against Intel collateral."],
          ]}
        />
        <p className="mk-p" style={{ marginTop: 14 }}>The eval is a sixth check: <code>npm run eval</code> verifies 86 of 86 signed replies against the attested key, and 40 of 40 on the frozen hold-out set, with no honest document flagged. It is 126 synthetic documents: a perfect score means no failure was found, not that the model cannot fail.</p>
      </Band>

      <Band tone="white" label="the attestation check" title="Recorded, with what it proves and what it does not." lead={lastVerifiedLine(EV)}>
        <Facts rows={[
          ["evidence hash", EV.evidence_hash],
          ["OutLayer loans checked", `${EV.outlayer.loans_checked}, ${EV.outlayer.distinct_quotes} distinct Intel TDX quotes`],
          ["NEAR AI Cloud report hash", EV.near_ai.report_sha256],
          ["recorded verdicts signed", `${EV.near_ai.verdicts_signed}, by the attested key`],
        ]} />
        <div className="mk-two" style={{ marginTop: 28 }}>
          <div>
            <h3 className="mk-sub">It proves</h3>
            <ul className="mk-list">{EV.proves.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
          <div>
            <h3 className="mk-sub">It does not prove</h3>
            <ul className="mk-list">{EV.not_proves.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        </div>
        <p className="mk-p"><A href="/trust" className="ln">The same record on the trust page, with the privacy boundary →</A></p>
      </Band>

      <Band tone="tint" label="the tamper test" title="Change one byte, watch the rows turn red.">
        <div className="mk-two">
          <Shot {...SHOTS.verify} caption="receipt checker with a tampered reply, demo data" />
          <div>
            <p className="mk-p">The receipt checker in the demo app walks a receipt through signature, attestation, fund binding and freshness. Tamper with the reply and the matching rows fail.</p>
            <p className="mk-p">In the app those checks are simulated on committed fixtures, with no network. The commands above run on the real attestation report and chain data.</p>
            <p className="mk-p"><A href="/verify?tamper=reply" className="ln">Open the tampered example →</A></p>
            <p className="mk-p"><A href="/verify" className="ln">Open the receipt checker →</A> · <A href="/trust" className="ln">Trust and privacy →</A></p>
          </div>
        </div>
      </Band>

      <Cta label="next" title="Read how it is built.">
        <Pill href="/technology" kind="inv">Technology <span aria-hidden="true">→</span></Pill>
        <Pill href="/docs" kind="ghost inv">Docs</Pill>
      </Cta>
    </SitePage>
  );
}
