// Docs hub: the whitepaper and the public docs. Open, no gate. Links to the public repository use plain titles.
import { A } from "../ui";
import { DOCS_BASE } from "./content";
import { Band, Cta, Ext, Hero, Pill, PillExt } from "./kit";
import { REPO, SitePage, WHITEPAPER_PDF } from "./Shell";

const DOCS: { t: string; d: string; f: string }[] = [
  { t: "Try it", d: "Every run step with the output you should see. No keys, no account, no funds.", f: "docs/TRY_IT.md" },
  { t: "Architecture", d: "Diagrams, and where each part lives.", f: "ARCHITECTURE.md" },
  { t: "Trust model", d: "What is proven on chain, what is trusted, what is private, and what is not claimed.", f: "TRUST_MODEL.md" },
  { t: "Threat model", d: "Attacks, mitigations and the test that shows each.", f: "THREAT_MODEL.md" },
  { t: "Known limits", d: "Roles and keys, security notes and the open items.", f: "docs/KNOWN_LIMITS.md" },
  { t: "Deployment evidence", d: "The live testnet accounts, their pins, and whether the live code matches.", f: "docs/DEPLOYMENT_EVIDENCE.md" },
  { t: "Why NEAR", d: "What NEAR enables here, in one page.", f: "WHY_NEAR.md" },
  { t: "Network", d: "Testnet only, and what mainnet would change.", f: "docs/NETWORK.md" },
  { t: "Claims", d: "Each claim, and the command or test that checks it.", f: "docs/CLAIMS.md" },
  { t: "Security policy", d: "How to report a problem, and the practices in the repository.", f: "SECURITY.md" },
];

export function Docs() {
  return (
    <SitePage route="docs">
      <Hero
        label="docs"
        title="Everything is public. Nothing is gated."
        lead="The design paper, the method, the trust model and the code. Read them without an account."
        actions={<><a href={WHITEPAPER_PDF} className="pillbtn" target="_blank" rel="noopener noreferrer">Read the whitepaper <span aria-hidden="true">→</span></a><PillExt href={REPO} kind="ghost">Source code ↗</PillExt></>}
      />

      <Band tone="white" label="whitepaper" title="The design paper.">
        <div className="mk-wp">
          <img src="/whitepaper-cover.png" alt="First page of the TrueNav whitepaper" width={160} height={226} loading="lazy" decoding="async" />
          <div>
            <p className="mk-p">TrueNav: private verification for tokenized credit on NEAR. It reads as a design paper: the problem, the design, the score, the contracts, the threat model and the limits. 29 pages, PDF.</p>
            <p className="mk-p"><a href={WHITEPAPER_PDF} className="ln" target="_blank" rel="noopener noreferrer">Download the whitepaper (PDF) ↗</a> · <Ext href={`${DOCS_BASE}docs/WHITEPAPER.md`}>Read it as text</Ext></p>
          </div>
        </div>
      </Band>

      <Band tone="tint" label="public docs" title="The rest of the record.">
        <div className="mk-doclist">
          {DOCS.map((d) => (
            <a key={d.t} href={`${DOCS_BASE}${d.f}`} target="_blank" rel="noopener noreferrer">
              <b>{d.t} ↗</b><span>{d.d}</span>
            </a>
          ))}
        </div>
      </Band>

      <Band tone="white" label="in the demo app" title="Learn by clicking.">
        <div className="mk-doclist">
          <A href="/methodology"><b>Methodology →</b><span>How TrueVal, TrueRange and the score are made.</span></A>
          <A href="/security"><b>Privacy and security →</b><span>What is public, what is private, and the limits.</span></A>
          <A href="/evidence"><b>Evidence →</b><span>Testnet transactions and the commands that re-run each check.</span></A>
          <A href="/faq"><b>FAQ →</b><span>Short answers inside the demo app.</span></A>
          <A href="/glossary"><b>Glossary →</b><span>The terms, in plain words.</span></A>
          <A href="/roadmap"><b>Roadmap →</b><span>What is planned, and what is live.</span></A>
        </div>
      </Band>

      <Cta label="next" title="Run it from a fresh clone.">
        <PillExt href={`${DOCS_BASE}docs/TRY_IT.md`} kind="inv">Try it ↗</PillExt>
        <Pill href="/evidence" kind="ghost inv">Evidence</Pill>
      </Cta>
    </SitePage>
  );
}
