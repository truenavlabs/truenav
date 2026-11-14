// Build helpers/site-entry.tsx with the web app's own Vite (a throwaway build in node_modules/.cache) and load it.
import { rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { WEB } from "./render-page.mjs";

export async function loadSite() {
  const req = createRequire(join(WEB, "package.json"));
  const { build } = await import(pathToFileURL(req.resolve("vite")).href);
  const react = (await import(pathToFileURL(req.resolve("@vitejs/plugin-react")).href)).default;
  const outDir = join(WEB, "node_modules/.cache", `tn-site-${randomBytes(4).toString("hex")}`);
  mkdirSync(outDir, { recursive: true });
  try {
    await build({ root: WEB, logLevel: "silent", configFile: false, plugins: [react()], build: { ssr: join(WEB, "test/helpers/site-entry.tsx"), outDir, emptyOutDir: true, minify: false, write: true } });
    const mod = await import(pathToFileURL(join(outDir, "site-entry.js")).href);
    return { ...mod, rendered: mod.renderAll() };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
