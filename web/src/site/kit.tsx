// Building blocks for the marketing pages. Plain markup, classes live in site.css under .mk-*.
import { type ReactNode } from "react";
import { A } from "../ui";

export type Status = "live" | "live-v2" | "built" | "planned" | "demo" | "pinned" | "limit";
const STATUS: Record<Status, [string, string]> = {
  live: ["live on testnet", "g"],
  "live-v2": ["live, v2", "g"],
  built: ["built, not deployed", "y"],
  pinned: ["pinned, not deployed", "y"],
  planned: ["planned, not live", "ex"],
  demo: ["demo", "b"],
  limit: ["limit", "r"],
};

export const Chip = ({ s, children }: { s: Status; children?: ReactNode }) => (
  <span className={`chip ${STATUS[s][1]}`}>{children ?? STATUS[s][0]}</span>
);

export function Hero({ label, title, lead, actions, children }: { label: string; title: ReactNode; lead: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mk-hero">
      <div className="mk-in">
        <span className="lbl">{label}</span>
        <h1>{title}</h1>
        <p className="mk-lead">{lead}</p>
        {actions ? <div className="mk-actions">{actions}</div> : null}
        {children}
      </div>
    </section>
  );
}

export function Band({ id, tone = "white", label, title, lead, children }: { id?: string; tone?: "white" | "tint" | "dark"; label?: string; title?: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section id={id} className={`mk-band ${tone}`}>
      <div className="mk-in">
        {label || title || lead ? (
          <header className="mk-head">
            {label ? <span className="lbl">{label}</span> : null}
            {title ? <h2>{title}</h2> : null}
            {lead ? <p className="mk-lead">{lead}</p> : null}
          </header>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export const Grid = ({ cols = 3, children }: { cols?: 2 | 3 | 4; children: ReactNode }) => <div className={`mk-grid c${cols}`}>{children}</div>;

export function Card({ label, title, chip, children, href, cta }: { label?: string; title: ReactNode; chip?: Status; children?: ReactNode; href?: string; cta?: string }) {
  return (
    <article className="mk-card">
      <div className="mk-card-top">
        {label ? <span className="lbl">{label}</span> : <span />}
        {chip ? <Chip s={chip} /> : null}
      </div>
      <h3>{title}</h3>
      <div className="mk-card-b">{children}</div>
      {href ? <A href={href} className="mk-more mono">{cta ?? "Read more"} <span aria-hidden="true">→</span></A> : null}
    </article>
  );
}

export const Num = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <li className="mk-step">
    <span className="mk-step-n mono" aria-hidden="true">{String(n).padStart(2, "0")}</span>
    <div><h3>{title}</h3><p>{children}</p></div>
  </li>
);

export const Steps = ({ children }: { children: ReactNode }) => <ol className="mk-steps">{children}</ol>;

export function Figure({ children, caption, wide }: { children: ReactNode; caption: ReactNode; wide?: boolean }) {
  return (
    <figure className={`mk-fig${wide ? " wide" : ""}`}>
      <div className="mk-fig-in">{children}</div>
      <figcaption className="mono">{caption}</figcaption>
    </figure>
  );
}

/** A real screenshot of our own app. Always captioned as demo data. */
export function Shot({ src, alt, w, h, caption = "demo funds, NEAR testnet" }: { src: string; alt: string; w: number; h: number; caption?: string }) {
  return (
    <figure className="mk-shot">
      <img src={src} alt={alt} width={w} height={h} loading="lazy" decoding="async" />
      <figcaption className="mono">{caption}</figcaption>
    </figure>
  );
}

export function Table({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <div className="mk-tw">
      <table className="mk-table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} data-l={head[j]}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export const Facts = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="mk-facts mono">
    {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
  </dl>
);

export const Code = ({ children }: { children: string }) => <pre className="mk-code mono"><code>{children}</code></pre>;

export const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} className="ln" target="_blank" rel="noopener noreferrer">{children} ↗</a>
);

export const Note = ({ children, label = "honest limit" }: { children: ReactNode; label?: string }) => (
  <aside className="mk-note"><span className="lbl">{label}</span><p>{children}</p></aside>
);

export function Cta({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <section className="cta-band">
      <div><span className="lbl">{label}</span><h2>{title}</h2></div>
      <div className="cta-a">{children}</div>
    </section>
  );
}

export const Pill = ({ href, children, kind = "" }: { href: string; children: ReactNode; kind?: string }) => (
  <A href={href} className={`pillbtn ${kind}`.trim()}>{children}</A>
);
export const PillExt = ({ href, children, kind = "" }: { href: string; children: ReactNode; kind?: string }) => (
  <a href={href} className={`pillbtn ${kind}`.trim()} target="_blank" rel="noopener noreferrer">{children}</a>
);
