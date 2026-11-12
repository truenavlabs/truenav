import { useEffect, useState } from "react";
import golden from "../../../../schema/vectors/receipt-v3-golden.json";
import schema300 from "../../../../schema/receipt-v3.schema.json";
import schema301 from "../../../../schema/receipt-v3.0.1.schema.json";
import { FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";
import { sha256Hex } from "../../lib/webhash";

type Schema = { required: string[]; properties: Record<string, { type?: string | string[]; const?: unknown; enum?: unknown[] }>; additionalProperties?: boolean };
const sample = JSON.stringify((golden as { vectors: { envelope: unknown }[] }).vectors[0].envelope, null, 1);
const BAND: Record<string, number> = { red: 0, yellow: 1, green: 2 };

function typeOk(v: unknown, t?: string | string[]) {
  if (!t) return true;
  const ts = Array.isArray(t) ? t : [t];
  return ts.some((x) => (x === "null" ? v === null : x === "integer" ? Number.isInteger(v) : x === "array" ? Array.isArray(v) : x === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === x));
}

export default function ReceiptsMirror() {
  const [text, setText] = useState(sample);
  const [cd, setCd] = useState<[string, string][] | null>(null);
  let obj: Record<string, unknown> | null = null, parseErr: string | null = null;
  try { obj = JSON.parse(text); } catch (e) { parseErr = (e as Error).message; }
  const schema = (obj?.method_version === "truenav-v3.0.1" ? schema301 : schema300) as unknown as Schema;
  const problems: string[] = [];
  if (obj) {
    for (const k of schema.required) if (!(k in obj)) problems.push(`missing ${k}`);
    if (schema.additionalProperties === false) for (const k of Object.keys(obj)) if (!(k in schema.properties)) problems.push(`key not allowed: ${k}`);
    for (const [k, p] of Object.entries(schema.properties)) if (k in obj) {
      if (!typeOk(obj[k], p.type)) problems.push(`${k} has the wrong type`);
      if (p.const !== undefined && obj[k] !== p.const) problems.push(`${k} must be ${JSON.stringify(p.const)}`);
      if (p.enum && !p.enum.some((e) => JSON.stringify(e) === JSON.stringify(obj![k]))) problems.push(`${k} is not an allowed value`);
    }
  }
  useEffect(() => {
    setCd(null);
    if (!obj || problems.length) return;
    const o = obj;
    void Promise.all([sha256Hex(String(o.token_id)), sha256Hex(String(o.method_version))]).then(([tok, meth]) => setCd([
      ["bytes32 tokenHash = sha256(token_id)", `0x${tok}`], ["uint256 seq", String(o.seq)], ["bytes32 receiptHash", `0x${String(o.receipt_sha256)}`],
      ["uint8 score", String(o.score)], ["uint8 band", `${BAND[String(o.band)] ?? "?"} (${String(o.band)})`], ["bytes32 methodHash = sha256(method_version)", `0x${meth}`],
      ["uint64 as_of = valuation_time (UTC ms)", String(Date.parse(String(o.valuation_time)))],
    ]));
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const tryIt = (
    <>
      <Note tone="warn">Built and tested locally. Not deployed. No OutLayer run, no Chain Signatures signing, no Base transaction.</Note>
      <div className="twocol mt">
        <div>
          <h3>Paste a v3 receipt <SrcTag tag="recorded" source="schema/vectors/receipt-v3-golden.json (synthetic, test only)" /></h3>
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ width: "100%", height: 360, fontFamily: "var(--mono)", fontSize: 11 }} spellCheck={false} />
          <button className="xb sm ghost mt" onClick={() => setText(sample)}>Reset to the golden vector</button>
        </div>
        <div>
          <h3>Schema check ({String(obj?.method_version ?? "unknown method")})</h3>
          {parseErr ? <Note tone="bad">Not JSON: {parseErr}</Note> : problems.length ? <Note tone="bad"><b>{problems.length} problem{problems.length === 1 ? "" : "s"}</b>: {problems.slice(0, 8).join("; ")}{problems.length > 8 ? "; ..." : ""}</Note> : <Note tone="ok">Every required key present, no extra keys, types and fixed values match ({schema.required.length} keys).</Note>}
          <h3 className="mt">Mirror calldata fields</h3>
          <p className="dim" style={{ fontSize: 12 }}>update(bytes32,uint256,bytes32,uint8,uint8,bytes32,uint64), built from the stored receipt only. No caller can supply calldata, recipient, value or nonce.</p>
          {cd ? <table className="kvt"><tbody>{cd.map(([k, v]) => <tr key={k}><th>{k}</th><td className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{v}</td></tr>)}</tbody></table> : <p className="dim">Fix the receipt to see the fields.</p>}
        </div>
      </div>
      <Panel className="mt" title="How a v3 receipt is made (design, not run)">
        <ol style={{ paddingLeft: 18 }}>
          <li>The receipts contract asks OutLayer to run the pinned engine (request_run); the call yields.</li>
          <li>OutLayer runs the engine in its TEE and calls back; only the whitelisted callback can resume the call.</li>
          <li>The contract stores the receipt and its sha256 under a rising sequence per token.</li>
          <li>Optionally, Chain Signatures signs a Base Sepolia transaction that mirrors the score fields above to a contract that accepts only the MPC signer and a rising sequence.</li>
        </ol>
      </Panel>
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F10 Receipts and mirror"]]} title="Receipts v3 and the Base mirror" lead="The next step for scores: receipts produced by a TEE engine run and mirrored to an EVM chain. Built and tested, not deployed." />
      <FeatureFrame
        what="Receipts v3 record each score run with its inputs' hashes, the engine build and the result, so a buyer can check a score without trusting the operator. A mirror carries the public fields to Base."
        status={<StatusChip kind="notdeployed" />}
        tryIt={tryIt}
        proves={["The receipt format and its fixed fields (schema and golden vector).", "Exactly which fields the mirror would carry, derived from the receipt alone."]}
        notProves={["That any receipt exists on chain: none is deployed for the live registry.", "That OutLayer or Chain Signatures ran: nothing was run or signed."]}
        run={["node --test receipts/tests/python-schema.test.mjs mirror/test/mirror.test.mjs", "npm run judge -- --replay"]}
        sources={["receipts/src/mirror.rs:175", "receipts/README.md", "mirror/README.md", "schema/receipt-v3.0.1.schema.json", "schema/vectors/receipt-v3-golden.json"]}
      />
    </>
  );
}
