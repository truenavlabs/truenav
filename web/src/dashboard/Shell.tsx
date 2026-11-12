import { useState, type ReactNode } from "react";
import { EXAMPLE_ROWS, listFunds } from "../api/client";
import { INFORMS } from "../copy";
import { A } from "../ui";
import { BANDKEY, Chip } from "./parts";

export type Route = "funds" | "fund" | "verify" | "how" | "investor" | "manager";

export function Brand() {
  return (
    <A href="/" className="brand" ariaLabel="TrueNav home">
      <span className="glyph" aria-hidden="true"><i /><i /><i /></span>
      <span className="wm">TrueNav</span>
    </A>
  );
}

export function DashShell({ route, active, crumb, children }: { route: Route; active?: string; crumb: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const funds = listFunds();
  const it = (r: Route, href: string, ix: string, label: string, ct?: number) => (
    <A className={`it${route === r ? " on" : ""}`} href={href}>
      <span className="ix">[{ix}]</span>
      {label}
      {ct !== undefined ? <span className="ct">{ct}</span> : null}
    </A>
  );
  return (
    <div className={`shell${open ? " open" : ""}`}>
      <aside className="side" aria-label="Dashboard">
        <Brand />
        <div className="sidehead lbl">scores</div>
        <nav className="nav">
          {it("funds", "/funds", "1", "Funds", funds.length + EXAMPLE_ROWS.length)}
          <div className="tree">
            {funds.map((f) => (
              <A key={f.token_id} href={`/fund/${f.token_id}`} className={route === "fund" && active === f.token_id ? "on" : undefined}>
                <i className={`dot ${BANDKEY[f.receipt.band] ?? "h"}`} />
                {f.name}
              </A>
            ))}
            {EXAMPLE_ROWS.map((e) => (
              <A key={e.id} href="/funds" className="exl" title="example row, not a fixture, no detail page">
                <i className="dot h" />
                <span>{e.name.replace("Example ", "")}</span>
                <span className="ex">EX</span>
              </A>
            ))}
          </div>
          {it("verify", "/verify", "2", "Receipts", funds.length)}
          {it("how", "/how", "3", "Method")}
        </nav>
        <div className="sidehead lbl">views · grey box</div>
        <nav className="nav">
          {it("investor", "/investor", "4", "Investor")}
          {it("manager", "/manager", "5", "Manager")}
        </nav>
        <div className="sidefoot">
          <div className="lbl">viewing</div>
          <div className="chips">
            <Chip tone="b">public · read only</Chip>
            <Chip>near testnet</Chip>
          </div>
          <p className="note">{INFORMS}</p>
        </div>
      </aside>
      <button className="scrim" aria-label="close menu" onClick={() => setOpen(false)} />
      <main className="main">
        <div className="top">
          <button className="menu chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>menu</button>
          <div className="crumb">{crumb}</div>
          <div className="sp">
            <Chip>synthetic data</Chip>
            <Chip tone="b" dot>FIXTURE · TESTNET</Chip>
            <button className="chip wallet" disabled title="Wallet connect is a stub in this build. It cannot sign or send.">
              wallet · stub
            </button>
          </div>
        </div>
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
