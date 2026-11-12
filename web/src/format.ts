export function centsLabel(value: string | null): string {
  if (value === null) return "null";
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) return value;
  const neg = value.startsWith("-");
  const digits = neg ? value.slice(1) : value;
  const padded = digits.padStart(3, "0");
  const whole = padded.slice(0, -2);
  const frac = padded.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}.${frac} USD`;
}

export function bpsLabel(value: number | null): string {
  if (value === null) return "null";
  return `${value} bps`;
}

export function listLabel(values: readonly string[]): string {
  return values.length ? values.join(", ") : "none";
}

// Money fields are integer cents. Shown in millions of dollars with two decimals: 950000000 -> $9.50M.
export const millions = (cents: string | number) => Number(cents) / 1e8;
export function usdM(cents: string | number, digits = 2): string {
  const v = millions(cents);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(digits)}M`;
}
export const usdMv = (m: number, digits = 2) => `${m < 0 ? "-" : ""}$${Math.abs(m).toFixed(digits)}M`;

const HUMAN: Record<string, string> = {
  zero: "none", one: "1", suppressed: "suppressed", lt_5: "under 5", inside: "inside", high: "high", medium: "medium",
  low: "low", none: "none", lte_24h: "up to 24 h", gt_24_lte_72h: "24 to 72 h", gte_98_lte_100pct: "98 to 100%",
  gte_0_lt_3pp: "0 to 3 pp", gte_90pct: "90% or more", gt_0_lte_10pct: "above 0 to 10%", gt_10_lte_25pct: "10 to 25%",
  gt_25pct: "above 25%", gt_5_lte_10pct: "5 to 10%", gt_0_lte_5pct: "0 to 5%",
  // The page cannot recheck cash evidence, so it reports the engine's status in its own words.
  verified: "engine-checked",
  complete: "complete", clear: "clear", outside_high: "outside, above high", outside_low: "outside, below low",
};
export function human(b: string | number | null | undefined): string {
  if (b === null || b === undefined) return "n/a";
  const s = String(b);
  if (HUMAN[s] !== undefined) return HUMAN[s];
  const m = /^from_(\d+)_to_(\d+)$/.exec(s);
  if (m) return `${m[1]} to ${m[2]}`;
  return s.replace(/_/g, " ");
}
export const shortHash = (h: string, a = 10, z = 6) => (h.length > a + z ? `${h.slice(0, a)}…${h.slice(-z)}` : h);
