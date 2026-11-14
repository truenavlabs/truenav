import { useState } from "react";
import { rawView, VIEW_METHODS } from "../../data/registry.mjs";
import { Copy, ErrorBox, Ext, Note, PageHead, Panel, SrcTag } from "../shell/kit";
import { srcUrl, when } from "../shell/fmt";
import { useRegistry } from "../shell/store";

type Out = { call: string; result: unknown; rpc: string; block: number; readAt: string };

function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ViewRow({ method, args }: { method: string; args: Record<string, unknown> }) {
  const [text, setText] = useState(JSON.stringify(args));
  const [out, setOut] = useState<Out | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      setOut((await rawView(method, parsed)) as unknown as Out);
    } catch (e) { setErr(String((e as Error).message || e)); setOut(null); }
    setBusy(false);
  };
  return (
    <div className="vrow">
      <div className="vhead">
        <code className="vm">{method}</code>
        <input className="ctl mono" aria-label={`${method} arguments`} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <button className="xb" onClick={run} disabled={busy}>{busy ? "Reading" : "Run"}</button>
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {out ? (
        <div className="vout">
          <div className="dim small">view call {out.call} at block {out.block.toLocaleString("en-US")}, {when(out.readAt)}, via {new URL(out.rpc).host} <Copy text={JSON.stringify(out.result, null, 2)} /></div>
          <pre className="raw">{JSON.stringify(out.result, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}

export default function Data() {
  const { view, tag } = useRegistry();
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHead title="Raw chain data" lead="Every view method of the live registry, with its arguments and a Run button. Your browser sends the view call to a public NEAR testnet RPC and shows the JSON it gets back. Views are read-only: they cannot change anything." />
      <Panel title="Downloads" sub="What this dashboard read, as files." tags={<SrcTag tag={tag} source="registry.tnlab-368aa2.testnet" />}>
        <div className="hrow">
          <button className="xb" onClick={() => download(`truenav-registry-${stamp}.json`, JSON.stringify(view, null, 2))}>Registry read (JSON)</button>
        </div>
        <p className="dim mt">Table CSVs are on each table (Funds, Loans, fund tabs): the CSV button exports the rows as shown.</p>
      </Panel>
      <Panel className="mt" title="View calls" sub={`${VIEW_METHODS.length} methods. Edit the JSON arguments and press Run.`} tags={<SrcTag tag="live" source="NEAR testnet RPC, call_function" />} pad={false}>
        {(VIEW_METHODS as unknown as [string, Record<string, unknown>][]).map(([m, a]) => <ViewRow key={m} method={m} args={a} />)}
      </Panel>
      <Panel className="mt" title="Evidence files" sub="The recorded files the verifier and feature pages use, in the repository.">
        <ul className="plain">
          <li><Ext href={srcUrl("tee/fixtures/attestation-report-368aa2.json.b64")}>Attestation report (base64)</Ext></li>
          <li><Ext href={srcUrl("tee/fixtures/verdicts-368aa2.json")}>Recorded enclave replies and signatures</Ext></li>
          <li><Ext href={srcUrl("tee/status.json")}>tee/status.json</Ext></li>
          <li><Ext href={srcUrl("certify/live-registry.json")}>certify/live-registry.json (expected registry setup)</Ext></li>
        </ul>
      </Panel>
    </>
  );
}
