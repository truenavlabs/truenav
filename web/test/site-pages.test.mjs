import { createHash } from "node:crypto";
// The marketing site tree: every route renders, the routes and links resolve, and the copy rules hold on the rendered
// text (no dashes, no forbidden names, the testnet notice, informs only, live versus roadmap labels, no repo file names).
// Rendered on the server with the web app's own Vite and React; skipped when web/node_modules is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { canRender, textOf, WEB } from "./helpers/render-page.mjs";
import { loadSite } from "./helpers/render-site.mjs";

const skip = !canRender && "web/node_modules is not installed";
const read = (p) => readFileSync(join(WEB, p), "utf8");
const ROUTES = ["/", "/product", "/investors", "/managers", "/technology", "/built-on-near", "/methodology", "/security", "/evidence", "/roadmap", "/docs", "/about", "/pilot"];
let site;
const load = async () => (site ??= await loadSite());
const texts = async () => Object.fromEntries(Object.entries((await load()).rendered.html).map(([p, h]) => [p, textOf(h)]));

test("the route table is exactly the marketing tree, with a title and a description on each", { skip }, async () => {
  const { rendered } = await load();
  assert.deepEqual(Object.keys(rendered.meta).sort(), [...ROUTES].sort());
  const titles = new Set();
  for (const [p, m] of Object.entries(rendered.meta)) {
    assert.ok(m.title.length > 8 && m.title.length <= 70, `${p} title`);
    assert.ok(m.description.length >= 60 && m.description.length <= 180, `${p} description length ${m.description.length}`);
    assert.ok(!titles.has(m.title), `${p} repeats a title`);
    titles.add(m.title);
  }
});

test("every route renders real content, and every inner page has an h1, the notice and the informs-only footer", { skip }, async () => {
  const { rendered, NOTICE } = await load();
  assert.equal(NOTICE, "Testnet demo. All funds and data are fictional.");
  for (const p of ROUTES) {
    const h = rendered.html[p];
    assert.ok(h.length > 3000, `${p} rendered only ${h.length} bytes`);
    assert.ok(textOf(h).includes(NOTICE), `${p} has no testnet notice`);
    if (p !== "/") assert.match(h, /<h1[ >]/, `${p} has no h1`);
    assert.match(textOf(h), /never moves or blocks (money|any)|never blocks a transfer|never moves or blocks a/i, `${p} has no informs-only line`);
  }
});

test("no em or en dashes anywhere: rendered text, titles, site source, whitepaper markdown", { skip }, async () => {
  const { rendered } = await load();
  const bad = /[\u2013\u2014]/;
  for (const [p, h] of Object.entries(rendered.html)) assert.ok(!bad.test(h), `${p} has a dash`);
  for (const m of Object.values(rendered.meta)) assert.ok(!bad.test(m.title + m.description));
  for (const f of readdirSync(join(WEB, "src/site"))) assert.ok(!bad.test(read(`src/site/${f}`)), `src/site/${f} has a dash`);
  assert.ok(!bad.test(read("index.html")));
  assert.ok(!bad.test(readFileSync(join(WEB, "../docs/WHITEPAPER.md"), "utf8")), "docs/WHITEPAPER.md has a dash");
});

test("forbidden names, NEAR Intents and traction claims appear nowhere", { skip }, async () => {
  const t = await texts();
  // Banned identity words are kept only as sha256 hashes so this test does not publish them.
  const BANNED = new Set([
    "13c945dce632469cd1dbb3123299ac26e77c7d55985527504bf51b0668ff75d6",
    "43a52bc7d59d42b4020c698b3eff5e35c5f552b81d59eebde76594953a374bcb",
    "eaa56c180e05434c65e31c7d654cb4f462a6ae281aa16ef107747f984d1be52d",
    "99b4c037877eee21438b6b13aa6bcd14e8f3baf77fd185eb3ea11f3a0a405be7",
    "91548a28c0bebc117bd1bb62b942de3ff9df08f15b889c423fb648dec9a03a44",
    "eeca278742526b4b0cfbb2ab830bb88c740d48f02e18bae0755a149e9c8479bb",
    "96d9632f363564cc3032521409cf22a852f2032eec099ed5967c0d000cec607a",
  ]);
  const forbidden = { test: (s) => s.toLowerCase().split(/[^a-z0-9]+/).some((w) => w && BANNED.has(createHash("sha256").update(w).digest("hex"))) };
  const traction = /trusted by|testimonial|assets under management|\bAUM\b|our clients|our customers/i;
  for (const [p, x] of Object.entries(t)) {
    assert.ok(!forbidden.test(x), `${p} names a forbidden name`);
    assert.ok(!/intents/i.test(x), `${p} mentions NEAR Intents`);
    assert.ok(!traction.test(x), `${p} reads like a traction claim`);
  }
  for (const f of readdirSync(join(WEB, "src/site"))) assert.ok(!forbidden.test(read(`src/site/${f}`)), f);
  assert.ok(!forbidden.test(read("index.html")));
});

test("no repository file names or paths in the visible copy", { skip }, async () => {
  const t = await texts();
  const file = /\b[\w-]+\/[\w./-]+\.(mjs|rs|tsx?|md|json|toml|wasm)\b|\b[\w-]+\.(mjs|rs|tsx?|md|toml)\b|\b(tee|engine|contract|spec|receipts|certify)\/[\w./-]+/;
  for (const [p, x] of Object.entries(t)) {
    const m = file.exec(x);
    assert.ok(!m, `${p} shows a repo file name: ${m && m[0]}`);
  }
});

test("Chain Signatures and receipts v3 are always labeled built, pinned or planned, never live", { skip }, async () => {
  const t = await texts();
  for (const [p, x] of Object.entries(t)) {
    for (const m of x.matchAll(/Chain Signatures|Base mirror|Base Sepolia mirror/g)) {
      const around = x.slice(Math.max(0, m.index - 260), m.index + 260);
      assert.match(around, /not deployed|planned|built and tested|built, not|is built/i, `${p}: ${m[0]} without a status label`);
    }
    assert.ok(!/mirrored to Base today|receipts are mirrored\b/i.test(x), `${p} says receipts are mirrored`);
  }
  assert.match(t["/roadmap"], /planned, not live/);
  assert.match(t["/roadmap"], /None of the planned items is live/);
});

test("the hackathon origin names the event, the window and the tracks, and is never an award", { skip }, async () => {
  const { rendered } = await load();
  const about = textOf(rendered.html["/about"]);
  assert.ok(rendered.html["/about"].includes("https://nearhackathon.com"));
  assert.match(about, /between 5 and 14 November 2026, inside the event window/);
  assert.match(about, /Privacy and Private AI/);
  assert.match(about, /Open Innovation/);
  assert.match(about, /not an award/i);
  assert.ok(rendered.html["/about"].includes("https://tendaicustody.app") && !/tendaicustody\.com/.test(rendered.html["/about"]));
  const home = textOf(rendered.html["/"]);
  assert.match(home, /Built at NEAR HACKATHON 2026/);
  assert.match(home, /not an award or an endorsement/);
});

test("Built on NEAR: privacy track first, open second, the stack, why NEAR and what NEAR does not do for us", { skip }, async () => {
  const t = (await texts())["/built-on-near"];
  assert.ok(t.indexOf("Privacy and Private AI") < t.indexOf("Open Innovation"));
  for (const s of ["What a judge would test", "How it works, end to end", "Why NEAR, rather than a generic chain", "what NEAR does not do for us", "not zero knowledge"]) assert.ok(t.toLowerCase().includes(s.toLowerCase()), s);
});

test("Home story runs in the agreed order and the fixture counts are labeled demo", { skip }, async () => {
  const { rendered } = await load();
  const h = rendered.html["/"];
  const ids = ["problem", "what", "helps", "how", "why-near", "roadmap", "status"].map((id) => h.indexOf(`id="${id}"`));
  assert.ok(ids.every((i) => i >= 0), "a story section is missing");
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, "story sections are out of order");
  const facts = read("src/site/facts.ts");
  for (const l of ["demo funds scored", "demo receipts issued", "demo double pledges refused"]) assert.ok(facts.includes(l), l);
});

test("Home keeps the intro landing marker and the unchanged hero, and no longer locks the page", () => {
  const home = read("src/site/Home.tsx");
  assert.match(home, /data-tn-dot/);
  assert.match(home, /<HeroField /);
  assert.match(home, /<Notice \/>/);
  assert.match(home, /<HomeStory \/>/);
  assert.ok(!/tn-lock/.test(home), "Home still locks the page scroll");
  assert.ok(!/tn-lock/.test(read("src/site/site.css")));
  assert.match(read("src/App.tsx"), /<Loader /);
});

test("every internal link and every nav entry resolves to a marketing page, an app page or a file in public", { skip }, async () => {
  const { rendered, NAV, isAppRoute } = await load();
  const known = (href) => {
    const p = href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
    return p in rendered.meta || isAppRoute(p) || existsSync(join(WEB, "public", p));
  };
  const hrefs = new Set();
  for (const n of NAV) { hrefs.add(n.href); for (const s of n.sub ?? []) if (s.href.startsWith("/")) hrefs.add(s.href); }
  for (const h of Object.values(rendered.html)) for (const m of h.matchAll(/href="(\/[^"]*)"/g)) hrefs.add(m[1].replace(/&amp;/g, "&"));
  assert.ok(hrefs.size > 25, `only ${hrefs.size} internal links`);
  for (const href of hrefs) assert.ok(known(href), `dead link ${href}`);
  const labels = NAV.map((n) => n.label);
  assert.deepEqual(labels, ["Product", "Technology", "Built on NEAR", "Docs", "About"]);
});

test("the pilot page contacts through GitHub Issues and claims no running pilot", { skip }, async () => {
  const { rendered } = await load();
  assert.ok(rendered.html["/pilot"].includes("https://github.com/truenavlabs/truenav/issues"));
  assert.match(textOf(rendered.html["/pilot"]), /no pilot is running/i);
});

test("whitepaper: PDF and markdown are in the tree and linked from Docs and Home", { skip }, async () => {
  const { rendered } = await load();
  const pdf = join(WEB, "public/TrueNav-Whitepaper.pdf");
  assert.ok(statSync(pdf).size > 100000);
  assert.equal(readFileSync(pdf).subarray(0, 4).toString(), "%PDF");
  assert.ok(statSync(join(WEB, "../docs/WHITEPAPER.md")).size > 10000);
  for (const p of ["/docs", "/"]) assert.ok(rendered.html[p].includes('href="/TrueNav-Whitepaper.pdf"'), `${p} does not link the whitepaper`);
});

test("fonts: option C, self-hosted, each with its OFL text, and the CSS points at files that exist", () => {
  const dir = join(WEB, "public/fonts");
  for (const [font, ofl] of [["InstrumentSerif-Regular", "OFL-InstrumentSerif"], ["Inter-Variable", "OFL-Inter"], ["IBMPlexMono-Regular", "OFL-IBMPlexMono"], ["IBMPlexMono-Medium", "OFL-IBMPlexMono"]]) {
    assert.ok(existsSync(join(dir, `${font}.woff2`)), font);
    assert.match(readFileSync(join(dir, `${ofl}.txt`), "utf8"), /SIL OPEN FONT LICENSE/i);
  }
  const css = read("src/site/site.css");
  for (const m of css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)) assert.ok(existsSync(join(dir, m[1])), m[1]);
  for (const fam of ["Instrument Serif", "Inter", "IBM Plex Mono"]) assert.ok(css.includes(`font-family: "${fam}"`), fam);
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|cdnfonts|rsms\.me/.test(css + read("index.html")), "a font is loaded from a third party");
});

test("images and head tags: favicon, OG image, description, and every referenced image exists with alt text", { skip }, async () => {
  const { rendered } = await load();
  const idx = read("index.html");
  for (const f of ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "og.png"]) { assert.ok(idx.includes(f), f); assert.ok(existsSync(join(WEB, "public", f)), f); }
  assert.match(idx, /<meta name="description" content="[^"]{60,}"/);
  assert.match(idx, /og:image/);
  let imgs = 0;
  for (const [p, h] of Object.entries(rendered.html)) {
    for (const m of h.matchAll(/<img\b[^>]*>/g)) {
      imgs++;
      const src = /src="([^"]+)"/.exec(m[0])?.[1];
      assert.ok(src && existsSync(join(WEB, "public", src)), `${p}: missing image ${src}`);
      assert.match(m[0], /alt="[^"]{8,}"/, `${p}: image without alt`);
    }
    for (const m of h.matchAll(/<figure class="mk-shot">[\s\S]*?<\/figure>/g)) assert.match(textOf(m[0]), /demo/i, `${p}: a screenshot without a demo caption`);
  }
  assert.ok(imgs >= 8);
  assert.ok(readdirSync(join(WEB, "public/shots")).length >= 4);
});
