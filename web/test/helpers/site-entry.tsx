// Bundle entry for web/test/site-pages.test.mjs: renders every marketing page to HTML on the server, in the same module
// graph as React, so hooks work. Home needs a browser (window), so its story and notice are rendered instead.
import { createElement, Fragment } from "react";
import { renderToString } from "react-dom/server";
import { appRoute } from "../../src/routes";
import { SITE_PAGES } from "../../src/site/pages";
import { NAV, NOTICE, Notice } from "../../src/site/Shell";
import { HomeStory } from "../../src/site/story";

export function renderAll() {
  const html: Record<string, string> = {};
  for (const [path, def] of Object.entries(SITE_PAGES)) {
    html[path] = path === "/"
      ? renderToString(createElement(Fragment, null, createElement(Notice), createElement(HomeStory)))
      : renderToString(createElement(def.C));
  }
  const meta = Object.fromEntries(Object.entries(SITE_PAGES).map(([p, d]) => [p, { title: d.title, description: d.description }]));
  return { html, meta };
}

export const isAppRoute = (path: string) => appRoute(path).title !== "Not found";
export { NAV, NOTICE };
