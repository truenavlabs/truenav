// Browser port of the registry's pledge_loan decision order (contract/src/lib.rs pledge_loan, lines 699 to 768).
// A simulation: it runs on the live lock and role state you pass in and returns what the contract would answer.
// It sends nothing. Signatures are modelled as a choice (valid from the registered key, from another key, or
// unreadable) because recovering them needs a crypto library that is pending approval.

export const PLEDGE_TTL_MS = 24 * 3600 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32,64}$/;

export const SIG = Object.freeze({ VALID: "valid", OTHER_KEY: "other_key", BAD: "bad" });

/**
 * @param {object} call   { deposit_yocto, loan_hash, asset_type, fund_account, nonce, expiry_ms, sig, ticket, caller }
 * @param {object} state  { paused, pledgeKey, ticketRequired, ticketSigners:boolean, fundsByAccount:{[account]:fund_id},
 *                          locks:{[loan_hash]:{fund_id}}, usedNonces:Set<string>, attemptSeq:number, now:number, contract }
 * @returns {{ kind:"panic", message:string, step:number } | { kind:"return", value:object, step:number, stores:string[] }}
 */
export function simulatePledge(call, state) {
  const panic = (step, message) => ({ kind: "panic", step, message: `Smart contract panicked: ${message}` });
  if (String(call.deposit_yocto) !== "1") return panic(1, "Requires attached deposit of exactly 1 yoctoNEAR");
  if (state.paused) return panic(2, "paused");
  if (!HEX64.test(call.loan_hash || "")) return panic(3, "loan_hash must be 64 lowercase hex characters");
  if (call.asset_type !== "real_estate" && call.asset_type !== "invoices") return panic(4, "asset_type must be real_estate or invoices");
  if (!NONCE.test(call.nonce || "")) return panic(5, "nonce must be 32 to 64 lowercase hex characters");
  if (String(call.fund_account).includes("|")) return panic(6, "fund_account must not contain '|'");
  if (!state.pledgeKey) return panic(7, "servicer pledge key is not set");
  if (call.sig === SIG.BAD) return panic(8, "bad servicer signature");
  if (call.sig !== SIG.VALID) return panic(9, "servicer signature not from the registered pledge key");
  if (!(call.expiry_ms > state.now)) return panic(10, "pledge expired");
  if (call.expiry_ms > state.now + PLEDGE_TTL_MS) return panic(11, "pledge expiry too far");
  if (state.ticketRequired) {
    if (!call.ticket) return panic(12, "ticket signature required");
    if (call.ticket === SIG.BAD) return panic(12, "bad ticket signature");
    if (call.ticket !== SIG.VALID) return panic(12, "ticket signer not registered");
  }
  if (call.caller !== call.fund_account) {
    return { kind: "return", step: 13, stores: [], value: { outcome: "refused", message: "caller is not the fund named in the servicer signature", attempt_id: "none" } };
  }
  const fundId = state.fundsByAccount[call.caller];
  if (!fundId) return panic(14, "caller is not a registered fund account");
  const message = `truenav-pledge-v1|${state.contract}|${networkOf(state.contract)}|${call.loan_hash}|${call.fund_account}|${call.asset_type}|${call.nonce}|${call.expiry_ms}`;
  if (state.usedNonces.has(message)) return panic(15, "pledge nonce already used");
  const lock = state.locks[call.loan_hash];
  if (lock && lock.fund_id === fundId) return { kind: "return", step: 16, stores: ["nonce"], message, value: { outcome: "already_yours", token_id: call.loan_hash } };
  if (lock) {
    const attempt_id = `attempt-${state.attemptSeq + 1}`;
    return { kind: "return", step: 17, stores: ["nonce", `attempt ${attempt_id} on ${fundId}`, `alert on ${fundId}`], message, fundId, value: { outcome: "refused", message: "already pledged elsewhere", attempt_id } };
  }
  return { kind: "return", step: 18, stores: ["nonce", `lock on ${fundId}`, "pledge token minted to the caller"], message, fundId, value: { outcome: "pledged", token_id: call.loan_hash } };
}

export function networkOf(account) {
  const last = String(account || "").split(".").pop();
  return last === "testnet" ? "testnet" : last === "near" ? "mainnet" : last;
}

/** Apply a successful simulated return to a session copy of the state, so a repeat shows the next rule. */
export function applyOutcome(state, result) {
  if (result.kind !== "return" || !result.message) return state;
  const next = { ...state, usedNonces: new Set(state.usedNonces), locks: { ...state.locks } };
  next.usedNonces.add(result.message);
  if (result.value.outcome === "refused" && result.value.attempt_id !== "none") next.attemptSeq = state.attemptSeq + 1;
  if (result.value.outcome === "pledged") next.locks[result.value.token_id] = { fund_id: result.fundId };
  return next;
}

/** The decision order, for display next to the result. */
export const PLEDGE_STEPS = Object.freeze([
  "1 yoctoNEAR attached", "registry not paused", "loan_hash is 64 lowercase hex", "asset_type is real_estate or invoices",
  "nonce is 32 to 64 lowercase hex", "fund_account has no '|'", "servicer pledge key is set", "servicer signature recovers",
  "signature is from the registered pledge key", "pledge not expired", "expiry within 24 hours", "ticket, when ticket signers are registered",
  "caller is the fund named in the signature (else refused, nothing stored)", "caller is a registered fund account", "nonce not used before",
  "lock held by the same fund: already yours", "lock held by another fund: refused, 1 attempt and 1 alert on the caller", "otherwise: pledged, token minted",
]);
