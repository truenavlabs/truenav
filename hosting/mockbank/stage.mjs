// Refresh the committed, self-contained host runtime from the canonical synthetic sources.
// Run from any working directory: node hosting/mockbank/stage.mjs
import { copyFile, mkdir } from "node:fs/promises";

for (const file of ["mockbank/server.mjs", "mockbank/funds.mjs", "demo/data.mjs"]) {
  const source = new URL(`../../cashflow/${file}`, import.meta.url);
  const target = new URL(`./runtime/${file}`, import.meta.url);
  await mkdir(new URL(".", target), { recursive: true });
  await copyFile(source, target);
}
