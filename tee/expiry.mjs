// The one verdict expiry rule for every client path, matching the contract (submit_verdict requires
// expires_at_ms >= now): a verdict is current while now <= expires_at_ms, and expired from expires_at_ms + 1 ms.
// engine/src/score.mjs applies the same comparison inline (the engine imports nothing), and engine/test/tee.test.mjs
// pins both boundaries there.
export const verdictExpired = (expiresAtMs, nowMs) => expiresAtMs < nowMs;
