// Web data layer: live, partial and offline reads; derived numbers; session cache; CSV safety; browser recompute;
// verifier wrapper (pending library and tamper test). Offline: fetch is faked. No keys.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadRegistry, callText, FUND_IDS } from "../registry.mjs";
import { fundSummary, overviewKpis, activity, verdictState, navPosition, rangeOf, dataState, bandOf, STALE_MS } from "../derive.mjs";
import { createCache, cachedLoader } from "../cache.mjs";
import { toCsv, cell } from "../csv.mjs";
import { recomputeScores, compareWithCertificate, teeStoreFrom, whyThisScore } from "../recompute.mjs";
import { tagged, weakest, computedLabel } from "../tags.mjs";
import { runWebChecks, webSummary, PENDING_DETAIL } from "../verify.mjs";
import { loadEvidence } from "../../verifier/evidence.mjs";

const root = new URL("../../../", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const REC = json("web/data/recorded/registry-368aa2.json");
const NOW = Date.parse("2026-11-13T00:00:00Z");

/** A fake JSON-RPC endpoint that answers from the recorded read. failing: set of method names that error. */
function fakeFetch({ failing = new Set(), down = false } = {}) {
  const fund = (id) => REC.funds.find((f) => f.fund_id === id);
  const loan = (h) => REC.loans.find((l) => l.loan_hash === h);
  const views = {
    get_roles: () => REC.roles, get_signers: () => REC.signers, get_tee_signers: () => REC.teeSigners, get_servicer_pledge_key: () => REC.pledgeKey,
    get_pledge_signers: () => REC.pledgeSigners, nft_total_supply: () => String(REC.totalSupply), nft_metadata: () => REC.metadata, contract_source_metadata: () => REC.sourceMetadata,
    get_fund: (a) => fund(a.fund_id)?.fund ?? null, get_latest_certificate: (a) => fund(a.fund_id)?.certificate ?? null,
    get_certificate_count: (a) => fund(a.fund_id)?.certCount ?? 0, get_certificate_history_page: (a) => fund(a.fund_id)?.certHistory ?? [],
    get_attempts_page: (a) => fund(a.fund_id)?.attempts ?? { count: 0, attempts: [] }, get_alerts_page: (a) => fund(a.fund_id)?.alerts ?? [], get_alert_count: (a) => fund(a.fund_id)?.alertCount ?? 0,
    nft_tokens: (a) => REC.loans.slice(Number(a.from_index), Number(a.from_index) + a.limit).map((l) => l.token),
    get_lock: (a) => loan(a.loan_hash)?.lock ?? null, get_latest_verdict: (a) => loan(a.loan_hash)?.latest ?? null,
    get_verdict_count: (a) => loan(a.loan_hash)?.verdictCount ?? 0, get_flag_count: (a) => loan(a.loan_hash)?.flagCount ?? 0,
  };
  return async (_url, init) => {
    if (down) throw new TypeError("fetch failed");
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: "x", result }) });
    if (method === "block") return ok({ header: { height: 100, hash: "blockhash", timestamp_nanosec: String(NOW * 1e6) } });
    if (params.request_type === "view_account") return ok({ code_hash: REC.codeHash, storage_usage: 1, block_height: 101, block_hash: "h101" });
    const m = params.method_name;
    if (failing.has(m)) return { ok: true, json: async () => ({ error: { name: "HANDLER_ERROR", message: "boom" } }) };
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    const r = views[m](args);
    return ok({ result: [...Buffer.from(JSON.stringify(r))], block_height: 102, block_hash: "h102" });
  };
}

test("live read: every call answers, block height captured, 16 loans enumerated without loans.json", async () => {
  const reg = await loadRegistry({ url: "http://fake", fetchImpl: fakeFetch(), now: () => NOW });
  assert.equal(reg.state, "live");
  assert.deepEqual(reg.errors, []);
  assert.equal(reg.block.height, 102);
  assert.equal(reg.loans.length, 16);
  assert.equal(reg.totalSupply, 16);
  assert.equal(reg.codeHash, REC.codeHash);
  assert.deepEqual(reg.funds.map((f) => f.fund_id), [...FUND_IDS]);
});

test("partial read: a failing view gives null and an error entry, never a guessed value", async () => {
  const reg = await loadRegistry({ url: "http://fake", fetchImpl: fakeFetch({ failing: new Set(["get_latest_certificate"]) }), now: () => NOW });
  assert.equal(reg.state, "partial");
  assert.ok(reg.funds.every((f) => f.certificate === null));
  assert.ok(reg.errors.some((e) => e.call === callText("get_latest_certificate", { fund_id: "meridian-yield-fund" })));
  const m = fundSummary(reg, "meridian-yield-fund", NOW);
  assert.equal(m.score, null);
  assert.equal(m.trueVal, null);
});

test("offline read: nothing answers, state offline, no loans and no funds data", async () => {
  const reg = await loadRegistry({ url: "http://fake", fetchImpl: fakeFetch({ down: true }), now: () => NOW });
  assert.equal(reg.state, "offline");
  assert.equal(reg.loans.length, 0);
  assert.ok(reg.funds.every((f) => f.certificate === null && f.fund === null));
  assert.equal(dataState(reg, NOW).state, "offline");
});

test("derived numbers match the live certificates (Harbor 99 green inside, Meridian 43 red above range)", () => {
  const h = fundSummary(REC, "harbor-credit-fund", NOW);
  const m = fundSummary(REC, "meridian-yield-fund", NOW);
  assert.equal(h.score, 99);
  assert.equal(h.trueVal, 966511000);
  assert.equal(h.headlinePosition, "inside");
  assert.equal(h.loans, 11);
  assert.deepEqual(h.byAsset, { real_estate: 8, invoices: 3 });
  assert.equal(m.score, 43);
  assert.equal(m.band, "red");
  assert.equal(m.headlinePosition, "above");
  assert.equal(m.range.low, 309297000 - 36143458);
  assert.equal(m.range.high, 309297000 + 36143458);
  assert.equal(m.gapCents, 373500000 - (309297000 + 36143458));
  assert.equal(m.attempts, 1);
  assert.equal(m.alerts, 1);
  assert.deepEqual(m.byAsset, { real_estate: 2, invoices: 3 });
  const k = overviewKpis(REC, NOW);
  assert.equal(k.funds, 2);
  assert.equal(k.pledged, 16);
  assert.equal(k.verdictsPass, 16);
  assert.equal(k.blocked, 1);
  assert.equal(k.trueValCovered, 966511000 + 309297000);
  assert.equal(k.headlineCovered, 950000000 + 373500000);
  assert.equal(k.outsideRange, 1);
});

test("verdict expiry boundary equals the contract's: expiry equal to now is current", () => {
  assert.equal(verdictState({ expires_at_ms: 10 }, 10), "current");
  assert.equal(verdictState({ expires_at_ms: 10 }, 11), "expired");
  assert.equal(verdictState(null, 1), "none");
  const afterExpiry = fundSummary(REC, "harbor-credit-fund", Date.parse("2026-12-31T00:00:00Z"));
  assert.equal(afterExpiry.verdicts.expired, 11);
  assert.equal(afterExpiry.verdicts.pass, 0);
});

test("range helpers and bands", () => {
  const r = rangeOf({ true_val_cents: "100", true_range_cents: "10" });
  assert.deepEqual(r, { trueVal: 100, half: 10, low: 90, high: 110 });
  assert.equal(navPosition(111, r), "above");
  assert.equal(navPosition(110, r), "inside");
  assert.equal(navPosition(89, r), "below");
  assert.equal(bandOf(85), "green");
  assert.equal(bandOf(84), "yellow");
  assert.equal(bandOf(59), "red");
});

test("activity is newest first and includes the refused double pledge", () => {
  const ev = activity(REC);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i - 1].at >= ev[i].at);
  const b = ev.filter((e) => e.kind === "blocked");
  assert.equal(b.length, 1);
  assert.equal(b[0].fund_id, "meridian-yield-fund");
});

test("session cache marks old reads stale and shares in-flight loads", async () => {
  let t = 0;
  const cache = createCache({ now: () => t });
  cache.put("k", 1);
  assert.equal(cache.get("k").stale, false);
  t = STALE_MS + 1;
  assert.equal(cache.get("k").stale, true);
  let calls = 0;
  const load = cachedLoader(cache, "x", async () => ++calls);
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(calls, 1);
  assert.equal(dataState({ state: "live", readAt: new Date(0).toISOString() }, STALE_MS + 1).state, "stale");
});

test("CSV escapes quotes and neutralises formula cells", () => {
  assert.equal(cell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(cell("-5"), "'-5");
  assert.equal(cell('a "b", c'), '"a ""b"", c"');
  const csv = toCsv([{ a: 1, b: "x" }], [["a", "A"], ["b", "B"]]);
  assert.equal(csv, "A,B\r\n1,x\r\n");
});

test("tags: weakest input wins, computed from demo says so", () => {
  assert.equal(weakest(["live", "demo"]), "demo");
  assert.equal(weakest(["live", "recorded"]), "recorded");
  assert.equal(computedLabel(["live"]), "computed");
  assert.equal(computedLabel(["live", "demo"]), "computed (demo)");
  assert.throws(() => tagged(1, "sample", "x"));
});

test("browser recompute from the recorded read matches both on-chain certificates", () => {
  const fixtures = json("spec/nav/fixtures.json");
  const loanMap = json("web/data/loan-map.json").loans;
  const rs = recomputeScores({ fixtures, loanMap, teeStore: teeStoreFrom(REC) });
  for (const r of rs) {
    const stored = REC.funds.find((f) => f.fund_id === r.fundId).certificate;
    const cmp = compareWithCertificate(r, stored);
    assert.equal(cmp.match, true, JSON.stringify(cmp.rows));
  }
  const m = rs.find((r) => r.fundId === "meridian-yield-fund");
  assert.equal(m.rawX100, 4284);
  assert.equal(rs.find((r) => r.fundId === "harbor-credit-fund").rawX100, 9917);
  const why = whyThisScore(m).map((w) => w.kind);
  for (const k of ["gap", "excluded", "penalty"]) assert.ok(why.includes(k), k);
});

test("recompute notices a changed verdict: one flag moves the score off the certificate", () => {
  const fixtures = json("spec/nav/fixtures.json");
  const loanMap = json("web/data/loan-map.json").loans;
  const tee = teeStoreFrom(REC);
  const h = loanMap.find((l) => l.fund_id === "harbor-credit-fund").loan_hash;
  tee[h] = { ...tee[h], latest: { ...tee[h].latest, verdict: "flag", anomalies: ["amount_mismatch"] } };
  const r = recomputeScores({ fixtures, loanMap, teeStore: tee }).find((x) => x.fundId === "harbor-credit-fund");
  assert.equal(compareWithCertificate(r, REC.funds[0].certificate).match, false);
});

test("verifier wrapper: tamper tests turn a row red; a pending library is unchecked, never passed", async () => {
  const ev = await loadEvidence(async (p) => readFileSync(new URL(p, root), "utf8"));
  const chain = { contract: ev.status.registry, url: "fake", view: async () => { throw new (await import("../../verifier/checks.mjs")).ChainReadError("offline"); }, codeHash: async () => { throw new (await import("../../verifier/checks.mjs")).ChainReadError("offline"); } };
  const now = Date.parse("2026-11-20T00:00:00Z");
  const base = await runWebChecks({ evidence: ev, chain, now });
  const r0 = Object.fromEntries(base.checks.map((c) => [c.id, c]));
  assert.equal(r0["verdict-replies"].state, "live");
  assert.equal(base.summary.green, false); // chain offline: never green
  const t1 = Object.fromEntries((await runWebChecks({ evidence: ev, chain, now, tamper: "reply" })).checks.map((c) => [c.id, c]));
  assert.equal(t1["verdict-replies"].state, "fail");
  const t2 = Object.fromEntries((await runWebChecks({ evidence: ev, chain, now, tamper: "binding" })).checks.map((c) => [c.id, c]));
  assert.equal(t2["verdict-binding"].state, "fail");
  assert.equal(ev.verdicts.results.some((r) => r.onchain && r.onchain.response_body.includes('\\"verdict\\":\\"flag\\"') && !r.tampered), false, "tamper must not change the loaded evidence");
  const s = webSummary([{ id: "verdict-signatures", state: "unchecked", detail: PENDING_DETAIL, pendingLibrary: true }]);
  assert.deepEqual(s.pending, ["verdict-signatures"]);
  assert.equal(s.green, false);
});

test("what-if engine: certified inputs reproduce both certificates; the T1 flag on H-RE-01 takes Harbor to 51.59 red; edits are labelled", async () => {
  const { runWhatIf, isWhatIf, T1_PRESET, editTeeStore } = await import("../whatif.mjs");
  const fixtures = json("spec/nav/fixtures.json");
  const loanMap = json("web/data/loan-map.json").loans;
  const teeStore = teeStoreFrom(REC);
  const base = runWhatIf({ fixtures, loanMap, teeStore, teeEdits: {} });
  for (const r of base) assert.equal(compareWithCertificate(r, REC.funds.find((f) => f.fund_id === r.fundId).certificate).match, true, r.fundId);
  const t1 = runWhatIf({ fixtures, loanMap, teeStore, teeEdits: { [T1_PRESET.loanId]: T1_PRESET } });
  const h = t1.find((r) => r.fundId === "harbor-credit-fund");
  assert.equal(h.rawX100, 5159);
  assert.equal(h.band, "red");
  const m0 = base.find((r) => r.fundId === "meridian-yield-fund"), m1 = t1.find((r) => r.fundId === "meridian-yield-fund");
  assert.equal(m1.rawX100, m0.rawX100, "a flag on a Harbor loan leaves Meridian unchanged");
  assert.equal(isWhatIf(fixtures, fixtures, {}), false);
  assert.equal(isWhatIf(fixtures, fixtures, { "H-RE-01": T1_PRESET }), true);
  const edited = JSON.parse(JSON.stringify(fixtures)); edited.funds[0].headline_nav = 12000000;
  assert.equal(isWhatIf(fixtures, edited, {}), true);
  const pdRun = runWhatIf({ fixtures: edited, loanMap, teeStore, teeEdits: {} });
  assert.notEqual(pdRun.find((r) => r.fundId === "harbor-credit-fund").rawX100, base.find((r) => r.fundId === "harbor-credit-fund").rawX100);
  assert.deepEqual(teeStore, teeStoreFrom(REC), "editTeeStore never mutates the live store");
  assert.equal(Object.keys(editTeeStore(teeStore, loanMap, { "NOPE-1": T1_PRESET })).length, Object.keys(teeStore).length);
});

test("pledge simulator follows pledge_loan's order and reproduces the recorded refusal", async () => {
  const { simulatePledge, applyOutcome, SIG, PLEDGE_TTL_MS } = await import("../pledge-sim.mjs");
  const now = 1794411700818;
  const hre03 = json("web/data/loan-map.json").loans.find((l) => l.loan_id === "H-RE-03").loan_hash;
  assert.equal(hre03, json("web/data/recorded/tx-pledge.json").result ? "e179b87de5b28d5fd7eaa2bb191699f4f13368513b307292ae246459463e92b7" : null);
  const state = {
    paused: false, pledgeKey: "0xkey", ticketRequired: false, contract: "registry.tnlab-368aa2.testnet",
    fundsByAccount: { "harbor.tnlab-368aa2.testnet": "harbor-credit-fund", "meridian.tnlab-368aa2.testnet": "meridian-yield-fund" },
    locks: { [hre03]: { fund_id: "harbor-credit-fund" } }, usedNonces: new Set(), attemptSeq: 0, now,
  };
  const call = { deposit_yocto: "1", loan_hash: hre03, asset_type: "real_estate", fund_account: "meridian.tnlab-368aa2.testnet", nonce: "a".repeat(64), expiry_ms: now + 3600000, sig: SIG.VALID, caller: "meridian.tnlab-368aa2.testnet" };
  const refused = simulatePledge(call, state);
  assert.deepEqual(refused.value, { outcome: "refused", message: "already pledged elsewhere", attempt_id: "attempt-1" });
  // order: each earlier rule wins over every later one
  assert.match(simulatePledge({ ...call, deposit_yocto: "0", sig: SIG.BAD }, state).message, /exactly 1 yoctoNEAR/);
  assert.match(simulatePledge(call, { ...state, paused: true }).message, /paused$/);
  assert.match(simulatePledge({ ...call, loan_hash: "ABC" }, state).message, /64 lowercase hex/);
  assert.match(simulatePledge({ ...call, asset_type: "cars" }, state).message, /asset_type/);
  assert.match(simulatePledge({ ...call, nonce: "A".repeat(64) }, state).message, /nonce must be/);
  assert.match(simulatePledge({ ...call, fund_account: "a|b", caller: "a|b" }, state).message, /must not contain/);
  assert.match(simulatePledge(call, { ...state, pledgeKey: null }).message, /pledge key is not set/);
  assert.match(simulatePledge({ ...call, sig: SIG.BAD }, state).message, /bad servicer signature/);
  assert.match(simulatePledge({ ...call, sig: SIG.OTHER_KEY }, state).message, /not from the registered pledge key/);
  assert.match(simulatePledge({ ...call, expiry_ms: now }, state).message, /pledge expired/);
  assert.match(simulatePledge({ ...call, expiry_ms: now + PLEDGE_TTL_MS + 1 }, state).message, /too far/);
  assert.match(simulatePledge(call, { ...state, ticketRequired: true }).message, /ticket signature required/);
  const wrongCaller = simulatePledge({ ...call, caller: "harbor.tnlab-368aa2.testnet" }, state);
  assert.deepEqual([wrongCaller.value.attempt_id, wrongCaller.stores], ["none", []]);
  assert.match(simulatePledge({ ...call, fund_account: "x.testnet", caller: "x.testnet" }, state).message, /not a registered fund account/);
  const after = applyOutcome(state, refused);
  assert.match(simulatePledge(call, after).message, /nonce already used/);
  assert.equal(simulatePledge({ ...call, nonce: "b".repeat(64) }, after).value.attempt_id, "attempt-2");
  const mine = simulatePledge({ ...call, fund_account: "harbor.tnlab-368aa2.testnet", caller: "harbor.tnlab-368aa2.testnet" }, state);
  assert.equal(mine.value.outcome, "already_yours");
  const fresh = simulatePledge({ ...call, loan_hash: "f".repeat(64) }, state);
  assert.equal(fresh.value.outcome, "pledged");
  assert.equal(applyOutcome(state, fresh).locks["f".repeat(64)].fund_id, "meridian-yield-fund");
  assert.equal(state.usedNonces.size, 0, "the live state is never mutated");
});

test("tx decoding: the recorded refused pledge returns a value; the refused certificate panics", async () => {
  const { decodeTx } = await import("../tx.mjs");
  const p = decodeTx(json("web/data/recorded/tx-pledge.json").result);
  assert.equal(p.ok, true);
  assert.equal(p.method, "pledge_loan");
  assert.equal(p.signer, "meridian.tnlab-368aa2.testnet");
  assert.deepEqual(p.returnValue, { outcome: "refused", message: "already pledged elsewhere", attempt_id: "attempt-1" });
  assert.equal(p.args.fund_account, "meridian.tnlab-368aa2.testnet");
  const c = decodeTx(json("web/data/recorded/tx-cert.json").result);
  assert.equal(c.ok, false);
  assert.equal(c.signer, "tnlab-368aa2.testnet");
  assert.equal(c.method, "submit_certificate");
  assert.equal(c.failure, "Smart contract panicked: signer not registered");
});

test("attestation hash with WebCrypto: live on the committed report, fail on a changed report or a changed status hash", async () => {
  const { attestationHashWebCrypto } = await import("../verify.mjs");
  const ev = await loadEvidence((p) => readFileSync(new URL(p, root), "utf8"));
  const chain = { view: async (m) => (m === "get_tee_signers" ? REC.teeSigners : null) };
  assert.equal((await attestationHashWebCrypto(ev, chain)).state, "live");
  const bad = { ...ev, reportB64: ev.reportB64.slice(0, 100) + (ev.reportB64[100] === "A" ? "B" : "A") + ev.reportB64.slice(101) };
  assert.equal((await attestationHashWebCrypto(bad, chain)).state, "fail");
  assert.equal((await attestationHashWebCrypto(ev, { view: async () => [] })).state, "fail");
  assert.equal((await attestationHashWebCrypto(ev, { view: async () => { throw new Error("down"); } })).state, "unchecked");
});

test("paid report simulation: /score free, /report 402 then 200 once, then 402 already used; failed head 409 with nothing spent", async () => {
  const { createSim, FEE_YOCTO } = await import("../api-sim.mjs");
  const s = createSim();
  assert.equal((await s.score("HONEST-CREDIT")).status, 200);
  const r0 = await s.report("HONEST-CREDIT", {});
  assert.deepEqual([r0.status, r0.body.reason, r0.body.buy.attach_yocto], [402, "no entitlement given", FEE_YOCTO]);
  assert.equal((await s.report("HONEST-CREDIT", { entitlement: "nope", buyer: "a.testnet" })).body.reason, "unknown entitlement");
  const ent = await s.buy("HONEST-CREDIT", "a.testnet");
  assert.equal((await s.report("HONEST-CREDIT", { entitlement: ent.request_id, buyer: "b.testnet" })).status, 403);
  const ok = await s.report("HONEST-CREDIT", { entitlement: ent.request_id, buyer: "a.testnet" });
  assert.deepEqual([ok.status, ok.body.entitlement.uses_left], [200, 0]);
  const again = await s.report("HONEST-CREDIT", { entitlement: ent.request_id, buyer: "a.testnet" });
  assert.deepEqual([again.status, again.body.reason], [402, "entitlement already used"]);
  assert.equal((await s.score("HONEST-CREDIT")).body.score, 100, "a purchase never changes the score");
  const before = s.spent();
  const failed = await s.report("DEMO-CREDIT", { entitlement: ent.request_id, buyer: "a.testnet" });
  assert.deepEqual([failed.status, failed.body.error, s.spent()], [409, "run_failed", before]);
});

test("agent decision port: only the pinned engine is accepted; order matches agent/agent.mjs", async () => {
  const { decide, variants } = await import("../agent-sim.mjs");
  const pin = json("receipts/v3-build.json").engine.sha256;
  assert.match(pin, /^61fe33a0/);
  const now = "2026-11-13T00:00:00Z";
  const got = Object.fromEntries(variants(pin, now).map(([name, r]) => [name, decide("HONEST-CREDIT", r, { nowMs: Date.parse(now), pins: new Set([pin]) }).reason]));
  assert.deepEqual(got, {
    "Pinned engine, green": "unattested", "Wrong engine version_key": "engine_hash", "engine_version_key differs from the stored key": "engine_hash",
    "Receipt body does not match its hash": "receipt_mismatch", "Failed head": "run_failed", Red: "red", Yellow: "yellow", "Green with a cap": "capped",
    "Stale (60 days)": "stale", "Version 2 receipt, green": "green", "No receipt": "no_receipt",
  });
  const { v3EngineNotPinned } = await import("../../../agent/agent.mjs");
  assert.equal(v3EngineNotPinned({ engine_version_key: "x" }, "x", new Set([pin])), "the stored engine version_key is not a pinned build");
  assert.equal(v3EngineNotPinned({ engine_version_key: pin }, pin, new Set([pin])), null);
});
