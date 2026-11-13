import { Ext, PageHead, Panel } from "../shell/kit";
import { srcUrl } from "../shell/fmt";
import { A } from "../ui";

const S = ({ p, l, children }: { p: string; l?: number; children: string }) => <Ext href={srcUrl(p) + (l ? `#L${l}` : "")}>{children}</Ext>;

export default function Methodology() {
  return (
    <>
      <PageHead title="Methodology" lead={<>How TrueVal, TrueRange and the TrueNav score are computed. The rules are in <code>spec/nav/NAV_SPEC.md</code> and the code is <code>engine/src/score.mjs</code>, which your browser runs on the <A href="/features/engine">Engine page</A>.</>} />
      <div className="prose" style={{ maxWidth: "none" }}>
        <Panel title="TrueVal">
          <p>What the fund's verified loans are worth after expected losses: the sum over verified loans of EAD x (1 - PD x LGD). A model estimate, not fair value. EAD is principal plus accrued interest minus repayments. <S p="engine/src/score.mjs" l={508}>score.mjs</S></p>
          <p>A loan is verified when it is open, valid, its pledge token is held, it carries no anomaly flag and it is not a duplicate (NAV_SPEC R2). Every other open loan is unverified and left out of TrueVal.</p>
        </Panel>
        <Panel className="mt" title="TrueRange">
          <p>Where TrueVal likely falls if loans default independently: TrueVal plus or minus z x the standard deviation of loss, with z = 1.96 and variance = sum of EAD² x LGD² x PD x (1 - PD). A demo estimate; correlated defaults are on the roadmap. <S p="engine/src/score.mjs" l={510}>score.mjs</S></p>
        </Panel>
        <Panel className="mt" title="Model tables (demo, not calibrated)">
          <p>PD by days past due: current 2%, 1 to 30 days 10%, 31 to 60 days 25%, 61 to 90 days 45%, over 90 days 100%. LGD by asset type: real estate (first lien) 31%, invoices (treated as unsecured) 67%, an inference from a corporate stress table. <S p="spec/nav/NAV_SPEC.md">NAV_SPEC section 2</S></p>
        </Panel>
        <Panel className="mt" title="The score, 0 to 100">
          <ul>
            <li><strong>Gap, up to 40.</strong> How far the loan-implied headline (headline + liabilities - attested cash) sits outside TrueRange, against 10% of TrueVal. Inside the range gives the full 40 (R6).</li>
            <li><strong>Coverage, up to 40.</strong> 40 x min(1, Policy NAV / max(loan-implied headline, listed book)): how much of the claim is backed by verified loans (R7).</li>
            <li><strong>Freshness, up to 20.</strong> Full at 24 hours or less, falling linearly to 0 at 168 hours, from the oldest input date (R8).</li>
            <li><strong>Penalty.</strong> 15 x 0.5^(age in days / 30) per distinct blocked double-pledge attempt (R9).</li>
          </ul>
          <p>Score = gap + coverage + freshness - penalty, rounded half up, floored at 0 (R11). Bands: green 85 and up, yellow 60 to 84, red below 60.</p>
        </Panel>
        <Panel className="mt" title="Holds and caps">
          <ul>
            <li><strong>No green for 30 days after an attempt.</strong> The fund that attempted a double pledge is capped at yellow; the number is unchanged (R12).</li>
            <li><strong>50% test.</strong> If more than half the claimed value is unverified, the fund is disclaimed: red with no number (R13, R14).</li>
            <li><strong>Stale or missing data.</strong> A certificate over data older than 30 days fails verification; a never certified fund with no headline is not rated (R14).</li>
            <li>The 30 days, 50% and 10% thresholds are TrueNav's own policy, not agency figures (R16).</li>
          </ul>
        </Panel>
        <Panel className="mt" title="Enclave verdicts">
          <p>A model in an attested TEE reads each pledged loan's private document, compares it with the fund's claim and signs a verdict-only reply. A flag makes the loan unverified and excluded. With no verdict the loan is pending for 7 days after its on-chain pledge time, then unverified ("TEE check overdue"). The engine reads verdicts from the chain and never calls the TEE itself (R25). A flag on Harbor's loan H-RE-01 alone takes Harbor from green to red: try it on the <A href="/features/engine?preset=t1">Engine page</A>.</p>
        </Panel>
        <Panel className="mt" title="What moves a score">
          <ul>
            <li>A new enclave flag or an overdue verdict (coverage and TrueVal fall).</li>
            <li>A blocked double-pledge attempt (penalty, and no green for 30 days).</li>
            <li>Older data (freshness falls after 24 hours).</li>
            <li>A headline NAV that drifts outside TrueRange (gap points fall).</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
