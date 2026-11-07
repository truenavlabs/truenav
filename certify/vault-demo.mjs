// NAV circuit breaker on testnet (owner decision D3): deploy fund-share vaults that read the live registry and
// show them accepting a subscription for a green fund and refusing (with refund) a red fund, a stale certificate
// and a fund with no certificate. Every step prints an explorer link (video material).
//
//   TRUENAV_TESTNET_ACCOUNT=<name>.testnet npm run vault:testnet       (vault wasm: cd vault && cargo near build)
// The registry is registry.<name>.testnet from the same account (npm run e2e:testnet first).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from "near-api-js";

const RPC = process.env.TRUENAV_RPC || "https://test.rpc.fastnear.com";
const EXPLORER = "https://explorer.testnet.near.org/transactions/";
const master = process.env.TRUENAV_TESTNET_ACCOUNT;
if (!master || !master.endsWith(".testnet")) throw new Error("set TRUENAV_TESTNET_ACCOUNT to your throwaway testnet account");
const credDir = `${homedir()}/.near-credentials/testnet`;
const root = new URL("../", import.meta.url);
const wasmPath = new URL("vault/target/near/truenav_vault.wasm", root);
if (!existsSync(wasmPath)) throw new Error("build the vault first: cd vault && cargo near build non-reproducible-wasm");
const provider = new JsonRpcProvider({ url: RPC });
const accountOf = (id) => new Account(id, provider, JSON.parse(readFileSync(`${credDir}/${id}.json`, "utf8")).private_key);
const admin = accountOf(master);
const registry = `registry.${master}`;
const ids = { harbor: `vault-harbor.${master}`, meridian: `vault-meridian.${master}`, nocert: `vault-nocert.${master}`, investor: `investor.${master}` };
const log = [];
let failed = false;

const decode = (tx) => {
  const ok = tx.status && tx.status.SuccessValue !== undefined;
  const value = ok && tx.status.SuccessValue ? JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString()) : null;
  return { ok, value, failure: ok ? null : JSON.stringify(tx.status && tx.status.Failure).slice(0, 300), hash: tx.transaction.hash };
};
const record = (step, tx) => {
  const d = decode(tx);
  log.push({ step, tx: d.hash, url: EXPLORER + d.hash, ok: d.ok, value: d.value });
  console.log(`${d.ok ? "ok  " : "FAIL"} ${step}  ${EXPLORER}${d.hash}`);
  return d;
};
const expect = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}`);
  log.push({ check: what, pass: !!cond });
  if (!cond) failed = true;
};
async function exists(id) {
  try {
    await provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return true;
  } catch {
    return false;
  }
}
async function ensureSub(id, near) {
  if (await exists(id)) return false;
  const kp = KeyPair.fromRandom("ed25519");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(`${credDir}/${id}.json`, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  record(`create ${id}`, await admin.signAndSendTransaction({ receiverId: id, actions: [actions.createAccount(), actions.transfer(nearToYocto(near)), actions.addFullAccessKey(kp.getPublicKey())], waitUntil: "FINAL" }));
  return true;
}
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });

// 1. vaults and an investor
const wasm = new Uint8Array(readFileSync(wasmPath));
for (const [key, fund] of [["harbor", "harbor-credit-fund"], ["meridian", "meridian-yield-fund"], ["nocert", "unrated-demo-fund"]]) {
  if (await ensureSub(ids[key], "2.5")) {
    const v = accountOf(ids[key]);
    record(`deploy and init ${ids[key]} for ${fund}`, await v.signAndSendTransaction({ receiverId: ids[key], actions: [actions.deployContract(wasm), actions.functionCall("new", { registry, fund_id: fund, max_age_ms: null }, teraToGas("30"), 0n)], waitUntil: "FINAL" }));
  }
}
await ensureSub(ids.investor, "1");
const investor = accountOf(ids.investor);

// The certificates the vaults will see.
for (const fund of ["harbor-credit-fund", "meridian-yield-fund"]) {
  const c = await view(registry, "get_latest_certificate", { fund_id: fund });
  console.log(`registry: ${fund} ${c.certificate.band} ${c.certificate.score}, signed ${new Date(c.certificate.signed_at_ms).toISOString()}`);
}

const subscribe = async (vault, label, near = "0.1") => record(label, await investor.signAndSendTransaction({ receiverId: vault, actions: [actions.functionCall("subscribe", {}, teraToGas("60"), nearToYocto(near))], waitUntil: "FINAL" }));
const setAge = async (vault, ms, label) => record(label, await accountOf(ids.harbor).signAndSendTransaction({ receiverId: vault, actions: [actions.functionCall("set_max_age_ms", { max_age_ms: ms }, teraToGas("10"), 1n)], waitUntil: "FINAL" }));

// 2. green fund: accepted
const sharesBefore = BigInt(await view(ids.harbor, "get_shares", { account_id: ids.investor }));
const a = await subscribe(ids.harbor, "investor subscribes 0.1 NEAR to the Harbor vault (green)");
expect(a.ok && a.value && a.value.outcome === "subscribed" && a.value.band === "green", `Harbor vault: subscribed (band ${a.value && a.value.band}, score ${a.value && a.value.score})`);
expect(BigInt(await view(ids.harbor, "get_shares", { account_id: ids.investor })) === sharesBefore + BigInt(nearToYocto("0.1")), "investor holds 0.1 NEAR of Harbor vault shares");

// 3. red fund: refused and refunded
const r = await subscribe(ids.meridian, "investor subscribes 0.1 NEAR to the Meridian vault (red)");
expect(r.ok && r.value && r.value.outcome === "refused" && r.value.reason === "red", `Meridian vault: refused, reason ${r.value && r.value.reason}, deposit refunded`);
expect(BigInt(await view(ids.meridian, "get_shares", { account_id: ids.investor })) === 0n, "investor holds no Meridian vault shares");

// 4. stale certificate: the Harbor vault's owner shortens the accepted age to 1 minute (the certificate is older)
await setAge(ids.harbor, 60_000, "Harbor vault owner sets max certificate age to 1 minute");
const s = await subscribe(ids.harbor, "investor subscribes 0.1 NEAR to the Harbor vault (certificate now stale)");
expect(s.ok && s.value && s.value.outcome === "refused" && s.value.reason === "stale", `Harbor vault: refused, reason ${s.value && s.value.reason} (certificate ${s.value && Math.round(s.value.certificate_age_ms / 60000)} min old), deposit refunded`);
await setAge(ids.harbor, 7 * 24 * 3600 * 1000, "Harbor vault owner restores max certificate age to 7 days");

// 5. a fund with no certificate
const n = await subscribe(ids.nocert, "investor subscribes 0.1 NEAR to a vault whose fund has no certificate");
expect(n.ok && n.value && n.value.outcome === "refused" && n.value.reason === "no certificate", `unrated fund vault: refused, reason ${n.value && n.value.reason}`);

mkdirSync(new URL("out/", root), { recursive: true });
writeFileSync(new URL("out/vault-run.json", root), JSON.stringify({ note: "Testnet run of certify/vault-demo.mjs (NAV circuit breaker).", registry, vaults: ids, log }, null, 2) + "\n");
console.log(`\nRun record: out/vault-run.json  (${failed ? "SOME CHECKS FAILED" : "all checks passed"})`);
process.exitCode = failed ? 1 : 0;
