// Argument and environment handling for receipts/deploy-testnet.mjs, kept apart so it can be tested without a network.
//
// The master account has NO default: pass --master <account.testnet> or set TRUENAV_MASTER (both given must agree).
// Executing against an account that already hosted an earlier deploy is refused. TRUENAV_RPC and TRUENAV_PINS_FILE
// exist only so a print-only run can be checked against a local fake chain in tests; with --execute they are refused,
// so a real transaction can only ever go to the public testnet RPC and be checked against the committed pins.
export const DEFAULT_RPC = "https://rpc.testnet.near.org";
/** Masters of earlier deploys. Never reused: a fresh faucet account is required. Read-only runs are still allowed. */
export const USED_MASTERS = ["tnlab-718ca9.testnet", "tnlab-368aa2.testnet"];
export const STEPS = ["D0", "D1", "D2", "D3", "D4"];
export const USAGE = "usage: node receipts/deploy-testnet.mjs D0|D1|D2|D3|D4 --master <fresh-account.testnet> [--execute]   (or set TRUENAV_MASTER)";
// a named testnet account that can hold four sub-accounts: lowercase, 2 to 40 chars before ".testnet" (sub-account ids stay under 64)
const MASTER_RE = /^[a-z0-9]([a-z0-9_-]{0,38}[a-z0-9])?\.testnet$/;

export class UsageError extends Error {}

export function parseDeployArgs(argv, env = process.env) {
  let step = null;
  let execute = false;
  let flagMaster = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") execute = true;
    else if (a === "--master") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new UsageError("--master needs an account id");
      flagMaster = v;
    } else if (a.startsWith("--")) throw new UsageError(`unknown flag ${a}`);
    else if (step === null) step = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!STEPS.includes(step)) throw new UsageError("a step is required: D0, D1, D2, D3 or D4");
  const envMaster = env.TRUENAV_MASTER || null;
  if (flagMaster && envMaster && flagMaster !== envMaster) throw new UsageError("--master and TRUENAV_MASTER differ; give one");
  const master = flagMaster || envMaster;
  if (!master) throw new UsageError("no master account: pass --master <fresh-account.testnet> or set TRUENAV_MASTER. There is no default.");
  if (!MASTER_RE.test(master)) throw new UsageError("the master must be a lowercase named testnet account such as my-fresh-1.testnet");
  if (execute && USED_MASTERS.includes(master)) throw new UsageError(`refusing to execute on ${master}: it hosted an earlier deploy. Use a fresh faucet account.`);
  if (execute && (env.TRUENAV_RPC || env.TRUENAV_PINS_FILE)) throw new UsageError("TRUENAV_RPC and TRUENAV_PINS_FILE are for print-only runs; refused with --execute");
  return { step, execute, master, rpc: env.TRUENAV_RPC || DEFAULT_RPC, pinsFile: env.TRUENAV_PINS_FILE || null };
}
