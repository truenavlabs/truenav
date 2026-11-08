// Canonical JSON (spec/v2/SPEC.md sections 8.1 and 10): keys sorted at every level, no whitespace, integers only.
// The Rust/WASM port must produce these exact bytes for the parity fixtures.
export function canonical(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`canonical JSON allows safe integers only, got ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON cannot encode ${typeof v}`);
}
