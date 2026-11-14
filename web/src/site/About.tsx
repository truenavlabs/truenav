// About: long page. Team is TrueNav Labs. Contact is GitHub Issues. The hackathon section is the origin story:
// where TrueNav was built, never an award or an endorsement.
import { A } from "../ui";
import { HACKATHON_URL } from "./content";
import { LongPage, type LongSection } from "./Long";
import { ISSUES, REPO, SitePage } from "./Shell";

export function About() {
  const sections: LongSection[] = [
    {
      id: "mission", layer: "mission", title: "An independent check on reported NAV.",
      body: (
        <>
          <p>Tokenized credit funds report a NAV, and investors mostly have to take it on trust because the loans behind it are private. TrueNav checks that number without making the loans public.</p>
          <p>TrueNav informs only. It does not hold or move funds, and a red score never blocks a transfer. It is not a rating agency and not investment advice.</p>
        </>
      ),
    },
    {
      id: "hackathon", layer: "built at NEAR", title: "Built at NEAR HACKATHON 2026.",
      body: (
        <>
          <p>
            TrueNav started at NEAR HACKATHON, the November 2026 build event run at{" "}
            <a href={HACKATHON_URL} className="ln" target="_blank" rel="noopener noreferrer">nearhackathon.com ↗</a>. TrueNav Labs built it between 5 and 14 November 2026, inside the event window, and entered two tracks: Privacy and Private AI, and Open Innovation. It runs on NEAR testnet, and every fund, loan and document in it is fictional.
          </p>
          <ul className="lp-list">
            <li><b>5 Nov.</b> First commit. The idea: check a tokenized fund's reported NAV against its loans without exposing them.</li>
            <li><b>6 Nov.</b> The score engine, the registry contract, the TEE underwriter and a first testnet flow.</li>
            <li><b>11 Nov.</b> The current registry went live on NEAR testnet, and the attested TEE signer was registered.</li>
            <li><b>13 to 14 Nov.</b> The web app and verifier, security hardening, the whitepaper and the MIT licence.</li>
          </ul>
          <p className="lp-note">TrueNav Labs is an entrant. This is not an award, a partnership or an endorsement by the event.</p>
          <p>The same submitter also entered <a href="https://tendaicustody.app" className="ln" target="_blank" rel="noopener noreferrer">TendAI Custody</a>.</p>
        </>
      ),
    },
    {
      id: "source", layer: "open source", title: "Read the code, run the checks.",
      body: (
        <>
          <p>The engine, the contracts, the TEE tooling and this site are in one public repository under the MIT licence. Every check on the Technology page runs from a fresh clone with no API key and no NEAR account.</p>
          <p><a href={REPO} className="ln" target="_blank" rel="noopener noreferrer">github.com/truenavlabs/truenav ↗</a></p>
        </>
      ),
    },
    {
      id: "contact", layer: "contact", title: "Talk to TrueNav Labs.",
      body: (
        <>
          <p>Questions from judges, funds or builders are welcome. To try TrueNav on your own question, <A href="/pilot" className="ln">request a pilot</A>.</p>
          <p><a href={ISSUES} className="ln" target="_blank" rel="noopener noreferrer">github.com/truenavlabs/truenav/issues ↗</a></p>
        </>
      ),
    },
  ];
  return (
    <SitePage route="about" tone="dark" className="long">
      <LongPage
        hero={
          <div className="lp-hero-in">
            <span className="lbl">about</span>
            <h1>We make reported numbers checkable.</h1>
            <p>TrueNav Labs builds private verification for tokenized credit on NEAR.</p>
          </div>
        }
        sections={sections}
        after={
          <section className="cta-band">
            <div>
              <span className="lbl">product</span>
              <h2>See what it checks.</h2>
            </div>
            <div className="cta-a">
              <A href="/product" className="pillbtn inv">Product <span aria-hidden="true">→</span></A>
              <A href="/overview" className="pillbtn ghost inv">Open demo</A>
            </div>
          </section>
        }
      />
    </SitePage>
  );
}
