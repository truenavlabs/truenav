// Display helpers shared by the depth modules. No React, no node: imports.

export function formatUsdFromCents(cents, digits = 0) {
  if (cents === null || cents === undefined || cents === "") return "";
  const n = Number(cents) / 100;
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function formatUsd(amount, digits = 2) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(amount));
}

export function formatCompactUsd(amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

export function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  const n = Number(value);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function shortHash(hash) {
  if (!hash || typeof hash !== "string") return "";
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function bpsToPct(bps) {
  if (bps === null || bps === undefined) return "";
  return `${(Number(bps) / 100).toFixed(2)}%`;
}
