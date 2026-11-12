// Table to CSV. Cells that start with = + - @ (or tab, CR) are prefixed with a quote so a spreadsheet never runs them
// as formulas (CSV injection). Browser download helper is separate so this stays testable in Node.
const RISKY = /^[=+\-@\t\r]/;

export function cell(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (RISKY.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: objects; columns: [key, header] pairs or keys. */
export function toCsv(rows, columns) {
  const cols = (columns || Object.keys(rows[0] || {})).map((c) => (Array.isArray(c) ? c : [c, c]));
  const lines = [cols.map(([, h]) => cell(h)).join(",")];
  for (const r of rows) lines.push(cols.map(([k]) => cell(typeof k === "function" ? k(r) : r[k])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Browser only: save text as a file. */
export function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
