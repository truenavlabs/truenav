// Data layer for the receipts write buttons. No layout, no wallet, no network of its own.
// One write exists: request_run(token_id) on the receipts contract (receipts/src/lib.rs). Every call shape here
// goes through buildSignAndSendTransaction in near.mjs, so a call to any other receiver or method throws before a
// wallet sees it. Sending is done by the caller with the wallet context's sendReceiptsCall.
import { buildSignAndSendTransaction, RECEIPTS_CONTRACT } from "./near.mjs";

export const REQUEST_RUN = "request_run";
/** request_run needs prepaid gas >= outlayer_tgas + callback_tgas + 10 (230 + 50 + 10 on testnet), so attach the 300 TGas maximum. */
export const REQUEST_RUN_GAS = "300000000000000";
/** How long to wait for the wallet before calling it a timeout. The OutLayer run yields, so allow a few minutes. */
export const WALLET_TIMEOUT_MS = 180_000;
export const EXPLORER = "https://testnet.nearblocks.io";

const DIGITS = /^(0|[1-9][0-9]{0,39})$/;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const YOCTO_PER_NEAR = 10n ** 24n;

/** Same rule as is_token_id in receipts/src/validate.rs: ASCII alphanumeric segments split by "-", 1 to 64 chars. */
export function isTokenId(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && s.split("-").every((p) => /^[A-Za-z0-9]+$/.test(p));
}

/** yoctoNEAR digit string to a NEAR decimal string with no rounding ("260000000000000000000000" -> "0.26"). */
export function yoctoToNear(yocto) {
  const s = typeof yocto === "bigint" ? yocto.toString() : yocto;
  if (typeof s !== "string" || !DIGITS.test(s)) throw new Error("yocto must be a decimal digit string");
  const n = BigInt(s);
  const whole = n / YOCTO_PER_NEAR;
  const frac = (n % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Gas units to TGas, for display. */
export function gasToTgas(gas) {
  if (typeof gas !== "string" || !DIGITS.test(gas)) throw new Error("gas must be a decimal digit string");
  return Number(BigInt(gas) / 10n ** 12n);
}

/** The deposit request_run requires: config.outlayer_deposit + config.storage_deposit, read from get_config. */
export function requiredDepositYocto(config) {
  const c = config && config.config ? config.config : config;
  const o = c && c.outlayer_deposit, st = c && c.storage_deposit;
  if (typeof o !== "string" || !DIGITS.test(o) || typeof st !== "string" || !DIGITS.test(st)) {
    throw new Error("get_config did not return outlayer_deposit and storage_deposit");
  }
  return (BigInt(o) + BigInt(st)).toString();
}

/**
 * The exact request_run call, checked by the write guard. Returns a frozen object the confirm step shows and the
 * send step uses unchanged: receiver, method, args, argsJson, gas, gasTgas, depositYocto, depositNear.
 */
export function buildRequestRunCall({ tokenId, config }) {
  if (!isTokenId(tokenId)) throw new Error("token_id must be ASCII letters and digits in segments split by -, 1 to 64 characters");
  const depositYocto = requiredDepositYocto(config);
  const args = { token_id: tokenId };
  const payload = buildSignAndSendTransaction({ receiverId: RECEIPTS_CONTRACT, methodName: REQUEST_RUN, args, gas: REQUEST_RUN_GAS, depositYocto });
  const p = payload.actions[0].params;
  return Object.freeze({
    receiverId: payload.receiverId,
    method: p.methodName,
    args: Object.freeze({ ...p.args }),
    argsJson: JSON.stringify(p.args),
    gas: p.gas,
    gasTgas: gasToTgas(p.gas),
    depositYocto: p.deposit,
    depositNear: yoctoToNear(p.deposit),
  });
}

/** The rows the confirm step shows, in order. Values are exactly what is sent. */
export function confirmRows(call) {
  return [
    ["Network", "NEAR testnet"],
    ["Receiver", call.receiverId],
    ["Method", call.method],
    ["Args (JSON)", call.argsJson],
    ["Gas", `${call.gasTgas} TGas (${call.gas} gas units)`],
    ["Deposit", `${call.depositNear} NEAR (${call.depositYocto} yoctoNEAR). The contract refunds any part a run does not use.`],
  ];
}

/**
 * Read-only checks before the confirm step, with the receipts views get_config, is_runner and get_token.
 * view(method, args) is a receipts contract view (viewFunction in near.mjs, or a mock in tests).
 * Returns { ok, reasons, call }: call is null when ok is false.
 */
export async function preflightRequestRun({ accountId, tokenId, view }) {
  const reasons = [];
  if (!accountId) return { ok: false, reasons: ["Connect a testnet wallet first."], call: null };
  if (!isTokenId(tokenId)) return { ok: false, reasons: ["Pick a registered token."], call: null };
  const [config, runner, token] = await Promise.all([view("get_config", {}), view("is_runner", { account: accountId }), view("get_token", { token_id: tokenId })]);
  if (config && config.paused) reasons.push("The receipts contract is paused.");
  if (runner !== true) reasons.push(`${accountId} is not a runner on ${RECEIPTS_CONTRACT}. request_run is runner only, so the contract would refuse it ("runner only"). Adding a runner is an admin call (set_runner) that this app does not make.`);
  if (!token) reasons.push(`${tokenId} is not registered on the receipts contract.`);
  else if (token.pending) reasons.push(`A run is already pending for ${tokenId} (request ${token.pending.request_id}).`);
  let call = null;
  try {
    call = buildRequestRunCall({ tokenId, config });
  } catch (e) {
    reasons.push(e && e.message ? e.message : "Could not build the call.");
  }
  return { ok: reasons.length === 0, reasons, call: reasons.length ? null : call };
}

/** nearblocks testnet link for a base58 tx hash, or null. */
export function explorerTxUrl(hash) {
  return typeof hash === "string" && BASE58_HASH.test(hash) ? `${EXPLORER}/txns/${hash}` : null;
}

function decodeBase64Json(b64) {
  try {
    const text = typeof atob === "function" ? new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) : Buffer.from(b64, "base64").toString("utf8");
    return text === "" ? "" : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failureText(failure) {
  const s = JSON.stringify(failure ?? {});
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : s.slice(0, 300);
}

/** EVENT_JSON events from every receipt outcome's logs. */
export function eventsOf(result) {
  const out = [];
  for (const r of (result && result.receipts_outcome) || []) {
    for (const log of (r && r.outcome && r.outcome.logs) || []) {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice(11));
        if (e && typeof e.event === "string") out.push({ event: e.event, data: Array.isArray(e.data) ? e.data[0] : e.data });
      } catch {
        // not an event
      }
    }
  }
  return out;
}

/**
 * Read a near-connect FinalExecutionOutcome for request_run.
 * kind: "stored" (on_run_result returned stored:N), "run_failed" (a failure code), "refused" (the transaction
 * failed, for example "runner only"), "submitted" (a hash but no final value in the reply) or "unknown".
 */
export function parseRequestRunOutcome(result) {
  const hash = (result && result.transaction && result.transaction.hash) || (result && result.transaction_outcome && result.transaction_outcome.id) || null;
  const explorerUrl = explorerTxUrl(hash);
  const events = eventsOf(result);
  const status = result && result.status;
  const base = { hash: explorerUrl ? hash : null, explorerUrl, events };
  if (status && typeof status === "object" && "Failure" in status) return { ...base, kind: "refused", detail: failureText(status.Failure) };
  if (status && typeof status === "object" && "SuccessValue" in status) {
    const v = decodeBase64Json(status.SuccessValue);
    if (typeof v === "string" && /^stored:\d+$/.test(v)) return { ...base, kind: "stored", detail: `Receipt stored as seq ${v.slice(7)}.` };
    if (typeof v === "string" && v) return { ...base, kind: "run_failed", detail: `The run finished with code ${v}. The unused deposit is refunded.` };
    if (v && typeof v === "object" && typeof v.error === "string") return { ...base, kind: "run_failed", detail: `Refused before the run: ${v.error}. The whole deposit is refunded.` };
    const req = events.find((e) => e.event === "run_requested");
    if (req) return { ...base, kind: "submitted", detail: `Run requested (request ${req.data && req.data.request_id}). The result arrives in a later block.` };
    return { ...base, kind: "submitted", detail: "Sent. The wallet reply has no final value; check the explorer." };
  }
  if (hash) return { ...base, kind: "submitted", detail: "Sent. The wallet reply has no final status; check the explorer." };
  return { ...base, kind: "unknown", detail: "The wallet returned no transaction hash." };
}

export class WalletTimeoutError extends Error {
  constructor(ms) {
    super(`No answer from the wallet in ${Math.round(ms / 1000)} s`);
    this.name = "WalletTimeoutError";
  }
}

/** Reject with WalletTimeoutError after ms. The wallet request itself cannot be cancelled and may still land. */
export function withTimeout(promise, ms, timers = { set: setTimeout, clear: clearTimeout }) {
  let id;
  const t = new Promise((_, reject) => {
    id = timers.set(() => reject(new WalletTimeoutError(ms)), ms);
  });
  return Promise.race([promise, t]).finally(() => timers.clear(id));
}

/** "rejected" (the user said no in the wallet), "timeout", "guard" (refused by the write guard) or "error". */
export function classifyWriteError(e) {
  const message = e && e.message ? String(e.message) : String(e ?? "Wallet request did not complete");
  if (e instanceof WalletTimeoutError || (e && e.name === "WalletTimeoutError")) return { kind: "timeout", message: `${message}. The transaction may still land: check your account on the explorer before trying again.` };
  if (/writes go to the receipts contract only|method not allowed|deposit is above the cap|gas must be|args must be|depositYocto|token_id must/i.test(message)) return { kind: "guard", message };
  if (/reject|denied|cancel|declin|closed|user abort/i.test(message)) return { kind: "rejected", message: "You rejected the request in the wallet. Nothing was sent." };
  return { kind: "error", message };
}

/**
 * Send a confirmed call with the wallet context's sendReceiptsCall, then read the outcome. The receiver is checked
 * again here; sendReceiptsCall runs the full guard in near.mjs before the wallet.
 * Returns { kind, ... } from parseRequestRunOutcome, or { kind: "rejected" | "timeout" | "guard" | "error", message }.
 */
export async function sendConfirmedCall(sendReceiptsCall, call, { timeoutMs = WALLET_TIMEOUT_MS, timers } = {}) {
  try {
    if (!call || call.receiverId !== RECEIPTS_CONTRACT) throw new Error("Writes go to the receipts contract only");
    if (call.method !== REQUEST_RUN) throw new Error("Method not allowed for writes");
    const result = await withTimeout(Promise.resolve().then(() => sendReceiptsCall(call.method, { ...call.args }, { gas: call.gas, depositYocto: call.depositYocto })), timeoutMs, timers);
    return parseRequestRunOutcome(result);
  } catch (e) {
    return classifyWriteError(e);
  }
}
