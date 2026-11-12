// Which recorded TEE verdict set a script should use, from the contract it is pointed at. One place, so verify:attestation
// and check:chain-replies agree.
//
//   contract = --contract flag, else TRUENAV_CONTRACT, else the registry in tee/status.json when it says live, else the
//              earlier instance
//   the current registry (status live)  -> its set: status.verdicts_file and status.report_file
//   the earlier instance                -> tee/fixtures/verdicts.json and tee/fixtures/attestation-report.json.b64
//   --verdicts / --report (or TRUENAV_VERDICTS / TRUENAV_REPORT) override the paths for any contract.
// A named file that does not exist is an error, not a silent fallback.
import { existsSync } from "node:fs";
import { readStatus } from "./status.mjs";

export const EARLIER_VERDICTS = "tee/fixtures/verdicts.json";
export const EARLIER_REPORT = "tee/fixtures/attestation-report.json.b64";

/** The value after `--name`, or undefined. Throws when the flag has no value. */
export function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return argv[i + 1];
}

/** @returns {{ contract: string, verdictsPath: string, reportPath: string, which: string }} ; throws with a clear message. */
export function resolveSet({ argv = [], env = process.env, root = new URL("../", import.meta.url), status = readStatus(root) } = {}) {
  const contract = flag(argv, "--contract") || env.TRUENAV_CONTRACT || (status.tee === "live" ? status.registry : status.earlier_instance);
  let verdictsPath = flag(argv, "--verdicts") || env.TRUENAV_VERDICTS;
  let reportPath = flag(argv, "--report") || env.TRUENAV_REPORT;
  let which = "paths given by flag or environment";
  if (!verdictsPath || !reportPath) {
    if (contract === status.registry && status.tee === "live") {
      verdictsPath ??= status.verdicts_file;
      reportPath ??= status.report_file;
      which = `the current registry's set from tee/status.json`;
    } else if (contract === status.earlier_instance) {
      verdictsPath ??= EARLIER_VERDICTS;
      reportPath ??= EARLIER_REPORT;
      which = "the earlier instance's recorded set";
    } else if (contract === status.registry) {
      throw new Error(`no recorded TEE set for ${contract}: tee/status.json says ${status.tee}. Use --contract ${status.earlier_instance} for the earlier instance's set, or pass --verdicts and --report.`);
    } else {
      throw new Error(`no recorded TEE set for ${contract}: it is neither ${status.registry} nor ${status.earlier_instance}. Pass --verdicts and --report.`);
    }
  }
  for (const [name, p] of [["verdicts file", verdictsPath], ["attestation report", reportPath]]) {
    if (!existsSync(new URL(p, root))) throw new Error(`the ${name} ${p} does not exist (${which}). Nothing was checked.`);
  }
  return { contract, verdictsPath, reportPath, which };
}
