// Provenance tags. Every number the web app shows carries exactly one of these (spec section 3A).
// Framework-free: the layout reads TAG_INFO for the chip text and hover; nothing here renders.

export const TAGS = Object.freeze(["live", "recorded", "computed", "demo", "external"]);

export const TAG_INFO = Object.freeze({
  live: { label: "Live", hint: "Read from the NEAR testnet registry over public RPC during this page load." },
  recorded: { label: "Recorded", hint: "From a committed evidence file, shown with its date. Not re-run in the browser." },
  computed: { label: "Computed", hint: "Computed in this browser from other tagged inputs." },
  demo: { label: "Demo", hint: "Fictional data from a committed generator. Never on chain, never feeds a live headline." },
  external: { label: "External", hint: "Third-party market data, for context only. Never feeds a TrueNav number." },
});

/** A tagged value: { value, tag, source, at? }. source names the exact view call, file, endpoint or generator rule. */
export function tagged(value, tag, source, at) {
  if (!TAGS.includes(tag)) throw new Error(`unknown tag ${tag}`);
  const out = { value, tag, source: String(source || "") };
  if (at !== undefined) out.at = at;
  return Object.freeze(out);
}

// Strongest first. A computed value inherits the weakest input it was computed from.
const RANK = { live: 0, recorded: 1, computed: 2, external: 3, demo: 4 };

/** The weakest of the input tags: a computation that touched demo data is computed (demo). */
export function weakest(tags) {
  const list = (tags || []).filter((t) => t in RANK);
  if (!list.length) return null;
  return list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** Label for a computed value: "computed" or "computed (demo)" when a demo input was used. */
export function computedLabel(inputTags) {
  const w = weakest(inputTags);
  return w === "demo" || w === "external" ? `computed (${w})` : "computed";
}
