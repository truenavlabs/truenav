import { useMemo, useState } from "react";
import { FAQ } from "../content/faq";
import { A } from "../ui";
import { PageHead, Panel } from "../shell/kit";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");

export default function Faq({ q }: { q: string }) {
  const [query, setQuery] = useState(q);
  const shown = useMemo(() => {
    const words = norm(query).split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return FAQ;
    return FAQ.map((f) => ({ f, s: words.filter((w) => norm(`${f.q} ${f.a}`).includes(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.f);
  }, [query]);
  const groups = ["Investors", "Fund managers", "Technical"] as const;
  return (
    <>
      <PageHead title="Questions and answers" lead={<>Every answer comes from the repository docs; the source file is under each answer. Not answered here? See <A href="/support">Support</A>.</>} />
      <input className="ctl" style={{ width: "100%", maxWidth: 520 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the questions" aria-label="Search the questions" />
      {query && !shown.length ? <p className="dim mt">No question matches. Try the <A href="/glossary">Glossary</A>.</p> : null}
      {groups.map((g) => {
        const items = shown.filter((f) => f.group === g);
        if (!items.length) return null;
        return (
          <Panel key={g} className="mt" title={g} pad={false}>
            {items.map((f) => (
              <details key={f.id} id={f.id} className="faqi" open={!!query || location.hash === `#${f.id}`}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
                <div className="dim small">Source: {f.src}</div>
              </details>
            ))}
          </Panel>
        );
      })}
    </>
  );
}
