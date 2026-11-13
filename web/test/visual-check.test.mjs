// The visual check itself: on a tiny fixture site it must flag overlapping text, clipped text and an ellipsis,
// and pass a clean page. Needs Chrome; skipped when none is installed (the check prints SKIPPED in that case too).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/visual-check.mjs", import.meta.url).pathname;
const hasChrome = ["google-chrome", "chromium", "chromium-browser"].some((c) => spawnSync("which", [c]).status === 0) || !!process.env.CHROME;

function site(body) {
  const dir = mkdtempSync(join(tmpdir(), "tn-vc-site-"));
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><body style="font:14px sans-serif;margin:20px">${body}</body></html>`);
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [SCRIPT, "--dist", dir, "--only", "/"], { encoding: "utf8", timeout: 60000 });

test("visual check: flags overlap, clipping and ellipsis; passes a clean page", { skip: !hasChrome && "no Chrome on this machine" }, () => {
  const bad = site(`<div style="position:relative;height:40px"><span style="position:absolute;left:0;top:0">Pledge label</span><span style="position:absolute;left:10px;top:2px">Funds table</span></div>
    <div style="width:60px;overflow:hidden;white-space:nowrap">clipped text that is long</div>
    <div style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">TrueRange $2.73M to $3.45M</div>`);
  const good = site(`<p>One line</p><p>Another line</p><table><tr><td>a</td><td>b</td></tr></table>`);
  try {
    const b = run(bad);
    const bOut = b.stdout + b.stderr;
    assert.equal(b.status, 1, bOut);
    assert.match(bOut, /overlap: span "Pledge label" x span "Funds table"/);
    assert.match(bOut, /clipped: div "clipped text/);
    assert.match(bOut, /truncated: div "TrueRange/);
    const g = run(good);
    const gOut = g.stdout + g.stderr;
    assert.equal(g.status, 0, gOut);
    assert.match(gOut, /1 of 1 pages clean/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});
