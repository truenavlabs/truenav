// NEAR AI Cloud attestation check with a fresh nonce, following the NEAR AI Cloud verification docs
// (docs.near.ai/cloud/verification/reference/quote-nonce-signer and cloud-api/model-attestations).
//
// For the gateway report and every NEAR model-attestation candidate it checks:
//   Intel TDX quote (dcap-qvl, collateral from Phala PCCS) and TCB status, TDX debug mode off,
//   report data binds the signing address and our nonce, echoed nonce, MRCONFIGID matches app_compose,
//   RTMR3 matches the replayed event log; for model reports also the NVIDIA GPU evidence (NRAS verdict).
// It returns a checklist the UI can show as a "Verified" panel, and the attested model signing address.
//
// A key is sent only when NEAR_AI_CLOUD_API_KEY or NEARAI_API_KEY is set. With no key, the request has no
// Authorization header. A dummy bearer is not sent. Docs: a key that is sent must be valid; no header is a public read.
import { createHash, randomBytes } from "node:crypto";
import { getCollateralAndVerify } from "@phala/dcap-qvl";

export const API = "https://cloud-api.near.ai/v1";
export const MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
/// The default model for `npm run tee:attest` and `npm run tee:underwrite` is MODEL (the model the live verdicts are
/// signed by). NEAR_AI_MODEL, then TRUENAV_ATTEST_MODEL, override it.
export const ACCEPTED_TCB = ["UpToDate"];
const API_KEY = process.env.NEAR_AI_CLOUD_API_KEY || process.env.NEARAI_API_KEY || "";

export function authHeaders() {
  const headers = { "x-no-aliasing": "true" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  return headers;
}

export function modelFromEnv(fallback = MODEL, env = process.env) {
  return env.NEAR_AI_MODEL || env.TRUENAV_ATTEST_MODEL || fallback;
}

const hexBytes = (v) => Buffer.from(String(v).replace(/^0x/i, ""), "hex");
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const hash = (alg, ...parts) => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};

export function replayRtmr3(eventLog) {
  let rtmr3 = Buffer.alloc(48);
  for (const event of parse(eventLog)) {
    if (event.imr !== 3) continue;
    const t = Buffer.alloc(4);
    t.writeUInt32LE(event.event_type);
    const digest = hash("sha384", t, ":", Buffer.from(event.event, "utf8"), ":", hexBytes(event.event_payload ?? ""));
    if (event.digest && !hexBytes(event.digest).equals(digest)) throw new Error(`digest mismatch for event ${event.event}`);
    rtmr3 = hash("sha384", rtmr3, digest);
  }
  return rtmr3;
}

/** One NEAR-operated report (gateway or model). Returns a list of { check, pass, detail }. */
export async function checkNearReport(report, nonceHex) {
  const out = [];
  const add = (check, pass, detail = "") => out.push({ check, pass: !!pass, detail });
  let quote;
  try {
    const verified = await getCollateralAndVerify(hexBytes(report.intel_quote), pccsUrl());
    add("Intel TDX quote signature and collateral", true, `TCB ${verified.status}`);
    add(`TCB status accepted (${ACCEPTED_TCB.join(", ")})`, ACCEPTED_TCB.includes(verified.status), `${verified.status}${verified.advisory_ids && verified.advisory_ids.length ? " " + verified.advisory_ids.join(",") : ""}`);
    if (verified.report.type !== "td10") throw new Error("expected a TDX quote");
    quote = verified.report.data;
  } catch (e) {
    add("Intel TDX quote signature and collateral", false, e.message);
    return out;
  }
  add("TDX debug mode off", !(quote.tdAttributes[0] & 1));
  const identity = hexBytes(report.signing_address);
  const okIdentity = { ecdsa: 20, ed25519: 32 }[report.signing_algo] === identity.length;
  const fp = report.tls_cert_fingerprint;
  const bound = fp ? hash("sha256", identity, hexBytes(fp)) : Buffer.concat([identity, Buffer.alloc(Math.max(0, 32 - identity.length))]);
  add("Quote binds the signing address and the request nonce", okIdentity && Buffer.from(quote.reportData).equals(Buffer.concat([bound, hexBytes(nonceHex)])), `${report.signing_algo} ${report.signing_address}`);
  add("Echoed nonce matches", String(report.request_nonce || "").toLowerCase() === nonceHex.toLowerCase());
  const appCompose = parse(report.info.tcb_info).app_compose;
  const expected = Buffer.concat([Buffer.from([1]), hash("sha256", Buffer.from(appCompose, "utf8")), Buffer.alloc(15)]);
  add("Measured config (MRCONFIGID) matches app_compose", Buffer.from(quote.mrConfigId).equals(expected));
  try {
    add("Event log replays to RTMR3", replayRtmr3(report.event_log).equals(Buffer.from(quote.rtMr3)));
  } catch (e) {
    add("Event log replays to RTMR3", false, e.message);
  }
  return out;
}

export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
/** TRUENAV_NRAS_URL overrides NRAS for outage tests; a reply from any other URL is never counted as a pass. */
export const nrasUrl = (env = process.env) => env.TRUENAV_NRAS_URL || NRAS_URL;
/** TRUENAV_PCCS_URL overrides the collateral server (default Phala PCCS). Collateral is Intel-signed and verified either way. */
export const pccsUrl = (env = process.env) => env.TRUENAV_PCCS_URL || undefined;

/** NVIDIA GPU evidence through NVIDIA's attestation service (NRAS), as the docs describe. */
export async function checkGpu(report, nonceHex) {
  if (!report.nvidia_payload) return [{ check: "NVIDIA GPU attestation", pass: false, detail: "no GPU evidence returned" }];
  const payload = JSON.parse(report.nvidia_payload);
  if (String(payload.nonce || "").toLowerCase() !== nonceHex.toLowerCase()) return [{ check: "NVIDIA GPU attestation", pass: false, detail: "GPU evidence nonce mismatch" }];
  try {
    const r = await fetch(nrasUrl(), { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await r.json();
    const jwt = body[0][1];
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    // An overridden NRAS URL is for outage tests only: its answer never counts as a pass.
    if (nrasUrl() !== NRAS_URL) return [{ check: "NVIDIA GPU attestation (NRAS) with our nonce", pass: false, detail: "TRUENAV_NRAS_URL is set: not the NVIDIA service, not counted" }];
    return [{ check: "NVIDIA GPU attestation (NRAS) with our nonce", pass: claims["x-nvidia-overall-att-result"] === true, detail: `overall ${claims["x-nvidia-overall-att-result"]}` }];
  } catch (e) {
    return [{ check: "NVIDIA GPU attestation (NRAS) with our nonce", pass: false, detail: e.message }];
  }
}

/** Fetch gateway and model evidence for MODEL with a fresh nonce and check all of it. */
export async function attest(model = modelFromEnv()) {
  const nonce = randomBytes(32).toString("hex");
  const url = `${API}/attestation/report?${new URLSearchParams({ model, provider: "near", signing_algo: "ecdsa", nonce })}`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`attestation request failed: ${r.status}`);
  const raw = Buffer.from(await r.arrayBuffer()); // published base64-encoded as tee/fixtures/attestation-report.json.b64
  const body = JSON.parse(raw.toString("utf8"));
  const sections = [{ name: "NEAR AI Cloud gateway", checks: await checkNearReport(body.gateway_attestation, nonce) }];
  const candidates = body.model_attestations || [];
  if (!candidates.length) sections.push({ name: `Model ${model}`, checks: [{ check: "Model attestation returned", pass: false }] });
  for (const c of candidates) {
    sections.push({ name: `Model ${c.model_name || model}`, signer: { signing_algo: c.signing_algo, signing_address: c.signing_address }, checks: [...(await checkNearReport(c, nonce)), ...(await checkGpu(c, nonce))] });
  }
  const signers = sections.filter((s) => s.signer && s.checks.every((c) => c.pass)).map((s) => s.signer);
  const pass = sections.every((s) => s.checks.every((c) => c.pass)) && signers.length > 0;
  return { model, nonce, checked_at: new Date().toISOString(), pass, signers, sections, raw, reportSha256: createHash("sha256").update(raw).digest("hex") };
}

/** Re-check a saved report (anyone, no API key): quote, nonce and signer binding, measurements, GPU evidence. */
export async function verifyReport(body, nonce, model = MODEL) {
  const sections = [{ name: "NEAR AI Cloud gateway", checks: await checkNearReport(body.gateway_attestation, nonce) }];
  for (const c of body.model_attestations || []) sections.push({ name: `Model ${c.model_name || model}`, signer: { signing_algo: c.signing_algo, signing_address: c.signing_address }, checks: [...(await checkNearReport(c, nonce)), ...(await checkGpu(c, nonce))] });
  const signers = sections.filter((s) => s.signer && s.checks.every((c) => c.pass)).map((s) => s.signer);
  return { pass: sections.every((s) => s.checks.every((c) => c.pass)) && signers.length > 0, signers, sections };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await attest(process.argv[2] || modelFromEnv());
  for (const s of res.sections) {
    console.log(s.name + (s.signer ? `  signer ${s.signer.signing_address} (${s.signer.signing_algo})` : ""));
    for (const c of s.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.check}${c.detail ? "  " + c.detail : ""}`);
  }
  console.log(res.pass ? `Attestation verified with nonce ${res.nonce}` : "Attestation NOT verified");
  if (process.argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
  process.exitCode = res.pass ? 0 : 1;
}
