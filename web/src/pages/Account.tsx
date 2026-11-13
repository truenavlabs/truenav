import { useState } from "react";
import { loadAccount } from "../../data/registry.mjs";
import { A, navigate } from "../ui";
import { ErrorBox, Ext, Hash, Note, PageHead, Panel, Skel, SrcTag } from "../shell/kit";
import { accountUrl, fundName, when } from "../shell/fmt";
import { useAsync } from "../shell/store";

type Acc = { account_id: string; tokens: { token_id: string; metadata?: { extra?: string; issued_at?: string } }[]; supply: number; fund: { fund_id?: string; account_id: string } | null; roles: string[]; readAt: string; block: { height: number; hash: string } | null };

export default function Account({ id }: { id: string }) {
  const [input, setInput] = useState(id);
  const st = useAsync(() => (id ? (loadAccount(id) as unknown as Promise<Acc>) : Promise.resolve(null)), [id]);
  const a = st.data as Acc | null | undefined;
  return (
    <>
      <PageHead title="View as account" lead="Paste any NEAR testnet account to see the TrueNav pledge tokens it holds and whether it is a registered fund or holds a role. Read-only; no wallet needed." />
      <form className="hrow" onSubmit={(e) => { e.preventDefault(); const v = input.trim().toLowerCase(); if (v) navigate(`/account/${encodeURIComponent(v)}`); }}>
        <input className="ctl mono" style={{ minWidth: 320 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="name.testnet" aria-label="Account id" />
        <button className="xb">Read</button>
        <A href="/account/harbor.tnlab-368aa2.testnet" className="chiplink">harbor.tnlab-368aa2.testnet</A>
        <A href="/account/meridian.tnlab-368aa2.testnet" className="chiplink">meridian.tnlab-368aa2.testnet</A>
      </form>
      {!id ? null : st.error ? <ErrorBox error={String(st.error)} /> : !a ? <Skel rows={4} /> : (
        <Panel className="mt" title={a.account_id} sub={`Read at block ${a.block ? a.block.height.toLocaleString("en-US") : "n/a"}, ${when(a.readAt)}`} tags={<SrcTag tag="live" source="nft_tokens_for_owner, nft_supply_for_owner, get_fund, get_roles" />} right={<Ext href={accountUrl(a.account_id)}>Explorer</Ext>}>
          <div className="kpirow">
            <div className="kpi"><div className="kl">Pledge tokens held</div><div className="kval">{a.supply}</div></div>
            <div className="kpi"><div className="kl">Registered fund</div><div className="kval" style={{ fontSize: 18 }}>{a.fund ? fundName(a.fund.fund_id ?? "") : "No"}</div></div>
            <div className="kpi"><div className="kl">Roles</div><div className="kval" style={{ fontSize: 18 }}>{a.roles.length ? a.roles.join(", ") : "None"}</div></div>
          </div>
          {!a.fund && a.supply === 0 && !a.roles.length ? <Note tone="info">This account holds no TrueNav pledge tokens and is not a registered fund.</Note> : null}
          {a.fund ? <p className="mt"><A href={`/funds/${a.fund.fund_id}`}>Open {fundName(a.fund.fund_id ?? "")}</A></p> : null}
          {a.tokens.length ? (
            <table className="dt mt"><thead><tr><th>Loan hash (token id)</th><th>Issued</th></tr></thead>
              <tbody>{a.tokens.map((t) => <tr key={t.token_id}><td><A href={`/loans/${t.token_id}`}><Hash h={t.token_id} a={10} z={6} /></A></td><td>{t.metadata?.issued_at ? when(Number(t.metadata.issued_at)) : "n/a"}</td></tr>)}</tbody></table>
          ) : null}
          <p className="dim small mt">The registry has no reverse lookup from account to fund, so this page checks the known fund ids with get_fund.</p>
        </Panel>
      )}
    </>
  );
}
