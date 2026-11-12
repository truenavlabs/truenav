import { useEffect, useMemo, useState } from "react";
import { loadLoan } from "../../../data/registry.mjs";
import { applyOutcome, PLEDGE_STEPS, SIG, simulatePledge } from "../../../data/pledge-sim.mjs";
import { KNOWN_TXS, loadTx } from "../../../data/tx.mjs";
import { LOAN_MAP } from "../../shell/engine";
import { fundName, short, txUrl, whenFull } from "../../shell/fmt";
import { ErrorBox, Ext, FeatureFrame, Hash, Note, PageHead, Panel, Skel, SrcTag, StatusChip } from "../../shell/kit";
import { useAsync, useRegistry, type Registry } from "../../shell/store";

type SimState = { paused: boolean; pledgeKey: string | null; ticketRequired: boolean; contract: string; fundsByAccount: Record<string, string>; locks: Record<string, { fund_id: string }>; usedNonces: Set<string>; attemptSeq: number; now: number };
type SimResult = { kind: "panic"; message: string; step: number } | { kind: "return"; step: number; stores: string[]; value: { outcome: string; [k: string]: string } };
const STRANGER = "someone.testnet";
const UNPLEDGED = "0".repeat(63) + "1";

function baseState(view: Registry, now: number): SimState {
  const fundsByAccount: Record<string, string> = {};
  for (const f of view.funds) if (f.fund?.account_id) fundsByAccount[f.fund.account_id] = f.fund_id;
  const locks: Record<string, { fund_id: string }> = {};
  for (const l of view.loans) if (l.lock) locks[l.loan_hash] = { fund_id: l.lock.fund_id };
  const attempts = view.funds.reduce((s, f) => s + (f.attempts?.count ?? 0), 0);
  return { paused: !!view.roles?.paused, pledgeKey: view.pledgeKey ?? null, ticketRequired: (view.pledgeSigners?.length ?? 0) > 0, contract: "registry.tnlab-368aa2.testnet", fundsByAccount, locks, usedNonces: new Set<string>(), attemptSeq: attempts, now };
}

function LockLookup() {
  const [input, setInput] = useState(LOAN_MAP.find((l) => l.loan_id === "H-RE-03")!.loan_hash);
  const [hash, setHash] = useState(input);
  const valid = /^[0-9a-f]{64}$/.test(hash);
  const { data, error, loading, retry } = useAsync(() => (valid ? loadLoan(hash) : Promise.resolve(null)), [hash]);
  return (
    <Panel title="(a) Who holds this loan?" sub="Live get_lock on the registry." tags={<SrcTag tag="live" source={`get_lock({"loan_hash":"${short(hash, 6, 4)}"})`} />}>
      <form className="hrow" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); setHash(input.trim().toLowerCase()); }}>
        <select value={LOAN_MAP.some((l) => l.loan_hash === input) ? input : ""} onChange={(e) => { setInput(e.target.value); setHash(e.target.value); }}>
          <option value="">paste a hash</option>
          {LOAN_MAP.map((l) => <option key={l.loan_hash} value={l.loan_hash}>{l.loan_id}</option>)}
          <option value={UNPLEDGED}>an unpledged hash</option>
        </select>
        <input className="mono" style={{ flex: 1, minWidth: 260 }} value={input} onChange={(e) => setInput(e.target.value)} aria-label="Loan hash" />
        <button className="xb sm">Look up</button>
      </form>
      <div className="mt">
        {!valid ? <Note tone="warn">A loan hash is 64 lowercase hex characters.</Note> : loading ? <Skel rows={1} /> : error ? <ErrorBox error={error} retry={retry} /> : data?.lock ? (
          <p>Locked by <b>{fundName(data.lock.fund_id)}</b> since {whenFull(data.lock.locked_at_ms)}. A pledge by any other fund is refused.</p>
        ) : <p>Unlocked: no fund holds this loan hash.</p>}
      </div>
    </Panel>
  );
}

function Simulator({ autorun }: { autorun?: boolean }) {
  const { view, now } = useRegistry();
  const live = useMemo(() => baseState(view, now), [view, now]);
  const [session, setSession] = useState<SimState | null>(null);
  const st = session ?? live;
  const accounts = Object.keys(live.fundsByAccount);
  const [caller, setCaller] = useState(accounts.find((a) => a.startsWith("meridian")) ?? accounts[0] ?? STRANGER);
  const [fundAccount, setFundAccount] = useState(caller);
  const [loan, setLoan] = useState(LOAN_MAP.find((l) => l.loan_id === "H-RE-03")!.loan_hash);
  const [asset, setAsset] = useState("real_estate");
  const [sig, setSig] = useState<string>(SIG.VALID);
  const [expiry, setExpiry] = useState("1h");
  const [deposit, setDeposit] = useState("1");
  const [nonceN, setNonceN] = useState(1);
  const [res, setRes] = useState<SimResult | null>(null);
  const nonce = nonceN.toString(16).padStart(64, "0");
  const expiryMs = expiry === "1h" ? now + 3600e3 : expiry === "past" ? now - 60e3 : now + 48 * 3600e3;
  const run = () => {
    const r = simulatePledge({ deposit_yocto: deposit, loan_hash: loan, asset_type: asset, fund_account: fundAccount, nonce, expiry_ms: expiryMs, sig, caller }, { ...st, now }) as SimResult;
    setRes(r);
    setSession(applyOutcome({ ...st, now }, r) as SimState);
  };
  useEffect(() => { if (autorun && view.funds.length) run(); }, [autorun, view.funds.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = (label: string, value: string, set: (v: string) => void, opts: [string, string][]) => (
    <label className="ctl"><span>{label}</span><select value={value} onChange={(e) => set(e.target.value)}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
  );
  return (
    <Panel className="mt" title="(b) Try a pledge" sub="A port of pledge_loan's decision order, run on the live lock and role state. Simulation, nothing sent." tags={<><SrcTag tag="computed" source="web/data/pledge-sim.mjs (port of contract/src/lib.rs pledge_loan)" /><SrcTag tag="live" source="get_lock, get_roles, get_fund, get_servicer_pledge_key" /></>}>
      <div className="ctlgrid">
        {sel("Caller (who sends the call)", caller, setCaller, [...accounts.map((a): [string, string] => [a, a]), [STRANGER, `${STRANGER} (not a fund)`]])}
        {sel("Fund named in the servicer signature", fundAccount, setFundAccount, [...accounts.map((a): [string, string] => [a, a]), [STRANGER, STRANGER]])}
        {sel("Loan", loan, setLoan, [...LOAN_MAP.map((l): [string, string] => [l.loan_hash, `${l.loan_id} (${st.locks[l.loan_hash] ? `held by ${fundName(st.locks[l.loan_hash].fund_id)}` : "unlocked"})`]), [UNPLEDGED, "a new, unpledged loan"]])}
        {sel("Asset type", asset, setAsset, [["real_estate", "real_estate"], ["invoices", "invoices"], ["cars", "cars (invalid)"]])}
        {sel("Servicer signature", sig, setSig, [[SIG.VALID, "valid, from the registered pledge key"], [SIG.OTHER_KEY, "valid, from another key"], [SIG.BAD, "unreadable"]])}
        {sel("Expiry", expiry, setExpiry, [["1h", "in 1 hour"], ["past", "already passed"], ["far", "in 48 hours (over the 24 hour limit)"]])}
        {sel("Attached deposit", deposit, setDeposit, [["1", "1 yoctoNEAR"], ["0", "nothing"]])}
        <label className="ctl"><span>Nonce</span><div className="hrow" style={{ gap: 6 }}><input className="mono" value={short(nonce, 4, 6)} readOnly /><button type="button" className="xb sm ghost" onClick={() => setNonceN((n) => n + 1)}>New nonce</button></div><small>Reusing a nonce that already went through is refused.</small></label>
      </div>
      <div className="hrow mt" style={{ gap: 8 }}>
        <button className="xb" onClick={run}>Simulate the call</button>
        <button className="xb ghost" onClick={() => { setSession(null); setRes(null); }} disabled={!session}>Reset to the live state</button>
        <span className="dim">Simulation, nothing sent.{session ? " Session state includes your earlier simulated calls." : ""}</span>
      </div>
      {res ? (
        <div className="twocol mt">
          <div>
            <h3>The contract would answer</h3>
            {res.kind === "panic"
              ? <Note tone="bad">Transaction fails: <b>{res.message}</b>. Nothing is stored.</Note>
              : <Note tone={res.value.outcome === "pledged" ? "ok" : "warn"}>Transaction succeeds and returns a value:</Note>}
            {res.kind === "return" ? <pre className="raw">{JSON.stringify(res.value)}</pre> : null}
            <p className="dim">Stored on chain: {res.kind === "return" && res.stores.length ? res.stores.join("; ") : "nothing"}.</p>
          </div>
          <div>
            <h3>Decision order</h3>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
              {PLEDGE_STEPS.map((s, i) => (
                <li key={s} style={{ color: i + 1 === res.step ? (res.kind === "panic" ? "var(--red)" : "var(--yellow)") : i + 1 < res.step ? "var(--green)" : "var(--dim)", fontWeight: i + 1 === res.step ? 600 : 400 }}>{s}</li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function RecordedRefusal() {
  const { hash, sender } = KNOWN_TXS.refusedPledge;
  const { data, error, loading, retry } = useAsync(() => loadTx(hash, sender), [hash]);
  return (
    <Panel className="mt" title="(d) The real refusal on testnet" sub="Read live from NEAR RPC (tx) in your browser." tags={<SrcTag tag="live" source={`tx ${short(hash, 4, 4)}`} />} right={<Ext href={txUrl(hash)}>Explorer</Ext>}>
      {loading ? <Skel rows={3} /> : error ? <ErrorBox error={error} retry={retry} /> : data ? (
        <>
          <table className="kvt"><tbody>
            <tr><th>Transaction</th><td><Hash h={hash} a={10} z={6} /></td></tr>
            <tr><th>Sent by</th><td>{data.signer}</td></tr>
            <tr><th>Called</th><td>{data.receiver} . {data.method}</td></tr>
            <tr><th>Loan</th><td>{(() => { const l = LOAN_MAP.find((m) => m.loan_hash === (data.args as { loan_hash?: string })?.loan_hash); return l ? `${l.loan_id} (${fundName(l.fund_id)})` : short((data.args as { loan_hash?: string })?.loan_hash, 8, 6); })()}</td></tr>
            <tr><th>Block time</th><td>{whenFull(data.blockTimeMs)}</td></tr>
            <tr><th>Status</th><td>{data.ok ? <span className="ok">success</span> : <span className="bad">failed: {data.failure}</span>}</td></tr>
          </tbody></table>
          <pre className="raw mt">{JSON.stringify(data.returnValue)}</pre>
          <p className="dim">The refusal is a return value, not a failure. That is why the contract can store the attempt and the alert: a failed transaction would roll back every write.</p>
        </>
      ) : null}
    </Panel>
  );
}

export default function DoublePledge({ q }: { q?: URLSearchParams }) {
  const { view, tag } = useRegistry();
  const tryIt = (
    <>
      <LockLookup />
      <Simulator autorun={q?.get("run") === "1"} />
      <Panel className="mt" title="(c) Attempts and alerts on both funds" tags={<SrcTag tag={tag} source="get_attempts_page, get_alerts_page" />} pad={false}>
        <table className="dt"><thead><tr><th>Fund</th><th className="r">Refused pledges</th><th>Attempts</th><th>Alerts</th></tr></thead>
          <tbody>{view.funds.map((f) => (
            <tr key={f.fund_id}><td>{fundName(f.fund_id)}</td><td className="r num">{f.attempts?.count ?? "n/a"}</td>
              <td>{(f.attempts?.attempts || []).map((a: { attempt_id: string; at_ms: number }) => `${a.attempt_id}, ${whenFull(a.at_ms)}`).join("; ") || <span className="dim">none</span>}</td>
              <td>{(f.alerts || []).map((t: number) => whenFull(t)).join("; ") || <span className="dim">none</span>}</td></tr>
          ))}</tbody></table>
      </Panel>
      <RecordedRefusal />
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F4 Double-pledge lock"]]} title="Double-pledge lock" lead="One loan, one fund. Look up who holds a loan, try a pledge against the live lock state, and read the real refusal from testnet." />
      <FeatureFrame
        what="The registry locks each loan hash to the first fund that pledges it and mints a non-transferable token. A second fund's pledge is refused with &quot;already pledged elsewhere&quot; and recorded against the fund that tried."
        status={<StatusChip kind="live" />}
        tryIt={tryIt}
        proves={[
          "On testnet, Meridian's pledge of Harbor's loan H-RE-03 was refused, and the attempt and alert sit on Meridian's record.",
          "The order of the checks: format and signature checks come first, a call by an account that is not the named fund stores nothing, and only a valid pledge by a registered fund counts as an attempt.",
          "The holder fund is not named in the refusal or the alert.",
        ]}
        notProves={[
          "That two registries cannot both hold the loan. The lock is per registry.",
          "That the loan hash matches a real loan. That is the enclave's and the servicer's job.",
          "The simulator does not recover signatures; it models the signature as a choice. The contract itself recovers them with env::ecrecover.",
        ]}
        run={["cd contract && cargo test", "npm run e2e:testnet"]}
        sources={["contract/src/lib.rs:699", "contract/tests/registry.rs", "web/data/pledge-sim.mjs", "web/data/tx.mjs"]}
      />
    </>
  );
}
