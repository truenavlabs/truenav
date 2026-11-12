// Read-only check that the live registry holds the signers and accounts this repository expects. Free RPC view calls
// only (call_function views and view_account); no key, no transaction.
//
//   npm run verify:live-signer [-- --rpc <url>]
//
// Expected values: certify/live-registry.json (contract, code hash, role accounts, certificate signers, servicer pledge
// key, pledge-ticket signers) and tee/status.json (the TEE signer, its model and the attestation report sha256; the
// status must be live). The registered TEE signers must be exactly the one in tee/status.json.
// Exit 0 when every check passes, 1 when one fails, 2 on a usage or network error.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { view as chainView, codeHash as chainCodeHash, DEFAULT_RPC } from "../web/chain.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lower = (xs) => (xs || []).map((x) => String(x).toLowerCase()).sort();

/** @returns {Promise<{ ok: boolean, checks: {ok: boolean, text: string}[] }>} */
export async function checkLiveRegistry({ expected, status, view, codeHash }) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok: !!ok, text });
  const c = expected.contract;
  add(status.tee === "live", `tee/status.json says live (it says ${status.tee})`);
  add(status.registry === c, `tee/status.json names the same registry ${c} (it names ${status.registry})`);

  const hash = await codeHash(c);
  add(hash === expected.code_hash, `${c} code hash is ${expected.code_hash} (chain: ${hash})`);

  const roles = await view(c, "get_roles", {});
  for (const k of ["admin", "registrar", "pauser", "servicer", "paused"]) add(roles?.[k] === expected.roles[k], `role ${k} is ${expected.roles[k]} (chain: ${roles?.[k]})`);

  const certs = await view(c, "get_signers", {});
  add(same(lower(certs), lower(expected.certificate_signers)), `certificate signers are ${expected.certificate_signers.join(", ")} (chain: ${(certs || []).join(", ") || "none"})`);

  const pledgeKey = await view(c, "get_servicer_pledge_key", {});
  add(String(pledgeKey).toLowerCase() === expected.servicer_pledge_address.toLowerCase(), `servicer pledge key is ${expected.servicer_pledge_address} (chain: ${pledgeKey})`);

  const tickets = await view(c, "get_pledge_signers", {});
  add(same(lower((tickets || []).map((t) => t.address)), lower(expected.pledge_signers)), `pledge-ticket signers are ${expected.pledge_signers.join(", ") || "none"} (chain: ${(tickets || []).map((t) => t.address).join(", ") || "none"})`);

  const tee = await view(c, "get_tee_signers", {});
  add(Array.isArray(tee) && tee.length === 1, `exactly one TEE signer is registered (chain: ${Array.isArray(tee) ? tee.length : "?"})`);
  const t = (tee || []).find((x) => String(x.address).toLowerCase() === status.tee_signer);
  add(!!t, `the TEE signer is ${status.tee_signer} from tee/status.json (chain: ${(tee || []).map((x) => x.address).join(", ") || "none"})`);
  if (t) {
    add(t.model_id === status.model, `the TEE signer's model is ${status.model} (chain: ${t.model_id})`);
    add(t.attestation_sha256 === status.report_sha256, `the TEE signer's attestation sha256 is ${status.report_sha256} (chain: ${t.attestation_sha256})`);
  }
  return { ok: checks.every((x) => x.ok), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const bad = args.find((a, i) => (a.startsWith("--") ? a !== "--rpc" : args[i - 1] !== "--rpc"));
  if (bad || (args.includes("--rpc") && !args[args.indexOf("--rpc") + 1])) { console.error("usage: npm run verify:live-signer [-- --rpc <url>]"); process.exit(2); }
  const rpc = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : process.env.TRUENAV_RPC || DEFAULT_RPC;
  try {
    const r = await checkLiveRegistry({
      expected: readJson("certify/live-registry.json"),
      status: readJson("tee/status.json"),
      view: (c, m, a) => chainView(c, m, a, rpc),
      codeHash: (c) => chainCodeHash(c, rpc),
    });
    for (const x of r.checks) console.log(`${x.ok ? "PASS" : "FAIL"} ${x.text}`);
    console.log(r.ok ? "PASS the live registry holds the signers and accounts the repository expects" : "FAIL the live registry differs from what the repository expects");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
