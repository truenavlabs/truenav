// Data layer for the "verify this receipt yourself" panel. Read only: receipts and registry view
// calls, plus tx status RPC. No signing, no keys, no wallet. Views and tx lookups go through
// chain.mjs rpcCall (8 s per endpoint, failover). Parsers cap sizes and counts.

import { DEFAULT_CONTRACT, DEFAULT_RPC, RPC_TIMEOUT_MS, rpcCall } from "../../chain.mjs";
import { RECEIPTS_CONTRACT, REGISTRY_CONTRACT } from "./near.mjs";
import { explorerTxUrl, isTokenId } from "./receipts-write.mjs";

export { explorerTxUrl, isTokenId, RECEIPTS_CONTRACT, REGISTRY_CONTRACT, RPC_TIMEOUT_MS };

export const MAX_QUERY_CHARS = 128;
export const MAX_VIEW_CHARS = 32_000;
export const MAX_TX_OUTCOMES = 32;
export const MAX_LOGS_PER_OUTCOME = 32;
export const MAX_LOG_CHARS = 4_096;
export const MAX_EVENTS = 40;
export const MAX_TOKENS = 100;
export const MAX_HISTORY_PAGE = 10;
export const MAX_HISTORY_PAGES = 5;
export const MAX_ATTESTATIONS = 12;
export const MAX_ACCOUNT_CHARS = 64;
export const MAX_TOKEN_CHARS = 64;
export const MAX_STR = 256;
export const PROOF_SCHEME = "outlayer_tdx_v1";
export const PROOF_REF_PREFIX = "https://testnet-api.outlayer.ai/attestations/by-request/";
export const HEX64 = /^[0-9a-f]{64}$/;
export const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;

export const EMPTY_DETAIL =
  "No runs have been stored on this receipts contract yet. get_config.next_request is 1, so the first request id has not been issued.";

const enc = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256 hex via WebCrypto (available in the browser and in Node 18+). */
export async function sha256Hex(data) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error("WebCrypto SHA-256 is not available in this environment");
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(d));
}

export function isHex64(s) {
  return typeof s === "string" && HEX64.test(s);
}

/** Decimal digit string for a u64, or null. Accepts a number or a string. */
export function asDec(v) {
  if (typeof v === "bigint" && v >= 0n && v < 2n ** 64n) return v.toString();
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) return String(v);
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v)) {
    try {
      const n = BigInt(v);
      if (n < 2n ** 64n) return n.toString();
    } catch {
      return null;
    }
  }
  return null;
}

export function sameDec(a, b) {
  const x = asDec(a);
  const y = asDec(b);
  return x !== null && x === y;
}

function boundStr(v, max = MAX_STR) {
  return typeof v === "string" && v.length <= max ? v : null;
}

function checkState(id, label, state, detail, source) {
  return Object.freeze({ id, label, state, detail, source });
}

/**
 * Classify a paste: a request id, a token and sequence (TOKEN:1 or TOKEN/1), or a base58 tx hash
 * with an optional signer account (hash@account or "hash account").
 */
export function parseQuery(input) {
  if (input == null || input === "") return { kind: "none" };
  if (typeof input !== "string") return { kind: "invalid", reason: "Query must be a string." };
  if (input.length > MAX_QUERY_CHARS) {
    return { kind: "invalid", reason: `Query is longer than ${MAX_QUERY_CHARS} characters.` };
  }
  if (/[\x00-\x1f]/.test(input)) return { kind: "invalid", reason: "Query contains control characters." };
  const raw = input.trim();
  if (!raw) return { kind: "none" };

  const tx = raw.match(/^([1-9A-HJ-NP-Za-km-z]{43,44})(?:[@\s]+([a-z0-9._-]{2,64}))?$/);
  if (tx && BASE58_HASH.test(tx[1])) {
    if (tx[2] && !ACCOUNT_ID.test(tx[2])) return { kind: "invalid", reason: "Signer account id is not a valid NEAR account." };
    return { kind: "tx", hash: tx[1], signerId: tx[2] || null };
  }

  if (/^[1-9][0-9]{0,19}$/.test(raw)) {
    const requestId = asDec(raw);
    if (!requestId || requestId === "0") return { kind: "invalid", reason: "Request id must be a positive integer." };
    return { kind: "request_id", requestId };
  }

  const rec = raw.match(/^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)[:\/\s]+([1-9][0-9]{0,19})$/);
  if (rec && isTokenId(rec[1]) && rec[1].length <= MAX_TOKEN_CHARS) {
    const seq = asDec(rec[2]);
    if (!seq) return { kind: "invalid", reason: "Sequence must be a positive integer." };
    return { kind: "receipt", tokenId: rec[1], seq };
  }

  return {
    kind: "invalid",
    reason: "Enter a request id (for example 1), a token and sequence (TOKEN:1), or a testnet transaction hash.",
  };
}

const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));

/**
 * Read-only contract view through rpcCall (8 s timeout). Rejects a result larger than MAX_VIEW_CHARS.
 */
export async function callView(contract, method, args = {}, { url = DEFAULT_RPC, fetchImpl, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  if (typeof contract !== "string" || !contract) throw new Error("callView requires a contract id");
  if (typeof method !== "string" || !method) throw new Error("callView requires a method name");
  if (args == null || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be a plain object");
  const res = await rpcCall(
    url,
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: b64(JSON.stringify(args)),
    },
    { fetchImpl, timeoutMs },
  );
  if (!res || !Array.isArray(res.result)) throw new Error(`View ${method} returned no result bytes`);
  if (res.result.length > MAX_VIEW_CHARS) throw new Error(`View ${method} result is larger than the ${MAX_VIEW_CHARS} character cap`);
  const text = new TextDecoder().decode(Uint8Array.from(res.result));
  if (text.length > MAX_VIEW_CHARS) throw new Error(`View ${method} result is larger than the ${MAX_VIEW_CHARS} character cap`);
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`View ${method} result is not JSON`);
  }
}

/** Default view and RPC helpers. Tests inject their own and never call this. */
export function defaultClients(opts = {}) {
  const url = opts.url || DEFAULT_RPC;
  const rpc = (method, params) => rpcCall(url, method, params, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? RPC_TIMEOUT_MS });
  const viewReceipts = (method, args = {}) => callView(RECEIPTS_CONTRACT, method, args, opts);
  const viewRegistry = (method, args = {}) => callView(opts.registryContract || DEFAULT_CONTRACT, method, args, opts);
  return { rpc, viewReceipts, viewRegistry };
}

function boundList(v, max) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max);
}

function boundConfig(c) {
  if (!c || typeof c !== "object") return null;
  const cfg = c.config && typeof c.config === "object" ? c.config : null;
  return {
    admin: boundStr(c.admin, MAX_ACCOUNT_CHARS),
    pauser: boundStr(c.pauser, MAX_ACCOUNT_CHARS),
    paused: c.paused === true,
    next_request: asDec(c.next_request),
    config: cfg
      ? {
          method: boundStr(cfg.method, MAX_STR),
          version_key: isHex64(cfg.version_key) ? cfg.version_key : boundStr(cfg.version_key, 64),
        }
      : null,
  };
}

function failureText(failure) {
  const s = JSON.stringify(failure ?? {});
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : s.slice(0, 300);
}

/** EVENT_JSON events from a tx status result, with caps on outcomes, logs, length and count. */
export function boundedEvents(result) {
  const out = [];
  const outcomes = boundList(result && result.receipts_outcome, MAX_TX_OUTCOMES);
  for (const r of outcomes) {
    const logs = boundList(r && r.outcome && r.outcome.logs, MAX_LOGS_PER_OUTCOME);
    for (const log of logs) {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
      const payload = log.slice(11, 11 + MAX_LOG_CHARS);
      try {
        const e = JSON.parse(payload);
        if (e && typeof e.event === "string") {
          out.push({ event: e.event.slice(0, 64), data: Array.isArray(e.data) ? e.data[0] : e.data });
        }
      } catch {
        // not an event
      }
      if (out.length >= MAX_EVENTS) return out;
    }
  }
  return out;
}

/** Pull hash, parties, status and events from a tx status RPC result. Drops proofs and gas profiles. */
export function extractTx(result) {
  if (!result || typeof result !== "object") return null;
  const hash = boundStr((result.transaction && result.transaction.hash) || (result.transaction_outcome && result.transaction_outcome.id), 44);
  const explorerUrl = explorerTxUrl(hash);
  const status = result.status;
  const failed = !!(status && typeof status === "object" && "Failure" in status);
  const success = !!(status && typeof status === "object" && "SuccessValue" in status);
  return {
    hash: explorerUrl ? hash : null,
    explorerUrl,
    signerId: boundStr(result.transaction && result.transaction.signer_id, MAX_ACCOUNT_CHARS),
    receiverId: boundStr(result.transaction && result.transaction.receiver_id, MAX_ACCOUNT_CHARS),
    failed,
    success,
    detail: failed ? failureText(status.Failure) : null,
    events: boundedEvents(result),
  };
}

function parseBody(receipt) {
  if (typeof receipt !== "string") return { body: receipt && typeof receipt === "object" ? receipt : null, raw: null };
  if (receipt.length > MAX_VIEW_CHARS) return { body: null, raw: null, tooLarge: true };
  try {
    const body = JSON.parse(receipt);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { body: null, raw: receipt };
    return { body, raw: receipt };
  } catch {
    return { body: null, raw: receipt, parseError: true };
  }
}

/**
 * Normalize a StoredReceipt row from get_history/get_latest, or a get_receipt envelope, into
 * wrapper fields plus a parsed body.
 */
export function normalizeStored(row) {
  if (!row || typeof row !== "object") return null;
  const isEnvelope = row.receipt_version === "3" || row.receipt_version === 3 || (row.method_version && row.receipt && typeof row.receipt !== "string");
  if (typeof row.receipt === "string" || (!isEnvelope && row.token_id && row.seq != null && row.receipt_sha256)) {
    const parsed = parseBody(row.receipt);
    return {
      tokenId: boundStr(row.token_id, MAX_TOKEN_CHARS),
      seq: asDec(row.seq),
      requestId: asDec(row.request_id),
      method: boundStr(row.method, MAX_STR),
      versionKey: isHex64(row.version_key) ? row.version_key : boundStr(row.version_key, 64),
      score: row.score,
      band: boundStr(row.band, 16),
      period: boundStr(row.period, MAX_STR),
      asOf: boundStr(row.as_of, MAX_STR),
      caps: Array.isArray(row.caps) ? row.caps.slice(0, 32).map((c) => boundStr(c, 64)).filter(Boolean) : [],
      holds: Array.isArray(row.holds) ? row.holds.slice(0, 32).map((c) => boundStr(c, 64)).filter(Boolean) : [],
      wrapperSha: isHex64(row.receipt_sha256) ? row.receipt_sha256 : null,
      blockHeight: asDec(row.block_height),
      ...parsed,
    };
  }
  // get_receipt v3 returns the envelope object only.
  const tokenId = boundStr(row.token_id, MAX_TOKEN_CHARS);
  const seq = asDec(row.seq);
  if (!tokenId || !seq) return null;
  return {
    tokenId,
    seq,
    requestId: asDec(row.request_id),
    method: boundStr(row.method || row.method_version, MAX_STR),
    versionKey: isHex64(row.engine_version_key) ? row.engine_version_key : boundStr(row.engine_version_key, 64),
    score: row.score,
    band: boundStr(row.band, 16),
    period: row.period_start && row.period_end ? `${row.period_start}/${row.period_end}` : boundStr(row.period, MAX_STR),
    asOf: boundStr(row.as_of || row.valuation_time, MAX_STR),
    caps: Array.isArray(row.caps) ? row.caps.slice(0, 32).map((c) => boundStr(c, 64)).filter(Boolean) : [],
    holds: Array.isArray(row.holds) ? row.holds.slice(0, 32).map((c) => boundStr(c, 64)).filter(Boolean) : [],
    wrapperSha: null,
    envelopeSha: isHex64(row.receipt_sha256) ? row.receipt_sha256 : null,
    body: row,
    raw: null,
  };
}

function envelopeShaOf(norm) {
  if (norm.envelopeSha) return norm.envelopeSha;
  const s = norm.body && norm.body.receipt_sha256;
  return isHex64(s) ? s : null;
}

function fmtVal(v) {
  if (v == null) return "absent";
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 16)}...` : v;
  return JSON.stringify(v).slice(0, 80);
}

function valuesEqual(name, a, b) {
  if (name === "seq" || name === "request_id" || name === "score") {
    if (a == null || b == null) return false;
    const x = asDec(a);
    const y = asDec(b);
    if (x !== null && y !== null) return x === y;
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return String(a) === String(b);
}

/** Compare StoredReceipt wrapper fields with the parsed receipt body, with v3 field aliases. */
export function compareWrapperAndBody(norm) {
  const body = norm.body;
  if (!body) return { compared: [], bad: ["receipt body is not JSON"], skipped: [] };
  const periodFromBody =
    typeof body.period_start === "string" && typeof body.period_end === "string"
      ? `${body.period_start}/${body.period_end}`
      : body.period;
  const pairs = [
    ["token_id", norm.tokenId, body.token_id],
    ["seq", norm.seq, body.seq],
    ["request_id", norm.requestId, body.request_id],
    ["score", norm.score, body.score],
    ["band", norm.band, body.band],
    ["period", norm.period, periodFromBody],
    ["as_of", norm.asOf, body.as_of || body.valuation_time],
    ["method", norm.method, body.method || body.method_version],
    ["version_key", norm.versionKey, body.version_key || body.engine_version_key],
  ];
  const compared = [];
  const bad = [];
  const skipped = [];
  for (const [name, a, b] of pairs) {
    if (a == null || a === "" || b == null || b === "") {
      skipped.push(name);
      continue;
    }
    // Failure heads store score 0 on the wrapper and null in the body.
    if (name === "score" && asDec(a) === "0" && b === null) {
      skipped.push("score (wrapper 0, body null; failure head)");
      continue;
    }
    if (!valuesEqual(name, a, b)) bad.push(`${name}: wrapper ${fmtVal(a)} vs body ${fmtVal(b)}`);
    else compared.push(name);
  }
  return { compared, bad, skipped };
}

function summarize(checks) {
  const counts = { live: 0, fail: 0, unchecked: 0 };
  for (const c of checks) {
    if (c.state === "live" || c.state === "fail" || c.state === "unchecked") counts[c.state] += 1;
  }
  return { counts, ok: counts.fail === 0 && counts.live > 0 };
}

function emptyResult(config, parsed, extra = {}) {
  const checks = [
    ...(extra.checks || []),
    checkState("empty", "Stored runs", "unchecked", EMPTY_DETAIL, "receipts get_config.next_request"),
    ...notCheckableChecks(null),
  ];
  return {
    kind: "empty",
    query: parsed,
    config,
    nextRequest: "1",
    detail: EMPTY_DETAIL,
    ...extra,
    checks,
    summary: summarize(checks),
  };
}

function notCheckableChecks(norm) {
  const out = [
    checkState(
      "tee-execution",
      "Engine run in the TEE",
      "unchecked",
      "This panel does not re-run the engine in a TEE. It only checks what the receipts contract stored and, when a transaction hash is given, what the RPC returns for that transaction.",
      "not checkable from contract views",
    ),
    checkState(
      "private-fields",
      "Private receipt fields",
      "unchecked",
      "Views return the public receipt body. Private fields are not available to check.",
      "receipts view_body",
    ),
  ];
  const envSha = norm ? envelopeShaOf(norm) : null;
  out.push(
    checkState(
      "envelope-hash",
      "Sealed envelope hash",
      "unchecked",
      envSha
        ? `The envelope receipt_sha256 is ${envSha}. That is the sealed envelope hash. This panel does not re-seal the envelope, so that hash is not recomputed here.`
        : "The sealed envelope hash is not recomputed here. The contract seals the envelope at accept time.",
      "receipts accept_v3 seal_envelope",
    ),
  );
  return out;
}

async function loadHistoryRow(viewReceipts, tokenId, seq) {
  const hist = boundList(await viewReceipts("get_history", { token_id: tokenId, from_seq: Number(seq), limit: 1 }), 1);
  const hit = hist.find((r) => sameDec(r && r.seq, seq));
  if (hit) return hit;
  const latest = await viewReceipts("get_latest", { token_id: tokenId });
  if (latest && sameDec(latest.seq, seq)) return latest;
  const rec = await viewReceipts("get_receipt", { token_id: tokenId, seq: Number(seq) });
  return rec || null;
}

async function loadByTokenSeq(viewReceipts, tokenId, seq) {
  const token = await viewReceipts("get_token", { token_id: tokenId });
  if (!token) return { kind: "missing", detail: `${tokenId} is not registered on the receipts contract.` };
  const info = token.token || token;
  const count = asDec(info.receipts) || "0";
  if (BigInt(seq) > BigInt(count)) {
    if (token.pending && sameDec(seq, (BigInt(count) + 1n).toString())) {
      return { kind: "pending", tokenId, pending: token.pending, detail: `No receipt at ${tokenId}:${seq}. A run is pending (request ${token.pending.request_id}).` };
    }
    return { kind: "missing", detail: `No receipt at ${tokenId} seq ${seq}. This token has ${count} stored receipt(s).` };
  }
  const row = await loadHistoryRow(viewReceipts, tokenId, seq);
  if (!row) return { kind: "missing", detail: `No receipt at ${tokenId} seq ${seq}.` };
  return { kind: "stored", row, token };
}

async function loadByRequestId(viewReceipts, requestId, nextRequest) {
  if (nextRequest && BigInt(requestId) >= BigInt(nextRequest)) {
    return { kind: "not_issued", detail: `Request ${requestId} has not been issued. get_config.next_request is ${nextRequest}.` };
  }
  const tokens = boundList(await viewReceipts("list_tokens", { from: 0, limit: MAX_TOKENS }), MAX_TOKENS);
  for (const t of tokens) {
    const tokenId = boundStr(t && t.token_id, MAX_TOKEN_CHARS);
    if (!tokenId || !isTokenId(tokenId)) continue;
    const n = Number(asDec(t.receipts) || "0");
    if (n <= 0) continue;
    let from = n;
    for (let page = 0; page < MAX_HISTORY_PAGES && from >= 1; page++) {
      const hist = boundList(await viewReceipts("get_history", { token_id: tokenId, from_seq: from, limit: MAX_HISTORY_PAGE }), MAX_HISTORY_PAGE);
      const hit = hist.find((r) => sameDec(r && r.request_id, requestId));
      if (hit) return { kind: "stored", row: hit };
      if (!hist.length) break;
      const oldest = hist[hist.length - 1];
      const oldestSeq = asDec(oldest && oldest.seq);
      if (!oldestSeq || hist.length < MAX_HISTORY_PAGE) break;
      const nextFrom = Number(oldestSeq) - 1;
      if (nextFrom < 1 || nextFrom >= from) break;
      from = nextFrom;
    }
  }
  for (const t of tokens) {
    const tokenId = boundStr(t && t.token_id, MAX_TOKEN_CHARS);
    if (!tokenId) continue;
    const info = await viewReceipts("get_token", { token_id: tokenId });
    if (info && info.pending && sameDec(info.pending.request_id, requestId)) {
      return { kind: "pending", tokenId, pending: info.pending, detail: `Request ${requestId} is pending for ${tokenId}. The result has not been stored yet.` };
    }
    if (info && info.last_failure && sameDec(info.last_failure.request_id, requestId)) {
      return { kind: "failure", tokenId, failure: info.last_failure, detail: `Request ${requestId} for ${tokenId} finished with code ${info.last_failure.code}.` };
    }
  }
  return { kind: "missing", detail: `No stored receipt, pending run or last failure has request id ${requestId}.` };
}

async function loadTx(rpc, parsed) {
  if (typeof rpc !== "function") return { kind: "tx_error", detail: "No tx status RPC client was provided.", hash: parsed.hash };
  const params = parsed.signerId
    ? { tx_hash: parsed.hash, sender_account_id: parsed.signerId, wait_until: "NONE" }
    : { tx_hash: parsed.hash, wait_until: "NONE" };
  try {
    const result = await rpc("tx", params);
    const tx = extractTx(result);
    if (!tx) return { kind: "tx_error", detail: "The RPC result had no transaction fields.", hash: parsed.hash };
    return { kind: "tx", tx };
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    const hint = parsed.signerId
      ? message
      : `${message} Some RPCs need the signer account: paste "hash@account" or "hash account".`;
    return { kind: "tx_error", detail: hint, hash: parsed.hash };
  }
}

function eventData(tx, name) {
  if (!tx || !Array.isArray(tx.events)) return null;
  const e = tx.events.find((x) => x.event === name);
  return e ? e.data : null;
}

async function hashChecks(norm, sha256) {
  const checks = [];
  if (!norm.raw) {
    checks.push(
      checkState(
        "wrapper-hash",
        "Public body hash",
        "unchecked",
        "The exact stored receipt string was not returned (v3 get_receipt returns a parsed envelope). This panel cannot recompute StoredReceipt.receipt_sha256 from that view.",
        "receipts get_history / get_latest",
      ),
    );
    return checks;
  }
  if (norm.tooLarge) {
    checks.push(checkState("wrapper-hash", "Public body hash", "fail", "The receipt string is larger than the parser cap.", "receipts get_history"));
    return checks;
  }
  if (!norm.wrapperSha) {
    checks.push(checkState("wrapper-hash", "Public body hash", "fail", "StoredReceipt.receipt_sha256 is missing or is not 64 lowercase hex characters.", "receipts StoredReceipt"));
    return checks;
  }
  const digest = await sha256(norm.raw);
  if (digest === norm.wrapperSha) {
    checks.push(
      checkState(
        "wrapper-hash",
        "Public body hash",
        "live",
        `sha256 of the stored receipt string, computed in this browser, equals StoredReceipt.receipt_sha256 ${digest}.`,
        "receipts StoredReceipt.receipt_sha256",
      ),
    );
  } else {
    checks.push(
      checkState(
        "wrapper-hash",
        "Public body hash",
        "fail",
        `sha256 of the viewed receipt string is ${digest}, not StoredReceipt.receipt_sha256 ${norm.wrapperSha}. If the view projected a public body, the exact stored bytes are not what was hashed.`,
        "receipts StoredReceipt.receipt_sha256",
      ),
    );
  }
  const envSha = envelopeShaOf(norm);
  if (envSha && envSha === norm.wrapperSha) {
    checks.push(
      checkState(
        "hash-roles",
        "Wrapper hash vs envelope hash",
        "unchecked",
        "The wrapper hash and the envelope receipt_sha256 are the same string. On v3 they are usually different roles (public body hash vs sealed envelope hash).",
        "receipts accept_v3",
      ),
    );
  } else if (envSha && norm.wrapperSha) {
    checks.push(
      checkState(
        "hash-roles",
        "Wrapper hash vs envelope hash",
        "live",
        "The wrapper receipt_sha256 is the public body hash and the envelope receipt_sha256 is the sealed envelope hash. They are allowed to differ, and they do.",
        "receipts accept_v3",
      ),
    );
  }
  return checks;
}

async function prevHashCheck(norm, viewReceipts) {
  const src = "receipts get_history; envelope prev_receipt_sha256";
  const prev = norm.body ? norm.body.prev_receipt_sha256 : undefined;
  if (norm.seq === "1") {
    if (prev == null || prev === "") {
      return checkState("prev-hash", "Previous receipt hash", "live", "Sequence 1 has no previous receipt, and prev_receipt_sha256 is empty.", src);
    }
    return checkState("prev-hash", "Previous receipt hash", "fail", "Sequence 1 should not point at a previous receipt.", src);
  }
  if (!norm.seq || !norm.tokenId) {
    return checkState("prev-hash", "Previous receipt hash", "unchecked", "No token and sequence, so the previous receipt was not read.", src);
  }
  if (typeof viewReceipts !== "function") {
    return checkState("prev-hash", "Previous receipt hash", "unchecked", "No receipts view client, so the previous receipt was not read.", src);
  }
  const prevSeq = (BigInt(norm.seq) - 1n).toString();
  let prevRow;
  try {
    prevRow = await loadHistoryRow(viewReceipts, norm.tokenId, prevSeq);
  } catch (e) {
    return checkState("prev-hash", "Previous receipt hash", "unchecked", `Could not read the previous receipt: ${e && e.message ? e.message : e}.`, src);
  }
  const prevNorm = normalizeStored(prevRow);
  if (!prevNorm) {
    return checkState("prev-hash", "Previous receipt hash", "fail", `No receipt at ${norm.tokenId} seq ${prevSeq}, but this receipt claims a previous hash.`, src);
  }
  const expected = envelopeShaOf(prevNorm) || prevNorm.wrapperSha;
  const claimed = isHex64(prev) ? prev : null;
  if (!claimed) {
    return checkState("prev-hash", "Previous receipt hash", "fail", "prev_receipt_sha256 is missing or is not 64 lowercase hex characters.", src);
  }
  if (claimed === expected) {
    return checkState("prev-hash", "Previous receipt hash", "live", "prev_receipt_sha256 equals the previous receipt's envelope hash (or wrapper hash when no envelope hash is present).", src);
  }
  // Common mistake: linking to the previous wrapper hash on a v3 chain.
  if (prevNorm.wrapperSha && claimed === prevNorm.wrapperSha && envelopeShaOf(prevNorm) && claimed !== envelopeShaOf(prevNorm)) {
    return checkState("prev-hash", "Previous receipt hash", "fail", "prev_receipt_sha256 equals the previous wrapper hash, but a v3 chain must link to the previous envelope hash.", src);
  }
  return checkState("prev-hash", "Previous receipt hash", "fail", `prev_receipt_sha256 ${claimed} does not equal the previous receipt hash ${expected}.`, src);
}

async function attestationChecks(norm, viewReceipts) {
  const src = "receipts get_body_binding; get_attestations";
  const out = [];
  if (!norm.tokenId || !norm.seq || typeof viewReceipts !== "function") {
    out.push(checkState("attestation-binding", "Attestation body binding", "unchecked", "No token and sequence, so attestation views were not called.", src));
    return out;
  }
  let binding;
  try {
    binding = await viewReceipts("get_body_binding", { token_id: norm.tokenId, seq: norm.seq });
  } catch (e) {
    out.push(checkState("attestation-binding", "Attestation body binding", "unchecked", `Could not read get_body_binding: ${e && e.message ? e.message : e}.`, src));
    return out;
  }
  if (!binding) {
    out.push(
      checkState(
        "attestation-binding",
        "Attestation body binding",
        "unchecked",
        "No body binding is stored for this receipt, so attestation consistency is not checkable from contract data.",
        src,
      ),
    );
    return out;
  }
  const bindRec = isHex64(binding.receipt_sha256) ? binding.receipt_sha256 : null;
  const bindBody = isHex64(binding.body_sha256) ? binding.body_sha256 : null;
  const envSha = envelopeShaOf(norm);
  const problems = [];
  if (!bindRec) problems.push("binding.receipt_sha256 is not 64 lowercase hex");
  if (!bindBody) problems.push("binding.body_sha256 is not 64 lowercase hex");
  if (bindRec && envSha && bindRec !== envSha) problems.push("binding.receipt_sha256 does not equal the envelope receipt_sha256");
  if (boundStr(binding.token_id, MAX_TOKEN_CHARS) && binding.token_id !== norm.tokenId) problems.push("binding.token_id does not match");
  if (binding.seq != null && !sameDec(binding.seq, norm.seq)) problems.push("binding.seq does not match");
  if (problems.length) {
    out.push(checkState("attestation-binding", "Attestation body binding", "fail", problems.join("; ") + ".", src));
  } else {
    out.push(
      checkState(
        "attestation-binding",
        "Attestation body binding",
        "live",
        `Body binding receipt_sha256 equals the envelope hash. body_sha256 is ${bindBody}; that is the canonical pre-seal body hash and is not recomputed here.`,
        src,
      ),
    );
  }

  let records;
  try {
    records = boundList(await viewReceipts("get_attestations", { token_id: norm.tokenId, seq: norm.seq, from: "0", limit: MAX_ATTESTATIONS }), MAX_ATTESTATIONS);
  } catch (e) {
    out.push(checkState("attestation-records", "Published attestations", "unchecked", `Could not read get_attestations: ${e && e.message ? e.message : e}.`, src));
    out.push(quoteUnchecked(null));
    return out;
  }
  if (!records.length) {
    out.push(checkState("attestation-records", "Published attestations", "unchecked", "A body binding exists, but no attestation records have been published.", src));
    out.push(quoteUnchecked(null));
    return out;
  }
  const recProblems = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || typeof r !== "object") {
      recProblems.push(`record ${i} is not an object`);
      continue;
    }
    if (bindRec && r.receipt_sha256 !== bindRec) recProblems.push(`record ${i} receipt_sha256 does not match the binding`);
    if (bindBody && r.body_sha256 !== bindBody) recProblems.push(`record ${i} body_sha256 does not match the binding`);
    if (r.proof_scheme !== PROOF_SCHEME) recProblems.push(`record ${i} proof_scheme is not ${PROOF_SCHEME}`);
    const ref = boundStr(r.proof_ref, 256);
    if (!ref || !ref.startsWith(PROOF_REF_PREFIX) || !/^[0-9]+$/.test(ref.slice(PROOF_REF_PREFIX.length))) {
      recProblems.push(`record ${i} proof_ref is not a testnet-api.outlayer.ai by-request URL`);
    }
  }
  if (recProblems.length) {
    out.push(checkState("attestation-records", "Published attestations", "fail", recProblems.join("; ") + ".", src));
  } else {
    out.push(
      checkState(
        "attestation-records",
        "Published attestations",
        "live",
        `${records.length} attestation record(s): receipt and body hashes match the binding, proof_scheme is ${PROOF_SCHEME}, and each proof_ref is a fixed testnet OutLayer by-request URL.`,
        src,
      ),
    );
  }
  out.push(quoteUnchecked(records[0] && records[0].proof_ref));
  return out;
}

function quoteUnchecked(proofRef) {
  return checkState(
    "attestation-quote",
    "Intel TDX quote",
    "unchecked",
    proofRef
      ? "The quote at the proof reference is not fetched or verified in this browser. Quote verification is off chain."
      : "The Intel TDX quote is not verified in this browser. Quote verification is off chain.",
    "receipts attestations.rs: quote verification is exclusively off chain",
  );
}

async function registryChecks(norm, viewRegistry) {
  const src = "registry get_fund; receipt fund_id, receipts_contract, network";
  const out = [];
  const body = norm.body || {};
  const contractId = boundStr(body.receipts_contract, MAX_ACCOUNT_CHARS);
  if (contractId) {
    if (contractId === RECEIPTS_CONTRACT) {
      out.push(checkState("receipts-contract", "Receipts contract id", "live", `The receipt names ${contractId}, the pinned receipts contract.`, src));
    } else {
      out.push(checkState("receipts-contract", "Receipts contract id", "fail", `The receipt names ${contractId}, not ${RECEIPTS_CONTRACT}.`, src));
    }
  }
  const network = boundStr(body.network, 32);
  if (network) {
    if (network === "near_testnet" || network === "testnet") {
      out.push(checkState("network", "Network", "live", `The receipt names network ${network}.`, src));
    } else {
      out.push(checkState("network", "Network", "fail", `The receipt names network ${network}, not near_testnet.`, src));
    }
  }
  const fundId = boundStr(body.fund_id, MAX_STR);
  if (!fundId) {
    out.push(checkState("registry-fund", "Registry fund", "unchecked", "The receipt has no fund_id, so the registry is not cross-checked.", src));
    return out;
  }
  if (typeof viewRegistry !== "function") {
    out.push(checkState("registry-fund", "Registry fund", "unchecked", "No registry view client, so get_fund was not called.", src));
    return out;
  }
  try {
    const fund = await viewRegistry("get_fund", { fund_id: fundId });
    if (fund) {
      const account = boundStr(fund.account_id || fund.fund_account, MAX_ACCOUNT_CHARS);
      const named = boundStr(body.fund_account, MAX_ACCOUNT_CHARS);
      if (named && account && named !== account) {
        out.push(checkState("registry-fund", "Registry fund", "fail", `get_fund found ${fundId}, but fund_account ${named} does not equal the registry account ${account}.`, src));
      } else {
        out.push(checkState("registry-fund", "Registry fund", "live", `get_fund on ${REGISTRY_CONTRACT} returned a fund for ${fundId}.`, src));
      }
    } else {
      out.push(
        checkState(
          "registry-fund",
          "Registry fund",
          "unchecked",
          `The registry has no fund with id ${fundId}. That is not always an error: a receipts token need not be a registry fund.`,
          src,
        ),
      );
    }
  } catch (e) {
    out.push(checkState("registry-fund", "Registry fund", "unchecked", `Could not read the registry: ${e && e.message ? e.message : e}.`, src));
  }
  return out;
}

function txChecks(tx, norm, parsed) {
  const src = "RPC tx; EVENT_JSON logs";
  const out = [];
  if (!tx) return out;
  if (tx.failed) {
    out.push(checkState("tx-status", "Transaction status", "fail", `The transaction failed: ${tx.detail || "no failure text"}.`, src));
  } else if (tx.success || tx.hash) {
    out.push(
      checkState(
        "tx-status",
        "Transaction status",
        "live",
        tx.receiverId
          ? `Transaction ${tx.hash} succeeded on ${tx.receiverId}.`
          : `Transaction ${tx.hash || parsed.hash} was returned by the RPC.`,
        src,
      ),
    );
  }
  if (tx.receiverId && tx.receiverId !== RECEIPTS_CONTRACT) {
    out.push(checkState("tx-receiver", "Transaction receiver", "fail", `The transaction receiver is ${tx.receiverId}, not ${RECEIPTS_CONTRACT}.`, src));
  } else if (tx.receiverId) {
    out.push(checkState("tx-receiver", "Transaction receiver", "live", "The transaction receiver is the receipts contract.", src));
  }
  if (!norm) return out;
  const stored = eventData(tx, "receipt_stored");
  if (stored) {
    const problems = [];
    if (stored.token_id && stored.token_id !== norm.tokenId) problems.push("token_id");
    if (stored.seq != null && !sameDec(stored.seq, norm.seq)) problems.push("seq");
    if (stored.request_id != null && norm.requestId && !sameDec(stored.request_id, norm.requestId)) problems.push("request_id");
    // receipt_stored.receipt_sha256 is the wrapper (public body) hash.
    if (isHex64(stored.receipt_sha256) && norm.wrapperSha && stored.receipt_sha256 !== norm.wrapperSha) problems.push("receipt_sha256");
    if (problems.length) {
      out.push(checkState("tx-events", "Transaction events vs stored receipt", "fail", `receipt_stored event does not match the stored receipt on: ${problems.join(", ")}.`, src));
    } else {
      out.push(checkState("tx-events", "Transaction events vs stored receipt", "live", "The receipt_stored event token, sequence and wrapper hash match the stored receipt.", src));
    }
  }
  const requested = eventData(tx, "run_requested");
  if (requested && requested.token_id && requested.token_id !== norm.tokenId) {
    out.push(checkState("tx-requested", "run_requested event", "fail", `run_requested token_id ${requested.token_id} does not match the stored receipt.`, src));
  }
  const failed = eventData(tx, "run_failed");
  if (failed && !stored) {
    out.push(checkState("tx-events", "Transaction events vs stored receipt", "unchecked", `The transaction has a run_failed event (code ${failed.code || "unknown"}) and no receipt_stored event.`, src));
  }
  return out;
}

function fieldCheck(norm) {
  const src = "receipts StoredReceipt vs receipt body";
  if (norm.parseError) return checkState("fields", "Wrapper fields vs body", "fail", "The stored receipt string is not JSON.", src);
  if (!norm.body) return checkState("fields", "Wrapper fields vs body", "unchecked", "No receipt body is available to compare with the wrapper fields.", src);
  const { compared, bad, skipped } = compareWrapperAndBody(norm);
  if (bad.length) return checkState("fields", "Wrapper fields vs body", "fail", bad.join("; ") + ".", src);
  if (!compared.length) return checkState("fields", "Wrapper fields vs body", "unchecked", "No overlapping fields were present to compare.", src);
  const skip = skipped.length ? ` Not compared (missing on one side): ${skipped.join(", ")}.` : "";
  return checkState("fields", "Wrapper fields vs body", "live", `Wrapper fields match the receipt body on: ${compared.join(", ")}.${skip}`, src);
}

/**
 * Re-read a run from chain and check it. viewReceipts, viewRegistry and rpc are injectable;
 * tests must pass mocks so this never hits a live RPC.
 *
 * @param {{ query?: string | object, viewReceipts: Function, viewRegistry?: Function, rpc?: Function, sha256?: Function }} input
 */
export async function verifyReceipt({ query = "", viewReceipts, viewRegistry, rpc, sha256 = sha256Hex } = {}) {
  if (typeof viewReceipts !== "function") throw new Error("verifyReceipt requires a receipts view function");
  const parsed = typeof query === "object" && query && query.kind ? query : parseQuery(query);
  let config;
  try {
    config = boundConfig(await viewReceipts("get_config", {}));
  } catch (e) {
    const checks = [checkState("config", "Receipts get_config", "fail", `Could not read get_config: ${e && e.message ? e.message : e}.`, "receipts get_config")];
    return { kind: "error", query: parsed, detail: checks[0].detail, checks, summary: summarize(checks) };
  }
  if (!config || !config.next_request) {
    const checks = [checkState("config", "Receipts get_config", "fail", "get_config did not return next_request.", "receipts get_config")];
    return { kind: "error", query: parsed, config, detail: checks[0].detail, checks, summary: summarize(checks) };
  }
  const nextRequest = config.next_request;
  const empty = nextRequest === "1";

  if (parsed.kind === "invalid") {
    const checks = [checkState("query", "Query", "fail", parsed.reason, "parseQuery")];
    return { kind: "invalid", query: parsed, config, nextRequest, detail: parsed.reason, checks, summary: summarize(checks) };
  }

  if (empty && parsed.kind !== "tx") {
    return emptyResult(config, parsed);
  }

  let found = { kind: "none" };
  let tx = null;
  let txLookup = null;

  if (parsed.kind === "tx") {
    txLookup = await loadTx(rpc, parsed);
    if (txLookup.kind === "tx") tx = txLookup.tx;
    if (empty) {
      const extraChecks = [];
      if (txLookup.kind === "tx_error") {
        extraChecks.push(checkState("tx-status", "Transaction status", "unchecked", txLookup.detail, "RPC tx"));
      } else if (tx) {
        extraChecks.push(...txChecks(tx, null, parsed));
      }
      return emptyResult(config, parsed, { tx, checks: extraChecks });
    }
    if (txLookup.kind === "tx_error") {
      const checks = [checkState("tx-status", "Transaction status", "fail", txLookup.detail, "RPC tx")];
      return { kind: "tx_error", query: parsed, config, nextRequest, detail: txLookup.detail, tx: null, hash: parsed.hash, checks, summary: summarize(checks) };
    }
    const storedEv = eventData(tx, "receipt_stored");
    const requested = eventData(tx, "run_requested");
    const failedEv = eventData(tx, "run_failed");
    if (storedEv && boundStr(storedEv.token_id, MAX_TOKEN_CHARS) && asDec(storedEv.seq)) {
      found = await loadByTokenSeq(viewReceipts, storedEv.token_id, asDec(storedEv.seq));
    } else if (requested && asDec(requested.request_id)) {
      found = await loadByRequestId(viewReceipts, asDec(requested.request_id), nextRequest);
    } else if (failedEv && asDec(failedEv.request_id)) {
      found = await loadByRequestId(viewReceipts, asDec(failedEv.request_id), nextRequest);
      if (found.kind === "missing") {
        found = { kind: "failure", tokenId: boundStr(failedEv.token_id, MAX_TOKEN_CHARS), failure: failedEv, detail: `The transaction has a run_failed event (code ${failedEv.code || "unknown"}).` };
      }
    } else if (tx.failed) {
      found = { kind: "tx_failed", detail: `The transaction failed: ${tx.detail || "no failure text"}.` };
    } else {
      found = { kind: "missing", detail: "The transaction has no receipt_stored, run_requested or run_failed event that this panel can use to find a receipt." };
    }
  } else if (parsed.kind === "receipt") {
    found = await loadByTokenSeq(viewReceipts, parsed.tokenId, parsed.seq);
  } else if (parsed.kind === "request_id") {
    found = await loadByRequestId(viewReceipts, parsed.requestId, nextRequest);
  }

  if (found.kind === "not_issued" || found.kind === "missing" || found.kind === "pending" || found.kind === "failure" || found.kind === "tx_failed") {
    const checks = [
      checkState("lookup", "Find the run", found.kind === "pending" || found.kind === "not_issued" ? "unchecked" : "fail", found.detail, "receipts list_tokens, get_history, get_token"),
      ...(tx ? txChecks(tx, null, parsed) : []),
      ...notCheckableChecks(null),
    ];
    return {
      kind: found.kind,
      query: parsed,
      config,
      nextRequest,
      detail: found.detail,
      pending: found.pending || null,
      failure: found.failure || null,
      tokenId: found.tokenId || null,
      tx,
      checks,
      summary: summarize(checks),
    };
  }

  const norm = normalizeStored(found.row);
  if (!norm || !norm.tokenId || !norm.seq) {
    const checks = [checkState("lookup", "Find the run", "fail", "The contract returned a row that could not be parsed as a stored receipt.", "receipts get_history")];
    return { kind: "error", query: parsed, config, nextRequest, detail: checks[0].detail, tx, checks, summary: summarize(checks) };
  }

  const checks = [
    checkState("lookup", "Find the run", "live", `Found ${norm.tokenId} seq ${norm.seq}${norm.requestId ? ` (request ${norm.requestId})` : ""}.`, "receipts get_history"),
    fieldCheck(norm),
    ...(await hashChecks(norm, sha256)),
    await prevHashCheck(norm, viewReceipts),
    ...(await attestationChecks(norm, viewReceipts)),
    ...(await registryChecks(norm, viewRegistry)),
    ...(tx ? txChecks(tx, norm, parsed) : []),
    ...notCheckableChecks(norm),
  ];

  return {
    kind: "checked",
    query: parsed,
    config,
    nextRequest,
    detail: `Checked ${norm.tokenId} seq ${norm.seq} against the receipts contract.`,
    receipt: {
      tokenId: norm.tokenId,
      seq: norm.seq,
      requestId: norm.requestId,
      method: norm.method,
      band: norm.band,
      score: norm.score,
      wrapperSha: norm.wrapperSha,
      envelopeSha: envelopeShaOf(norm),
      blockHeight: norm.blockHeight,
    },
    body: norm.body,
    tx,
    explorerUrl: tx && tx.explorerUrl,
    checks,
    summary: summarize(checks),
  };
}

export { summarize };
