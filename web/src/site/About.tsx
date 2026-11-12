// About: long page. Team is TrueNav Labs. Contact is a placeholder until a public address exists.
import { INFORMS } from "../copy";
import { A } from "../ui";
import { LongPage, type LongSection } from "./Long";
import { REPO, SiteFooter, SitePage } from "./Shell";

// TODO: replace with the Referral Relay public URL once it is published.
const REFERRAL_RELAY_URL = "#";
// TODO: replace with a real public contact address. This placeholder does not receive mail.
const CONTACT = "contact@example.invalid";

export function About() {
  const sections: LongSection[] = [
    {
      id: "mission", layer: "mission", title: "An independent check on reported NAV.",
      body: (
        <>
          <p>Tokenized credit funds report a NAV, and investors mostly have to take it on trust because the loans behind it are private. TrueNav checks that number without making the loans public.</p>
          <p>{INFORMS}</p>
        </>
      ),
    },
    {
      id: "hackathon", layer: "built at NEAR", title: "Built at NEAR HACKATHON 2026.",
      body: (
        <>
          <p>TrueNav is built by TrueNav Labs for NEAR HACKATHON 2026, in the Privacy and Private AI and the Open Innovation tracks. It runs on NEAR testnet, and every fund, loan and document in it is fictional.</p>
          <p>
            Our sibling project is{" "}
            <a href={REFERRAL_RELAY_URL} className="ln">Referral Relay</a>.
          </p>
        </>
      ),
    },
    {
      id: "source", layer: "open source", title: "Read the code, run the checks.",
      body: (
        <>
          <p>The engine, the contracts, the TEE tooling and this site are in one public repository. Every check on the Technology page runs from a fresh clone with no API key and no NEAR account.</p>
          <p><a href={REPO} className="ln" target="_blank" rel="noopener noreferrer">github.com/truenavlabs/truenav ↗</a></p>
        </>
      ),
    },
    {
      id: "contact", layer: "contact", title: "Talk to TrueNav Labs.",
      body: (
        <>
          <p>Questions from judges, funds or builders are welcome.</p>
          <p className="mono"><span className="ln">{CONTACT}</span> <span className="lp-note">(placeholder)</span></p>
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
          <>
            <section className="cta-band">
              <div>
                <span className="lbl">product</span>
                <h2>See what it checks.</h2>
              </div>
              <div className="cta-a">
                <A href="/product" className="pillbtn inv">Product <span aria-hidden="true">→</span></A>
                <A href="/overview" className="pillbtn ghost inv">Open app</A>
              </div>
            </section>
            <SiteFooter />
          </>
        }
      />
    </SitePage>
  );
}
