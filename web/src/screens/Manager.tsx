import { useState } from "react";
import { NAMES, TOOLTIPS } from "../copy";
import { reports, scores } from "../data";
import { centsLabel } from "../format";
import { Field } from "../ui";

export function Manager() {
  const [tokenId, setTokenId] = useState(scores[0].token_id);
  const score = scores.find((row) => row.token_id === tokenId) ?? scores[0];
  const report = reports.find((row) => row.token_id === tokenId) ?? reports[0];
  const receipt = report.receipt;
  return (
    <div className="grey">
      <h1>Fund manager</h1>
      <p>Grey box. Fund-private view, placeholders only. No transaction.</p>
      <label htmlFor="manager-fund">fund</label>
      <select id="manager-fund" value={tokenId} onChange={(event) => setTokenId(event.target.value)}>
        {scores.map((row) => (
          <option key={row.token_id} value={row.token_id}>
            {NAMES[row.token_id]}
          </option>
        ))}
      </select>
      <section className="box">
        <h2>receipt preview</h2>
        <div className="grid">
          <Field label="seq" value={receipt.seq} />
          <Field label="TrueNav score" tip={TOOLTIPS.score} value={receipt.score === null ? "null" : receipt.score} />
          <Field label="band" value={receipt.band} />
          <Field label="TrueVal" tip={TOOLTIPS.trueVal} value={centsLabel(receipt.trueval)} />
          <Field label="TrueRange" tip={TOOLTIPS.trueRange} value={`${centsLabel(receipt.truerange_low)} to ${centsLabel(receipt.truerange_high)}`} />
          <Field label="receipt_sha256" value={receipt.receipt_sha256} />
        </div>
      </section>
      <section className="box">
        <h2>sign NAV</h2>
        <button type="button" disabled>
          sign NAV
        </button>
        <p>needs backend</p>
      </section>
      <section className="box">
        <h2>request or pay run</h2>
        <button type="button" disabled>
          request or pay run
        </button>
        <p>needs backend</p>
      </section>
      <section className="box">
        <h2>duplicate pledge attempts</h2>
        <div className="grid">
          <Field label="attempts on record" value={score.blocked_attempts} />
          <Field label="attempt window" value={receipt.blocked_attempts_window} />
        </div>
        <div className="box">
          <div className="k">attempt list</div>
          <p>needs backend</p>
        </div>
      </section>
      <section className="box">
        <h2>receipt JSON</h2>
        <pre>{JSON.stringify(receipt, null, 2)}</pre>
      </section>
    </div>
  );
}
