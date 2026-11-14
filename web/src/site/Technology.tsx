// Technology: long page. Every claim below restates README.md, ARCHITECTURE.md, TRUST_MODEL.md, THREAT_MODEL.md or
// SPEC_RECEIPT_V3.md. Numbers in CHECKS were confirmed by running the commands named next to them (see RUNS).
import { type ReactNode } from "react";
import { TOOLTIPS } from "../copy";
import { PUBLIC_V3_FIELDS } from "../public";
import { reports } from "../data";
import { A } from "../ui";
import { fund, HARBOR, MERIDIAN } from "./facts";
import { LongPage, type LongSection } from "./Long";
import { RevealDiagram } from "./diagrams";
import { Figure } from "./kit";
import { REPO, SitePage } from "./Shell";

// Recorded on 14 Nov 2026 (Asia/Bangkok): `npm run eval` re-run, and the size of `npm test` at the repo root.
const RUNS = { date: "14 Nov 2026" };
const CHECKS: { n: string; of?: string; label: string; cmd: string }[] = [
  { n: "0", of: "800+", label: "tests fail in the full suite (a few skip without Rust or Python jsonschema)", cmd: "npm test" },
  { n: "86", of: "86", label: "signed TEE replies verified against the attested key", cmd: "npm run eval" },
  { n: "46", of: "46", label: "tampered loan documents flagged", cmd: "npm run eval" },
  { n: "0", of: "40", label: "honest documents flagged", cmd: "npm run eval" },
  { n: "20", of: "20", label: "tampered flagged in the frozen hold-out set", cmd: "npm run eval" },
];

const Facts = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="lp-facts mono">
    {rows.map(([k, v]) => (
      <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
    ))}
  </dl>
);

export function Technology() {
  const h = fund(HARBOR), m = fund(MERIDIAN);
  const contract = reports[0].receipt.receipts_contract;
  const sections: LongSection[] = [
    {
      id: "tee", layer: "private data", title: "Private data stays inside the TEE.",
      body: (
        <>
          <p>Each pledged loan's document is read by a model running inside a NEAR AI Cloud TEE (Intel TDX with NVIDIA confidential computing). It compares the document with the loan data the fund claims.</p>
          <p>The reply may hold fixed keys only: the loan hash, a binding, six check results, a line number for duplicate evidence, the verdict and anomaly codes. The TEE signs that reply. The document never goes on chain.</p>
          <p>A loan's on-chain fingerprint is an HMAC computed inside a TEE with a key nobody holds, so a document id cannot be tested against it.</p>
          <Facts rows={[["re-check the TEE", "npm run verify:attestation"], ["re-check fingerprints", "npm run verify:fingerprints"]]} />
        </>
      ),
    },
    {
      id: "model", layer: "credit model", title: "The credit model values each loan.",
      body: (
        <>
          <p>The score engine is public and deterministic, so anyone can recompute every number from the same inputs. It reads the TEE verdicts and pledges and values verified loans only.</p>
          <ul className="lp-list">
            <li><b>TrueVal</b>: {TOOLTIPS.trueVal}</li>
            <li><b>TrueRange</b>: {TOOLTIPS.trueRange}</li>
            <li><b>TrueNav score</b>: {TOOLTIPS.score} 40 points for coverage, 40 for the NAV gap, 20 for freshness.</li>
          </ul>
          <p className="lp-note">PD tables are demo, not calibrated. TrueVal is a model estimate, not fair value.</p>
          <Facts rows={[[h.name, `${h.score} ${h.band}, reported ${h.reported}, TrueVal ${h.trueval}`], [m.name, `${m.score} ${m.band}, reported ${m.reported}, TrueVal ${m.trueval}`]]} />
        </>
      ),
    },
    {
      id: "receipt", layer: "receipt on NEAR", title: "A receipt lands on NEAR testnet.",
      body: (
        <>
          <p>The registry contract on NEAR testnet stores each signed score certificate after checking its signer, and refuses a second pledge of the same loan fingerprint by another fund.</p>
          <p>The receipt format puts the network and contract into every hash: one combined receipt per fund per period, canonical JSON (RFC 8785) hashed with sha256. A correction appends a new sequence and the old entry stays as it was. The public view keeps {PUBLIC_V3_FIELDS.length} allowlisted fields.</p>
          <p className="lp-note">The receipts on this site are committed testnet fixtures marked synthetic, not read live from the chain.</p>
          <Facts rows={[
            ["registry", "registry.tnlab-368aa2.testnet"],
            ["code hash", "9Ki2kuenoxie3doBRYbdTPSmzTjwsTosQmUaGwQKCw7o"],
            ["TEE verdicts", "16 honest verdicts on chain, signed by the attested key"],
            ["double-pledge refusal", <a href="https://explorer.testnet.near.org/transactions/8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs" target="_blank" rel="noopener noreferrer">8VK1kUkpa7Gs8dStznffdDAM9uHVbfodHWBUvbfQMwrs</a>],
            ["receipt contract", contract],
            ["method", h.method],
          ]} />
        </>
      ),
    },
    {
      id: "verify", layer: "anyone verifies", title: "Anyone verifies it.",
      body: (
        <>
          <p>No account and no key are needed. <code>npm run chain:read</code> reads the live registry and recomputes both scores from chain data only. <code>npm run verify:attestation</code> re-checks the published TEE attestation on the earlier instance that still holds the recorded TEE set. The current live registry wasm is a local host (non-reproducible) build; its on-chain code hash is listed under the receipt. A pinned-image / NEP-330 rebuild is not claimed for this deploy.</p>
          <p>The receipt checker in the app walks a receipt through signature, attestation, fund binding and freshness. In this build those checks are simulated on the fixtures, with no network.</p>
          <Facts rows={[["chain read", "npm run chain:read"], ["deployed code", <A href="/evidence">see the evidence page</A>], ["in the app", <A href="/verify">the receipt checker</A>]]} />
        </>
      ),
    },
  ];
  return (
    <SitePage route="technology" tone="dark" className="long">
      <LongPage
        hero={
          <div className="lp-hero-in">
            <span className="lbl">technology</span>
            <h1>The loans stay private. The proof is public.</h1>
            <p>Four layers take a fund's private loan file to a receipt anyone can check: a TEE, a public credit model, a contract on NEAR testnet and a verifier that needs no key.</p>
            <ol className="lp-jump mono" aria-label="Sections">
              {sections.map((s, i) => <li key={s.id}><a href={`#${s.id}`}>{String(i + 1).padStart(2, "0")} {s.layer}</a></li>)}
            </ol>
          </div>
        }
        sections={sections}
        after={
          <>
            <section className="lp-checks" aria-labelledby="checks-h">
              <div className="lp-checks-hd">
                <span className="lbl">checks you can run</span>
                <h2 id="checks-h">Numbers from the repo, not from a slide.</h2>
                <p>Run on {RUNS.date} from a local checkout. The eval is synthetic documents, one model, one run each: a perfect score means no failure was found in these documents, not that the TEE model cannot fail.</p>
              </div>
              <div className="lp-checks-g">
                {CHECKS.map((c) => (
                  <div key={c.label} className="ck">
                    <div className="v mono">{c.n}{c.of ? <small> of {c.of}</small> : null}</div>
                    <div className="l">{c.label}</div>
                    <code className="c">{c.cmd}</code>
                  </div>
                ))}
              </div>
              <div className="lp-not">
                <span className="lbl">not claimed</span>
                <p>Not zero knowledge. Not fair value. The score certificate signer is a test key, not a TEE key. The chain does not verify hardware itself; anyone can re-check the attestation off chain.</p>
              </div>
            </section>
            <section className="mk-band white">
              <div className="mk-in">
                <header className="mk-head">
                  <span className="lbl">who sees what</span>
                  <h2>What is revealed to whom.</h2>
                  <p className="mk-lead">Five hops, with the privacy boundary after the TEE. The reply is public once it is sent, and it holds a verdict only.</p>
                </header>
                <Figure caption="what is revealed to whom, hop by hop"><RevealDiagram /></Figure>
              </div>
            </section>
            <section className="cta-band">
              <div>
                <span className="lbl">verify</span>
                <h2>Check a receipt yourself.</h2>
              </div>
              <div className="cta-a">
                <A href="/verify" className="pillbtn inv">Open the verifier <span aria-hidden="true">→</span></A>
                <a href={REPO} className="pillbtn ghost inv" target="_blank" rel="noopener noreferrer">Read the source ↗</a>
              </div>
            </section>
          </>
        }
      />
    </SitePage>
  );
}
