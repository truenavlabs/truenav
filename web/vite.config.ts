import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @noble/curves and @noble/hashes are not web dependencies yet (they need approval). The verifier data layer imports
// them, so the bundle points those imports at a stub that throws CryptoPendingError. Checks that need them show as
// "not checked in this browser" instead of silently pulling the root repository's copies into the bundle.
const stub = fileURLToPath(new URL("./src/lib/crypto-pending.mjs", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@noble\/curves\/.*$/, replacement: stub },
      { find: /^@noble\/hashes\/.*$/, replacement: stub },
    ],
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, fs: { allow: [".."] } },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
