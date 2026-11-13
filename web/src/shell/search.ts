// Keyless search over the FAQ and glossary (BM25, no dependency). Used by the help bubble's Ask tab and the FAQ page.
import { FAQ } from "../content/faq";
import { GLOSSARY } from "../content/glossary";

export type Doc = { id: string; kind: "faq" | "term"; title: string; text: string; href: string; src: string };

export const DOCS: Doc[] = [
  ...FAQ.map((f) => ({ id: `faq-${f.id}`, kind: "faq" as const, title: f.q, text: f.a, href: `/faq#${f.id}`, src: f.src })),
  ...GLOSSARY.map((t) => ({ id: `term-${t.id}`, kind: "term" as const, title: t.term, text: t.text, href: `/glossary#${t.id}`, src: "Glossary" })),
];

const STOP = new Set("a an the is are was were be to of and or in on for with by it this that what how why who do does can i my me we our you your at as from not".split(" "));
export const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, ""));

const index = DOCS.map((d) => {
  const toks = tokens(`${d.title} ${d.title} ${d.text}`);
  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  return { d, tf, len: toks.length };
});
const avg = index.reduce((s, x) => s + x.len, 0) / index.length;
const df = new Map<string, number>();
for (const x of index) for (const t of x.tf.keys()) df.set(t, (df.get(t) || 0) + 1);

export function search(q: string, k = 3): Doc[] {
  const qs = [...new Set(tokens(q))];
  if (!qs.length) return [];
  const N = index.length, k1 = 1.4, b = 0.75;
  return index
    .map((x) => {
      let s = 0;
      for (const t of qs) {
        const f = x.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * x.len) / avg));
      }
      return { d: x.d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.d);
}
