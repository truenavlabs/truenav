// Argument parsing for agent/run.mjs. The master account (the contracts are receipts.<master> and query.<master>)
// comes from --master or TRUENAV_MASTER. There is no default: a default would point a new run at an old deployment.
import { validToken } from "../api/receipt.mjs";

export const USAGE = "usage: node agent/run.mjs <TOKEN> [--execute] [--api <url>] [--master <account.testnet>]   (or set TRUENAV_MASTER)";
// a named testnet account that can hold the contract sub-accounts: lowercase, 2 to 40 characters before ".testnet"
export const MASTER_RE = /^[a-z0-9]([a-z0-9_-]{0,38}[a-z0-9])?\.testnet$/;

export class UsageError extends Error {
  constructor(message, { usage = false } = {}) { super(message); this.usage = usage; }
}

/** Returns { token, execute, apiUrl, master }. Throws UsageError({usage:true}) for a bad token or flag, UsageError for the master. */
export function parseRunArgs(argv, env = process.env) {
  let execute = false;
  let apiUrl = null;
  let flagMaster = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") execute = true;
    else if (a === "--api" || a === "--master") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`, { usage: true });
      if (a === "--api") apiUrl = v; else flagMaster = v;
    } else if (a.startsWith("--")) throw new UsageError(`unknown flag ${a}`, { usage: true });
    else rest.push(a);
  }
  // the token is checked first, so a bad token still prints the usage line whatever the environment holds
  if (rest.length !== 1 || !validToken(rest[0])) throw new UsageError("a valid token is required", { usage: true });
  const envMaster = env.TRUENAV_MASTER || null;
  if (flagMaster && envMaster && flagMaster !== envMaster) throw new UsageError(`--master ${flagMaster} disagrees with TRUENAV_MASTER ${envMaster}; give one`);
  const master = flagMaster || envMaster;
  if (!master) throw new UsageError("no master account: pass --master <account.testnet> or set TRUENAV_MASTER (there is no default)");
  if (!MASTER_RE.test(master)) throw new UsageError(`master account ${JSON.stringify(master)} is not a named .testnet account`);
  return { token: rest[0], execute, apiUrl, master };
}
