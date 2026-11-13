// Security headers and CSP in web/vercel.json. Static checks; scripts/csp-check.mjs runs the built site in Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEEDS } from "../data/feeds/feeds.mjs";
import { BACKUP_RPCS, DEFAULT_RPC } from "../chain.mjs";
import { siteHeaders } from "../scripts/csp-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const headers = siteHeaders(config);
const csp = Object.fromEntries(
  headers["Content-Security-Policy"].split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values];
  }),
);
const origin = (u) => new URL(u).origin;

test("vercel.json keeps the SPA rewrite and the assist function config", () => {
  assert.deepEqual(config.rewrites, [{ source: "/((?!api/).*)", destination: "/index.html" }]);
  assert.ok(config.functions["api/assist.mjs"]);
  assert.ok(existsSync(join(root, "api", "assist.mjs")));
  assert.equal(config.functions["api/assist.mjs"].includeFiles, "src/content/**");
});

test("every page gets the security headers", () => {
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
  assert.match(headers["Strict-Transport-Security"], /^max-age=\d{8,}/);
  for (const f of ["camera=()", "microphone=()", "geolocation=()"]) assert.ok(headers["Permissions-Policy"].includes(f), f);
});

test("CSP locks the dangerous directives", () => {
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["base-uri"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepEqual(csp["form-action"], ["'self'"]);
  assert.equal(csp["script-src"][0], "'self'");
  for (const [name, values] of Object.entries(csp)) {
    for (const v of values) {
      assert.notEqual(v, "*", `${name} has a wildcard`);
      assert.equal(/^(https?|wss?):$/.test(v), false, `${name} allows a whole scheme: ${v}`);
      assert.equal(v.includes("*"), false, `${name} has a wildcard host: ${v}`);
      assert.notEqual(v, "'unsafe-eval'", `${name} allows eval`);
      assert.equal(v.startsWith("http:"), false, `${name} allows plain http: ${v}`);
    }
  }
});

test("script-src is 'self' plus the wallet iframe nonce, no 'unsafe-inline'", () => {
  const ts = readFileSync(join(root, "src", "lib", "wallet.ts"), "utf8");
  const nonce = ts.match(/WALLET_CSP_NONCE = "([A-Za-z0-9+/=]+)"/)?.[1];
  assert.ok(nonce && nonce.length >= 22, "wallet.ts exports a nonce of at least 128 bits");
  assert.match(ts, /cspNonce: WALLET_CSP_NONCE/);
  assert.deepEqual(csp["script-src"], ["'self'", `'nonce-${nonce}'`]);
});

test("connect-src allows every RPC and every live feed host the browser calls", () => {
  const allowed = new Set(csp["connect-src"]);
  for (const u of [DEFAULT_RPC, ...BACKUP_RPCS]) assert.ok(allowed.has(origin(u)), u);
  for (const [id, f] of Object.entries(FEEDS)) {
    if (id === "defillama-pool-chart") continue; // not polled in the browser (src/depth/impl.tsx)
    assert.ok(allowed.has(origin(f.url)), `${id} ${f.url}`);
  }
  // api.frankfurter.app answers 301 to api.frankfurter.dev, and CSP checks the redirect target too.
  assert.ok(allowed.has("https://api.frankfurter.dev"));
});

test("connect-src allows the near-connect wallet manifest and executor hosts", () => {
  for (const h of ["https://raw.githubusercontent.com", "https://cdn.jsdelivr.net"]) assert.ok(csp["connect-src"].includes(h), h);
});

// web/node_modules is not installed for the root npm test in CI; the check runs where it is.
const connectorJs = join(root, "node_modules", "@hot-labs", "near-connect", "build", "NearConnector.js");
test("connect-src allows the manifest hosts in the installed near-connect build", { skip: existsSync(connectorJs) ? false : "web/node_modules not installed" }, () => {
  const src = readFileSync(connectorJs, "utf8");
  const manifests = [...src.matchAll(/"(https:\/\/[^"]+manifest\.json)"/g)].map((m) => origin(m[1]));
  assert.ok(manifests.length >= 1);
  for (const m of manifests) assert.ok(csp["connect-src"].includes(m), m);
});
