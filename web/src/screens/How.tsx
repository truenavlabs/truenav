import { INFORMS, TOOLTIPS } from "../copy";

export function How() {
  return (
    <div className="grey">
      <h1>How it works</h1>
      <p>TrueNav is an independent check for investors in tokenized private credit.</p>
      <section className="box">
        <h2>Pillar 1. Pledge once</h2>
        <p>Each loan is pledged only once among participating funds. The check does not reveal the loans.</p>
      </section>
      <section className="box">
        <h2>Pillar 2. NAV check</h2>
        <p>The fund's reported NAV is checked against TrueVal, recomputed from its loan tape.</p>
        <p>TrueRange is the band around TrueVal. The TrueNav score runs from 0 to 100.</p>
        <ul className="plain">
          <li><b>TrueVal:</b> {TOOLTIPS.trueVal}</li>
          <li><b>TrueRange:</b> {TOOLTIPS.trueRange}</li>
          <li><b>TrueNav score:</b> {TOOLTIPS.score} Bands: {TOOLTIPS.bands}</li>
        </ul>
        <p>{INFORMS}</p>
      </section>
      <section className="box">
        <h2>TEE flow</h2>
        <div className="flow">
          <div className="box">
            <div className="k">1</div>
            <p>Loan tape and reported NAV go into a TEE on NEAR.</p>
          </div>
          <div className="box">
            <div className="k">2</div>
            <p>The TEE recomputes TrueVal and TrueRange from the tape.</p>
          </div>
          <div className="box">
            <div className="k">3</div>
            <p>The TEE checks that each loan is pledged only once.</p>
          </div>
          <div className="box">
            <div className="k">4</div>
            <p>A public receipt comes out. The loans stay inside.</p>
          </div>
          <div className="box">
            <div className="k">5</div>
            <p>An investor reads the score, TrueVal, and TrueRange.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
