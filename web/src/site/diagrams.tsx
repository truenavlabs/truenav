// Flat SVG diagrams, drawn for this site: one ink, one blue, thin lines, mono labels. No logos, no stock art.
// Every diagram carries a title and a description for screen readers. Colours come from site.css (.dg-*).
import { type ReactNode } from "react";

type Chip = "live" | "v2" | "built" | "planned";
const CHIP: Record<Chip, string> = { live: "live", v2: "live, v2", built: "built, not deployed", planned: "planned, not live" };

function Lines({ x, y, lines, cls = "dg-m", gap = 16 }: { x: number; y: number; lines: string[]; cls?: string; gap?: number }) {
  return <>{lines.map((l, i) => <text key={i} x={x} y={y + i * gap} className={cls}>{l}</text>)}</>;
}

function Box({ x, y, w, h, title, lines, chip, tone = "" }: { x: number; y: number; w: number; h: number; title: string; lines: string[]; chip?: Chip; tone?: "priv" | "dash" | "" }) {
  const cw = chip ? CHIP[chip].length * 6.4 + 14 : 0;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} className={`dg-box ${tone}`} />
      <text x={x + 12} y={y + 22} className={`dg-t ${tone === "priv" ? "inv" : ""}`}>{title}</text>
      <Lines x={x + 12} y={y + 42} lines={lines} cls={`dg-m ${tone === "priv" ? "inv" : ""}`} />
      {chip ? (
        <g>
          <rect x={x + w - cw - 8} y={y + h - 26} width={cw} height={18} className={`dg-chip ${chip}`} />
          <text x={x + w - cw - 8 + cw / 2} y={y + h - 13} textAnchor="middle" className="dg-c">{CHIP[chip]}</text>
        </g>
      ) : null}
    </g>
  );
}

const Defs = ({ id }: { id: string }) => (
  <defs>
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" className="dg-arrow" />
    </marker>
  </defs>
);

function Frame({ id, w, h, title, desc, children }: { id: string; w: number; h: number; title: string; desc: string; children: ReactNode }) {
  return (
    <div className="dg-wrap">
      <svg className="dg" viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={`${id}-t ${id}-d`} style={{ minWidth: Math.min(w, 760) }}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        <Defs id={`${id}-a`} />
        {children}
      </svg>
    </div>
  );
}

/** The problem: a reported NAV with private loans behind it, and one loan pledged twice. */
export function ProblemDiagram() {
  const a = "p-a";
  return (
    <Frame id="dg-problem" w={900} h={300} title="The problem with tokenized fund NAV"
      desc="Left: a fund reports a NAV, but the loans behind it are private and cannot be checked. Right: the same loan can be pledged to two funds and no shared record shows it.">
      <text x="20" y="28" className="dg-h">1. A NAV you cannot trace</text>
      <rect x="60" y="60" width="120" height="190" className="dg-fill" />
      <text x="120" y="52" textAnchor="middle" className="dg-m">reported NAV</text>
      <text x="120" y="272" textAnchor="middle" className="dg-m">what the fund says</text>
      <rect x="260" y="60" width="120" height="190" className="dg-box dash" />
      <text x="320" y="165" textAnchor="middle" className="dg-q">?</text>
      <text x="320" y="52" textAnchor="middle" className="dg-m">loans behind it</text>
      <text x="320" y="272" textAnchor="middle" className="dg-m">private, unchecked</text>
      <line x1="186" y1="155" x2="254" y2="155" className="dg-line" markerEnd={`url(#${a}-a)`} markerStart={`url(#${a}-a)`} />
      <text x="220" y="143" textAnchor="middle" className="dg-m">gap</text>

      <line x1="450" y1="20" x2="450" y2="285" className="dg-dashline" />

      <text x="480" y="28" className="dg-h">2. One loan, two funds</text>
      <rect x="490" y="120" width="110" height="64" className="dg-box" />
      <text x="545" y="148" textAnchor="middle" className="dg-t">one loan</text>
      <text x="545" y="166" textAnchor="middle" className="dg-m">pledged twice</text>
      <rect x="740" y="64" width="130" height="56" className="dg-box" />
      <text x="805" y="97" textAnchor="middle" className="dg-t">Fund A</text>
      <rect x="740" y="184" width="130" height="56" className="dg-box" />
      <text x="805" y="217" textAnchor="middle" className="dg-t">Fund B</text>
      <line x1="604" y1="140" x2="736" y2="98" className="dg-line" markerEnd={`url(#${a}-a)`} />
      <line x1="604" y1="164" x2="736" y2="206" className="dg-line" markerEnd={`url(#${a}-a)`} />
      <text x="640" y="272" className="dg-m">no shared record shows it</text>
    </Frame>
  );
}

/** D1: the end to end stack, with the privacy boundary. */
export function StackDiagram() {
  const a = "d1-a";
  const arrow = { className: "dg-line", markerEnd: `url(#${a}-a)` };
  return (
    <Frame id="dg-stack" w={900} h={440} title="TrueNav end to end stack"
      desc="Private loan documents are read inside a NEAR AI Cloud TEE, which returns a signed verdict only. An OutLayer TEE computes loan fingerprints and cash evidence checks. Both feed contracts on NEAR testnet. The public score engine, the verifier and anyone can read the results. A dashed line marks the privacy boundary. A Base mirror is built but not deployed.">
      <text x="30" y="28" className="dg-h">Private, inside TEEs</text>
      <text x="380" y="28" className="dg-h">Public, on NEAR testnet</text>
      <text x="690" y="28" className="dg-h">Public, anyone</text>
      <line x1="322" y1="14" x2="322" y2="424" className="dg-dashline" />
      <text x="316" y="436" textAnchor="end" className="dg-m">privacy boundary</text>

      <Box x={30} y={56} w={240} h={64} title="Loan documents" lines={["stay with the fund"]} tone="priv" />
      <Box x={30} y={160} w={240} h={92} title="NEAR AI Cloud TEE" lines={["a model reads the document", "and signs a verdict"]} chip="live" />
      <Box x={30} y={292} w={240} h={104} title="OutLayer TEE" lines={["loan fingerprint (HMAC),", "cash evidence checks"]} chip="v2" />

      <Box x={380} y={112} w={240} h={116} title="Registry contract" lines={["pledge, verdict, certificate", "refuses a second pledge"]} chip="live" />
      <Box x={380} y={292} w={240} h={104} title="Receipts contract" lines={["public checks receipt"]} chip="v2" />

      <Box x={690} y={56} w={190} h={80} title="Score engine" lines={["open code, deterministic"]} />
      <Box x={690} y={166} w={190} h={80} title="Verifier" lines={["no key, no account"]} />
      <Box x={690} y={292} w={190} h={104} title="Base mirror" lines={["via Chain Signatures"]} chip="built" tone="dash" />

      <line x1="150" y1="120" x2="150" y2="156" {...arrow} />
      <line x1="270" y1="184" x2="376" y2="184" {...arrow} />
      <text x="276" y="176" className="dg-m">signed verdict</text>
      <text x="276" y="200" className="dg-m">only</text>
      <path d="M270 318H300V218H376" fill="none" {...arrow} />
      <text x="188" y="276" className="dg-m">HMAC loan id</text>
      <line x1="270" y1="344" x2="376" y2="344" {...arrow} />
      <text x="276" y="336" className="dg-m">cash evidence</text>

      <path d="M690 96H500V108" fill="none" className="dg-line" markerEnd={`url(#${a}-a)`} markerStart={`url(#${a}-a)`} />
      <text x="680" y="88" textAnchor="end" className="dg-m">reads chain, writes certificate</text>
      <line x1="686" y1="206" x2="624" y2="206" {...arrow} />
      <text x="634" y="198" className="dg-m">reads</text>
      <line x1="624" y1="344" x2="686" y2="344" className="dg-dashline" markerEnd={`url(#${a}-a)`} />
    </Frame>
  );
}

/** D2: what is revealed to whom at each hop. */
export function RevealDiagram() {
  const a = "d2-a";
  const hops: { t: string; l: string[] }[] = [
    { t: "Loan document", l: ["Seen by the fund", "and the TEE.", "Never on chain."] },
    { t: "TEE model", l: ["Reads the document.", "Trust assumption:", "the TEE hardware", "and its attestation."] },
    { t: "Signed reply", l: ["Verdict only: hash,", "six checks, codes.", "No document text.", "Public once sent."] },
    { t: "Registry contract", l: ["Public on chain:", "verdicts, pledges,", "certificates, fund", "totals, timestamps."] },
    { t: "Anyone", l: ["Score, band, TrueVal,", "TrueRange. Can", "re-check with no key", "and no account."] },
  ];
  return (
    <Frame id="dg-reveal" w={900} h={290} title="What is revealed to whom"
      desc="Five hops: the loan document is seen by the fund and the TEE only. The TEE model reads it. The signed reply holds a verdict only and becomes public once sent. The registry contract holds public verdicts, pledges and certificates. Anyone can read the score and re-check it with no key.">
      <rect x="20" y="40" width="352" height="204" className="dg-zone" />
      <text x="30" y="30" className="dg-h">Private</text>
      <text x="562" y="30" className="dg-h">Public</text>
      {hops.map((h, i) => {
        const x = 20 + i * 176;
        return (
          <g key={h.t}>
            <rect x={x + 8} y={56} width={150} height={44} className={`dg-box ${i === 1 ? "priv" : ""}`} />
            <text x={x + 83} y={83} textAnchor="middle" className={`dg-t ${i === 1 ? "inv" : ""}`}>{h.t}</text>
            <Lines x={x + 8} y={126} lines={h.l} />
            {i < 4 ? <line x1={x + 160} y1={78} x2={x + 182} y2={78} className="dg-line" markerEnd={`url(#${a}-a)`} /> : null}
          </g>
        );
      })}
      <line x1="372" y1="40" x2="372" y2="244" className="dg-dashline" />
      <text x="450" y="272" textAnchor="middle" className="dg-m">A TEE proves which code ran, not that the model is right.</text>
    </Frame>
  );
}

/** Roadmap timeline. The list under it on the page carries the detail. */
export function RoadmapDiagram() {
  const cols: { x: number; h: string; chip: string; items: string[]; live?: boolean }[] = [
    { x: 20, h: "Now", chip: "live on testnet", live: true, items: ["Registry and pledge lock", "TEE verdicts on chain", "Public score engine", "Verifier, no key"] },
    { x: 320, h: "Next", chip: "planned, not live", items: ["Correlated defaults model", "Receipts v3 deployed", "Base mirror deployed", "Manager-signed NAV", "Certificates from a TEE key", "Reproducible registry build"] },
    { x: 620, h: "Later", chip: "planned, not live", items: ["Liability oracle", "Wallet sign-in for managers", "Pilots on a fund's own data"] },
  ];
  return (
    <Frame id="dg-roadmap" w={900} h={270} title="TrueNav roadmap timeline"
      desc="Three horizons. Now: the registry and pledge lock, TEE verdicts on chain, the public score engine and the verifier, all live on testnet. Next and Later are planned and not live.">
      <line x1="20" y1="58" x2="880" y2="58" className="dg-line" />
      {cols.map((c) => (
        <g key={c.h}>
          <circle cx={c.x + 8} cy={58} r={7} className={c.live ? "dg-dot on" : "dg-dot"} />
          <text x={c.x + 24} y={32} className="dg-big">{c.h}</text>
          <text x={c.x + 24} y={50} className="dg-m">{c.chip}</text>
          {c.items.map((t, i) => (
            <g key={t}>
              <line x1={c.x + 8} y1={86 + i * 28 - 5} x2={c.x + 18} y2={86 + i * 28 - 5} className="dg-line" />
              <text x={c.x + 26} y={86 + i * 28} className={c.live ? "dg-t" : "dg-t soft"}>{t}</text>
            </g>
          ))}
        </g>
      ))}
    </Frame>
  );
}
