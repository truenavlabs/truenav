import { GLOSSARY } from "../content/glossary";
import { A } from "../ui";
import { PageHead } from "../shell/kit";

export default function Glossary() {
  const terms = [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term));
  return (
    <>
      <PageHead title="Glossary" lead={`${terms.length} terms used on this site. The "?" next to a metric opens the same text.`} />
      <dl className="gloss">
        {terms.map((t) => (
          <div key={t.id} id={t.id} className="gterm">
            <dt>{t.term}</dt>
            <dd>{t.text}{t.link ? <> <A href={t.link}>More</A></> : null}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
