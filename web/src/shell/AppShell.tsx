// App frame: sidebar, top bar (search, Testnet pill, live data pill, wallet slot), ticker slot, footer, help bubble.
import { useEffect, useState, type ReactNode } from "react";
import { A, navigate } from "../ui";
import { Brand } from "./Brand";
import { HelpBubble } from "./Help";
import { RECORDED, useRegistry } from "./store";
import { SLOTS } from "./slots";
import { clock, int, short, whenFull } from "./fmt";

type Item = { href: string; label: string; match?: RegExp };
const NAV: { group: string; items: Item[] }[] = [
  { group: "Explore", items: [
    { href: "/overview", label: "Overview" },
    { href: "/funds", label: "Funds", match: /^\/funds/ },
    { href: "/loans", label: "Loans", match: /^\/loans/ },
    ...(SLOTS.Markets ? [{ href: "/markets", label: "Markets" }] : []),
  ] },
  { group: "Verify it yourself", items: [
    { href: "/verify", label: "Verifier" },
    { href: "/features", label: "All features", match: /^\/features$/ },
    { href: "/features/engine", label: "Recompute a score" },
    { href: "/features/double-pledge", label: "Double-pledge lock" },
    { href: "/features/tee-underwriting", label: "TEE underwriting" },
    { href: "/features/attestation", label: "Attestation" },
    { href: "/data", label: "Raw chain data" },
  ] },
  { group: "Learn", items: [
    { href: "/methodology", label: "Methodology" },
    { href: "/trust", label: "Trust and privacy" },
    { href: "/glossary", label: "Glossary" },
    { href: "/faq", label: "FAQ" },
  ] },
  { group: "More", items: [
    { href: "/status", label: "Data status" },
    { href: "/roadmap", label: "Roadmap" },
    { href: "/support", label: "Support" },
  ] },
];

function LivePill() {
  const { state, reg, refresh, loading } = useRegistry();
  const label = state === "loading" ? "Reading NEAR testnet..." : state === "offline" ? "Offline, showing recorded read" : state === "stale" ? `Stale, read ${clock(reg!.readAt)}` : state === "partial" ? `Partial read ${clock(reg!.readAt)}` : `Live, read ${clock(reg!.readAt)}`;
  const tone = state === "live" ? "g" : state === "loading" ? "c" : state === "offline" ? "x" : "y";
  return (
    <button className={`livepill p-${tone}${loading ? " busy" : ""}`} onClick={refresh} title={`Click to read again.${reg?.rpc ? ` RPC ${reg.rpc}.` : ""}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
      {reg?.block && state !== "offline" ? <span className="blk mono">#{int(reg.block.height)}</span> : null}
    </button>
  );
}

function Search() {
  const [q, setQ] = useState("");
  const go = () => {
    const s = q.trim();
    if (!s) return;
    if (/^[0-9a-f]{64}$/.test(s)) navigate(`/loans/${s}`);
    else if (/harbor/i.test(s)) navigate("/funds/harbor-credit-fund");
    else if (/meridian/i.test(s)) navigate("/funds/meridian-yield-fund");
    else if (/\.testnet$/.test(s)) navigate(`/account/${encodeURIComponent(s)}`);
    else if (/^[0-9a-f]{6,63}$/.test(s)) navigate(`/loans?q=${s}`);
    else navigate(`/faq?q=${encodeURIComponent(s)}`);
    setQ("");
  };
  return (
    <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Fund, loan hash, account.testnet, question" aria-label="Search" />
    </form>
  );
}

export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { state } = useRegistry();
  const p = path.split(/[?#]/)[0];
  useEffect(() => setOpen(false), [p]);
  const Wallet = SLOTS.Wallet;
  const Ticker = SLOTS.Ticker;
  return (
    <div className={`tn${open ? " navopen" : ""}`}>
      <a href="#main" className="skip">Skip to content</a>
      <aside className="sb" aria-label="App navigation">
        <Brand href="/" />
        <nav>
          {NAV.map((g) => (
            <div key={g.group} className="sbg">
              <div className="sbh">{g.group}</div>
              {g.items.map((it) => {
                const on = it.match ? it.match.test(p) : p === it.href;
                return <A key={it.href} href={it.href} className={`sbi${on ? " on" : ""}`} ariaCurrent={on ? "page" : undefined}>{it.label}</A>;
              })}
            </div>
          ))}
        </nav>
        <div className="sbf">
          <span className="netpill">NEAR testnet</span>
          <p>Testnet demo. Funds, loans and documents are fictional. TrueNav informs; it does not hold or move funds.</p>
        </div>
      </aside>
      <button className="scrim" aria-label="Close menu" onClick={() => setOpen(false)} />
      <div className="mainwrap">
        <header className="tb">
          <button className="menubtn" aria-expanded={open} onClick={() => setOpen((v) => !v)} aria-label="Menu">☰</button>
          <Search />
          <div className="tbr">
            <span className="netpill" title="Every read and link on this site is NEAR testnet. Nothing is on mainnet.">Testnet</span>
            <LivePill />
            {Wallet ? <Wallet /> : <A href="/account" className="xb sm ghost">View as account</A>}
          </div>
        </header>
        {Ticker ? <div className="tickerslot"><Ticker /></div> : null}
        {state === "offline" ? (
          <div className="banner b-off" role="status">Chain unavailable. Pages show the recorded read from {whenFull(RECORDED.readAt)}, tagged Recorded, never as live. <button className="linkbtn" onClick={() => location.reload()}>Retry</button></div>
        ) : null}
        <main id="main" className="content">{children}</main>
        <footer className="ft">
          <span>Testnet demo. Funds, loans and documents are fictional. Market data from third parties, see <A href="/status">Sources</A>.</span>
          <span>Registry <span className="mono">{short("registry.tnlab-368aa2.testnet", 30, 0)}</span></span>
          <span>TrueNav Labs</span>
        </footer>
      </div>
      <HelpBubble page={p} />
    </div>
  );
}
