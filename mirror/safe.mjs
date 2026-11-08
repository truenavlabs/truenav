// Error redaction for the operator scripts. RPC URLs can carry API keys in the host, path or query, and viem puts the
// full URL into its error messages (HttpRequestError, TimeoutError: "URL: ..."). Every RPC call goes through guard(),
// which replaces the error with a fixed message naming only the error class; nothing of the original error (message,
// details, cause, stack) is kept. The scripts' top level prints only safeMessage(), never a raw error.
const NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
export class RedactedError extends Error {
  constructor(scope, rpcName) {
    super(`${scope} rpc error: ${rpcName}`);
    this.name = "RedactedError";
    this.rpcName = rpcName;
  }
}
export const errorName = (e) => (e && typeof e.name === "string" && NAME.test(e.name) ? e.name : "Error");
export async function guard(scope, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RedactedError) throw e;
    throw new RedactedError(scope, errorName(e));
  }
}
/** The same client, with every method call guarded. */
export function guardClient(client, scope = "base") {
  return new Proxy(client, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === "function" ? (...args) => guard(scope, () => v.apply(target, args)) : v;
    },
  });
}
// anything that looks like a URL, or a host with a port or path, in a message that did not come from an RPC call
const URLISH = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]*|\b[\w-]+(?:\.[\w-]+)+(?::\d+)?\/[^\s'"<>)]*/gi;
export function safeMessage(e) {
  if (e instanceof RedactedError) return e.message;
  const m = typeof e?.message === "string" ? e.message : "unknown error";
  return `error: ${m.replace(URLISH, "<redacted>").slice(0, 300)}`;
}
/** Run a script's main(): on failure print one redacted line and exit 1; never print a raw error or stack. */
export function runMain(main) {
  const fail = (e) => {
    process.stderr.write(`${safeMessage(e)}\n`);
    process.exitCode = 1;
  };
  process.on("unhandledRejection", fail);
  process.on("uncaughtException", fail);
  return Promise.resolve().then(main).catch(fail);
}
