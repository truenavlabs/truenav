// Test preload (node --import): every fetch fails the way undici fails when a host refuses the connection. For outage
// tests of scripts whose endpoint is fixed (no override), so no request leaves the machine.
const refused = (input) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
  const cause = Object.assign(new Error(`connect ECONNREFUSED (offline test preload: ${href})`), { code: "ECONNREFUSED" });
  return Promise.reject(new TypeError("fetch failed", { cause }));
};
globalThis.fetch = async (input) => refused(input);
