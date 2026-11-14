// Marketing chrome: slim testnet notice, top nav (Product, Technology, Built on NEAR, Docs, About, plus two buttons) and footer.
// The dashboard keeps its own DashShell. Nothing here shows partner logos or traction counters.
import { useEffect, useState, type ReactNode } from "react";
import { Brand } from "../shell/Brand";
import { A } from "../ui";

export const REPO = "https://github.com/truenavlabs/truenav";
export const ISSUES = `${REPO}/issues`;
export const WHITEPAPER_PDF = "/TrueNav-Whitepaper.pdf";
export const NOTICE = "Testnet demo. All funds and data are fictional.";

export type SiteRoute =
  | "product" | "investors" | "managers" | "technology" | "built-on-near" | "methodology" | "security" | "evidence"
  | "roadmap" | "docs" | "about" | "pilot" | "story";

type Sub = { href: string; label: string; external?: boolean };
type Item = { id: string; href: string; label: string; also?: SiteRoute[]; sub?: Sub[] };

export const NAV: Item[] = [
  {
    id: "product", href: "/product", label: "Product", also: ["investors", "managers"],
    sub: [{ href: "/investors", label: "For investors" }, { href: "/managers", label: "For fund managers" }],
  },
  { id: "technology", href: "/technology", label: "Technology" },
  { id: "built-on-near", href: "/built-on-near", label: "Built on NEAR" },
  {
    id: "docs", href: "/docs", label: "Docs", also: ["methodology", "security", "evidence", "roadmap"],
    sub: [
      { href: WHITEPAPER_PDF, label: "Whitepaper (PDF)", external: true },
      { href: "/methodology", label: "Methodology" },
      { href: "/security", label: "Privacy and security" },
      { href: "/evidence", label: "Evidence" },
      { href: "/roadmap", label: "Roadmap" },
      { href: REPO, label: "Source code", external: true },
    ],
  },
  { id: "about", href: "/about", label: "About" },
];

/** The slim strip above every marketing page. */
export function Notice() {
  return (
    <div className="tn-notice mono" role="note">
      <span>{NOTICE}</span>
      <A href="/security#real">What is real</A>
    </div>
  );
}

function SubLink({ s }: { s: Sub }) {
  return s.external ? (
    <a href={s.href} target="_blank" rel="noopener noreferrer">{s.label}{s.href.startsWith("http") ? " ↗" : ""}</a>
  ) : (
    <A href={s.href}>{s.label}</A>
  );
}

export function SiteNav({ route, tone = "light" }: { route?: SiteRoute; tone?: "light" | "dark" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <header className={`snav ${tone}${open ? " open" : ""}`}>
      <Brand />
      <button className="snav-menu mono" aria-expanded={open} aria-controls="site-links" onClick={() => setOpen((v) => !v)}>
        {open ? "close" : "menu"}
      </button>
      <nav id="site-links" aria-label="Site">
        {NAV.map((l) => {
          const on = route === l.id || (!!route && !!l.also?.includes(route));
          return (
            <div key={l.id} className={`snav-i${l.sub ? " has-sub" : ""}`}>
              <A href={l.href} className={`snav-l${on ? " on" : ""}`} ariaCurrent={route === l.id ? "page" : undefined}>
                <i aria-hidden="true" />
                {l.label}
              </A>
              {l.sub ? (
                <div className="snav-sub">
                  {l.sub.map((s) => <SubLink key={s.href} s={s} />)}
                </div>
              ) : null}
            </div>
          );
        })}
        <A href="/pilot" className={`pillbtn ghost snav-pilot${route === "pilot" ? " on" : ""}`}>Request a pilot</A>
        <A href="/overview" className="pillbtn">Open demo <span aria-hidden="true">→</span></A>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="sfoot">
      <div className="sfoot-in">
        <div className="sfoot-b">
          <Brand />
          <p>Private verification for tokenized credit on NEAR. Built at NEAR HACKATHON 2026 by TrueNav Labs.</p>
          <p className="sfoot-informs">TrueNav informs only. It is not a rating agency, it is not investment advice, and it never moves or blocks money.</p>
        </div>
        <nav className="sfoot-c mono" aria-label="Product">
          <span className="lbl">product</span>
          <A href="/product">Product</A>
          <A href="/investors">For investors</A>
          <A href="/managers">For fund managers</A>
          <A href="/technology">Technology</A>
          <A href="/built-on-near">Built on NEAR</A>
        </nav>
        <nav className="sfoot-c mono" aria-label="Docs">
          <span className="lbl">docs</span>
          <A href="/docs">Docs</A>
          <A href="/methodology">Methodology</A>
          <A href="/security">Privacy and security</A>
          <A href="/evidence">Evidence</A>
          <A href="/roadmap">Roadmap</A>
        </nav>
        <nav className="sfoot-c mono" aria-label="Company">
          <span className="lbl">company</span>
          <A href="/about">About</A>
          <A href="/pilot">Request a pilot</A>
          <A href="/overview">Open demo app</A>
          <a href={WHITEPAPER_PDF} target="_blank" rel="noopener noreferrer">Whitepaper</a>
          <a href={REPO} rel="noopener noreferrer" target="_blank">Source code ↗</a>
        </nav>
      </div>
      <div className="sfoot-meta mono">
        <span>NEAR TESTNET · FICTIONAL FUNDS AND DATA</span>
        <span>© 2026 TrueNav Labs · MIT licence</span>
      </div>
    </footer>
  );
}

/** A marketing page: notice, nav, content, then the footer. Pages that bring their own footer pass `bare`. */
export function SitePage({ route, tone, className, bare, children }: { route: SiteRoute; tone?: "light" | "dark"; className?: string; bare?: boolean; children: ReactNode }) {
  return (
    <div className={`site ${className ?? ""}`}>
      <Notice />
      <SiteNav route={route} tone={tone} />
      <main id="main">{children}</main>
      {bare ? null : <SiteFooter />}
    </div>
  );
}
