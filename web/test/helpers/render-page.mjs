// Render one page component to HTML on the server, without a browser: bundle it with the web app's own Vite and
// React (a throwaway build inside web/node_modules/.cache), then renderToString. Only for pages without hooks.
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const WEB = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const canRender = existsSync(join(WEB, "node_modules/vite")) && existsSync(join(WEB, "node_modules/@vitejs/plugin-react"));

export async function renderPage(srcRelative) {
  const req = createRequire(join(WEB, "package.json"));
  const { build } = await import(pathToFileURL(req.resolve("vite")).href);
  const react = (await import(pathToFileURL(req.resolve("@vitejs/plugin-react")).href)).default;
  const outDir = join(WEB, "node_modules/.cache", `tn-render-${randomBytes(4).toString("hex")}`);
  mkdirSync(outDir, { recursive: true });
  try {
    await build({ root: WEB, logLevel: "silent", configFile: false, plugins: [react()], build: { ssr: join(WEB, srcRelative), outDir, emptyOutDir: true, minify: false, write: true } });
    const name = srcRelative.split("/").pop().replace(/\.tsx?$/, ".js");
    const mod = await import(pathToFileURL(join(outDir, name)).href);
    const React = await import(pathToFileURL(req.resolve("react")).href);
    const { renderToString } = await import(pathToFileURL(req.resolve("react-dom/server")).href);
    return renderToString(React.createElement(mod.default));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
/** The visible text of an HTML string, entities decoded and whitespace collapsed. */
export const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENT[m]).replace(/\s+/g, " ");
/** The first <section> with the given id. Panels do not nest sections. */
export function sectionById(html, id) {
  const m = new RegExp(`<section[^>]*id="${id}"[^>]*>[\\s\\S]*?</section>`).exec(html);
  return m ? m[0] : null;
}
