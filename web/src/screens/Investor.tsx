import { useState } from "react";
import { alerts, listFunds, toggleWatch, watchlist } from "../api/client";
import { TOOLTIPS } from "../copy";
import { usdM } from "../format";
import { Field } from "../ui";

// Grey box. Public fields only. Deposit, redeem and buy report are cut from this build.
export function Investor() {
  const funds = listFunds();
  const [watch, setWatch] = useState(watchlist);
  const [checked, setChecked] = useState<string | null>(null);
  return (
    <div className="grey">
      <h1>Investor</h1>
      <p>Grey box. Simulated fixtures. No wallet library. Nothing here signs or sends a transaction.</p>
      <section className="box">
        <h2>wallet</h2>
        <button type="button" disabled>connect wallet (stub)</button>
        <p>Not wired in this build. A later build may read an account; it will not move funds.</p>
      </section>
      <section className="box">
        <h2>watchlist</h2>
        {funds.map((f) => (
          <div className="grid" key={f.token_id}>
            <Field label="fund" value={`${f.name} ${f.token_id}`} />
            <Field label="TrueNav score" tip={TOOLTIPS.score} value={<>{f.receipt.score ?? "n/a"} · {f.receipt.band}</>} />
            <Field label="TrueVal" tip={TOOLTIPS.trueVal} value={usdM(f.receipt.trueval)} />
            <Field
              label="watch"
              value={
                <button type="button" onClick={() => setWatch(toggleWatch(f.token_id))}>
                  {watch.includes(f.token_id) ? "watching, stored in this browser" : "watch"}
                </button>
              }
            />
          </div>
        ))}
      </section>
      <section className="box">
        <h2>alerts feed · example data</h2>
        <ul className="plain">
          {funds.flatMap((f) => alerts(f.token_id).map((a, i) => (
            <li key={f.token_id + i}>{f.name} · {a.at} · {a.text} · {a.source}</li>
          )))}
        </ul>
      </section>
      <section className="box">
        <h2>request check · simulated</h2>
        <p>Asks for a fresh run on a fund. In this build it only shows what would be requested.</p>
        <button type="button" onClick={() => setChecked(funds[0].token_id)}>simulate request for {funds[0].name}</button>
        {checked ? <pre>{JSON.stringify({ token_id: checked, status: "simulated", sent: false }, null, 2)}</pre> : null}
      </section>
    </div>
  );
}
