// The "?" help bubble on every app page. Ask (keyless FAQ search, or the AI backend when a slot provides one), FAQ, Glossary.
import { useEffect, useRef, useState } from "react";
import { FAQ } from "../content/faq";
import { GLOSSARY } from "../content/glossary";
import { A } from "../ui";
import { search, type Doc } from "./search";
import { SLOTS } from "./slots";

type Tab = "ask" | "faq" | "glossary";

export function HelpBubble({ page }: { page: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("ask");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Doc[] | null>(null);
  const [ai, setAi] = useState<{ answer: string; sources: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const ask = async () => {
    const question = q.trim().slice(0, 500);
    if (!question) return;
    setHits(search(question, 3));
    setAi(null);
    if (SLOTS.ask) {
      setBusy(true);
      try {
        setAi(await SLOTS.ask(question, page));
      } catch {
        setAi(null);
      } finally {
        setBusy(false);
      }
    }
  };
  return (
    <>
      <button className={`helpfab${open ? " on" : ""}`} aria-label={open ? "Close help" : "Open help"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "×" : "?"}
      </button>
      {open ? (
        <div className="helppanel" role="dialog" aria-label="Help">
          <div className="hp-tabs" role="tablist">
            {(["ask", "faq", "glossary"] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : undefined} onClick={() => setTab(t)}>{t === "ask" ? "Ask" : t === "faq" ? "FAQ" : "Glossary"}</button>
            ))}
          </div>
          <div className="hp-body">
            {tab === "ask" ? (
              <>
                <form onSubmit={(e) => { e.preventDefault(); void ask(); }} className="hp-ask">
                  <input ref={inputRef} value={q} maxLength={500} onChange={(e) => setQ(e.target.value)} placeholder="Ask about TrueNav, a score, a check..." aria-label="Question" />
                  <button className="xb sm" type="submit">Ask</button>
                </form>
                {!SLOTS.ask ? <p className="hp-note">AI answers are off in this build. These are the closest answers from the TrueNav docs, searched in your browser.</p> : <p className="hp-note">Do not paste personal data.</p>}
                {busy ? <p className="dim">Thinking...</p> : null}
                {ai ? <div className="hp-ai"><p>{ai.answer}</p><small className="dim">Sources: {ai.sources.join(", ")}</small></div> : null}
                {hits && hits.length === 0 ? <p className="dim">Nothing in the docs matches. Try the FAQ tab, or see <A href="/support">Support</A>.</p> : null}
                {hits?.map((h) => (
                  <div className="hp-hit" key={h.id}>
                    <A href={h.href}><b>{h.title}</b></A>
                    <p>{h.text}</p>
                    <small className="dim">Source: {h.src}</small>
                  </div>
                ))}
                {!hits ? (
                  <div className="hp-sugg">
                    {["What does a red score mean?", "How do documents stay private?", "What is a double pledge?", "Who signs the certificate?"].map((s) => (
                      <button key={s} className="chipbtn" onClick={() => { setQ(s); setHits(search(s, 3)); }}>{s}</button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : tab === "faq" ? (
              <ul className="hp-list">{FAQ.map((f) => <li key={f.id}><details><summary>{f.q}</summary><p>{f.a}</p></details></li>)}</ul>
            ) : (
              <dl className="hp-gl">{GLOSSARY.map((t) => <div key={t.id}><dt>{t.term}</dt><dd>{t.text}</dd></div>)}</dl>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
