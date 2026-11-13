// Investor view from the command line: read the live registry and recompute each fund's TrueNav score from
// chain data (TEE verdicts and pledge times), then check it against the signed certificate stored on chain.
// Read only, no account or key needed.
//
//   npm run chain:read                     uses the live contract (DEFAULT_CONTRACT in web/chain.mjs) on testnet
//   TRUENAV_CONTRACT=registry.<you>.testnet npm run chain:read
import { readFileSync } from "node:fs";
import { scorePortfolio } from "../engine/src/score.mjs";
import { loadChainState, DEFAULT_CONTRACT, DEFAULT_RPC } from "../web/chain.mjs";

const root = new URL("../", import.meta.url);
const contract = process.env.TRUENAV_CONTRACT || DEFAULT_CONTRACT;
const url = process.env.TRUENAV_RPC || DEFAULT_RPC;
const fx = JSON.parse(readFileSync(new URL("spec/nav/fixtures.json", root), "utf8"));
const loans = JSON.parse(readFileSync(new URL("tee/loans.json", root), "utf8")).loans.filter((l) => !l.tampered).map(({ fund_id, loan_id, loan_hash }) => ({ fund_id, loan_id, loan_hash }));

const st = await loadChainState({ funds: fx.funds.map((f) => f.fund_id), loans, contract, url });
console.log(`Contract ${st.contract} (code hash ${st.codeHash}), read ${st.readAt}`);
if (st.sourceMetadata) console.log(`Source: ${st.sourceMetadata.link || "n/a"}`);
console.log(`Certificate signers: ${st.signers.join(", ")} (test key, not TEE)`);
console.log(`TEE signers: ${st.teeSigners.map((t) => `${t.address} ${t.model_id}`).join(", ")}\n`);

const funds = JSON.parse(JSON.stringify(fx.funds));
for (const f of funds) for (const l of f.loans) {
  const m = loans.find((x) => x.fund_id === f.fund_id && x.loan_id === l.id);
  if (m) l.loan_hash = m.loan_hash;
}
// N-02: each verdict carries its on-chain expiry (web/chain.mjs), judged at the time of this read; an expired verdict
// is reported as expired and is not a pass.
const results = scorePortfolio({ pd: fx.pd, lgd: fx.lgd }, funds, { now: fx.valuation_time, certStore: fx.cert_store, teeStore: st.teeStore, verdictNow: Date.now() });

let ok = true;
for (const r of results) {
  const row = st.funds.find((x) => x.fund_id === r.fundId);
  const c = row.certificate && row.certificate.certificate;
  const raw = Math.round(r.raw * 100) / 100;
  const match = c && c.raw_x100 === Math.round(r.raw * 100) && c.band === (r.band || "");
  ok &&= !!match;
  const held = st.loans.filter((l) => l.fund_id === r.fundId && l.holder);
  console.log(`${r.fundId}: TrueNav score ${r.score ?? "none"} ${r.band ?? r.status} (raw ${raw}), recomputed from chain data`);
  console.log(`  TEE verdicts on chain: ${r.tee.pass} pass, ${r.tee.flag} flag, ${r.tee.pending} pending, ${r.tee.overdue} overdue, ${r.tee.expired} expired; past flags ${st.loans.filter((l) => l.fund_id === r.fundId).reduce((n, l) => n + l.flags, 0)}`);
  console.log(`  Pledge tokens held: ${held.length}; blocked attempts by this fund: ${row.attempts}; alerts (another fund tried its loans): ${row.alerts}`);
  console.log(`  Signed certificate on chain: ${c ? `raw ${(c.raw_x100 / 100).toFixed(2)} ${c.band}, signed ${new Date(c.signed_at_ms).toISOString()}, signer ${row.certificate.signer}` : "none"} -> ${match ? "matches the recomputed score" : "DOES NOT MATCH"}`);
}
process.exitCode = ok ? 0 : 1;
