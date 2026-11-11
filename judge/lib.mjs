// Small helpers for the replay judge: run a step, read node:test TAP output, canonical JSON, and a schema check.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// Sorted keys, no whitespace. Only plain JSON values reach it.
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

// Runs one command to completion. Never throws: a spawn error, a signal or a timeout comes back as a failed result.
export function runStep(cmd, args, { cwd, env, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let stdout = "", stderr = "", timedOut = false, spawnError = null;
    let p;
    try {
      p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, signal: null, stdout, stderr, ms: 0, timedOut, spawnError: e.message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", (e) => { spawnError = e.message; });
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6, timedOut, spawnError });
    });
  });
}

// Top-level results of `node --test --test-reporter=tap`, plus the summary counts.
export function parseTap(out) {
  const tests = [];
  for (const line of out.split("\n")) {
    const m = /^(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b\s*(.*))?$/.exec(line);
    if (m) tests.push({ ok: m[1] === "ok", name: m[2], directive: m[3] || null, reason: m[4] || "" });
  }
  const count = (k) => { const m = new RegExp(`^# ${k} (\\d+)$`, "m").exec(out); return m ? Number(m[1]) : null; };
  return { tests, counts: { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo"), cancelled: count("cancelled") } };
}

// Counts and skipped test names from either the spec or the TAP reporter (npm test uses the default reporter).
export function parseAnyReport(out) {
  const tap = parseTap(out);
  if (tap.counts.tests !== null) return { counts: tap.counts, skipped: tap.tests.filter((t) => t.directive === "SKIP").map((t) => ({ test: t.name, reason: t.reason })) };
  const count = (k) => { const m = new RegExp(`^\\S+ ${k} (\\d+)$`, "m").exec(out); return m ? Number(m[1]) : null; };
  const skipped = [];
  for (const line of out.split("\n")) {
    // the spec reporter marks a skipped test with U+FE63 and puts the skip reason after " # "
    const m = /^\s*\u{FE63} (.*?) \([\d.]+m?s\)(?: # (.*))?$/u.exec(line);
    if (m) skipped.push({ test: m[1].trim(), reason: (m[2] || "").trim() });
  }
  return { counts: { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo"), cancelled: count("cancelled") }, skipped };
}

// The subset of JSON Schema that judge/summary.schema.json uses: type, const, enum, pattern, minimum, required,
// properties, additionalProperties false, items, minItems, maxItems. Returns a list of problems, empty when valid.
export function validate(schema, v, at = "$") {
  const out = [];
  const typeOf = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);
  if (schema.type) {
    const types = [].concat(schema.type);
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${at}: type ${t}, want ${types.join("|")}`];
  }
  if ("const" in schema && canonical(schema.const) !== canonical(v)) out.push(`${at}: not the const value`);
  if (schema.enum && !schema.enum.some((e) => canonical(e) === canonical(v))) out.push(`${at}: not in enum`);
  if (schema.pattern && typeof v === "string" && !new RegExp(schema.pattern).test(v)) out.push(`${at}: does not match ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof v === "number" && v < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
  if (typeOf(v) === "object") {
    for (const k of schema.required || []) if (!(k in v)) out.push(`${at}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties && k in schema.properties) out.push(...validate(schema.properties[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}: unexpected ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...validate(schema.additionalProperties, x, `${at}.${k}`));
    }
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => out.push(...validate(schema.items, x, `${at}[${i}]`)));
  }
  return out;
}
