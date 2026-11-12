// Marketing chrome: top nav (uppercase mono links, active dot, open app button) and footer.
// The dashboard keeps its own DashShell. Verify is the receipt checker inside the app, so its link leaves this shell.
import { useEffect, useState, type ReactNode } from "react";
import { Brand } from "../shell/Brand";
import { A } from "../ui";

export type SiteRoute = "product" | "technology" | "about";
export const REPO = "https://github.com/truenavlabs/truenav";

const LINKS: { id: SiteRoute | "verify"; href: string; label: string }[] = [
  { id: "product", href: "/product", label: "Product" },
  { id: "technology", href: "/technology", label: "Technology" },
  { id: "verify", href: "/verify", label: "Verify" },
  { id: "about", href: "/about", label: "About" },
];

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
        {LINKS.map((l) => (
          <A key={l.id} href={l.href} className={`snav-l${route === l.id ? " on" : ""}`} ariaCurrent={route === l.id ? "page" : undefined}>
            <i aria-hidden="true" />
            {l.label}
          </A>
        ))}
        <A href="/overview" className="pillbtn">Open app <span aria-hidden="true">→</span></A>
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
        </div>
        <nav className="sfoot-c mono" aria-label="Footer">
          <span className="lbl">site</span>
          <A href="/">Home</A>
          <A href="/product">Product</A>
          <A href="/technology">Technology</A>
          <A href="/about">About</A>
        </nav>
        <nav className="sfoot-c mono" aria-label="App">
          <span className="lbl">app</span>
          <A href="/funds">Funds</A>
          <A href="/verify">Verify a receipt</A>
          <A href="/methodology">Method</A>
          <a href={REPO} rel="noopener noreferrer" target="_blank">Source code ↗</a>
        </nav>
      </div>
      <div className="sfoot-meta mono">
        <span>NEAR TESTNET · SYNTHETIC DATA · every fund, loan and figure is fictional</span>
        <span>© 2026 TrueNav Labs</span>
      </div>
    </footer>
  );
}

export function SitePage({ route, tone, className, children }: { route: SiteRoute; tone?: "light" | "dark"; className?: string; children: ReactNode }) {
  return (
    <div className={`site ${className ?? ""}`}>
      <SiteNav route={route} tone={tone} />
      <main id="main">{children}</main>
    </div>
  );
}
