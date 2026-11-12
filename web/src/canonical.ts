// Same key sort as api/receipt.mjs canonical. Local only.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((item) => canonical(item)).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
