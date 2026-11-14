import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader, shouldShowLoader } from "./components/Loader";
import { prefersReducedMotion } from "./lib/motion";
import { SITE_PAGES, SITE_PATHS, siteKey } from "./site/pages";
import { AppShell } from "./shell/AppShell";
import { RegistryProvider } from "./shell/store";
import { WalletProvider } from "./shell/wallet";
import "./shell/assist";
import { Skel } from "./shell/kit";
import { usePath } from "./ui";
import { appRoute } from "./routes";

const FADE_MS = 200;

const DEFAULT_DESC = "TrueNav demo app: independent value checks for tokenized private-credit funds on NEAR testnet. Fictional funds and data.";

function setMeta(title: string, description: string) {
  document.title = title;
  let m = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (!m) {
    m = document.createElement("meta");
    m.name = "description";
    document.head.appendChild(m);
  }
  m.content = description;
}

function Site({ path }: { path: string }) {
  const url = new URL(path, "http://truenav.local");
  const p = siteKey(url.pathname);
  const def = SITE_PAGES[p];
  useEffect(() => {
    if (def) setMeta(def.title, def.description);
  }, [def]);
  if (!def) return null;
  if (p === "/") return <def.C freezeAt={url.searchParams.has("t") ? parseFloat(url.searchParams.get("t") || "0") : undefined} />;
  return <def.C />;
}

const SITE = SITE_PATHS;
const pageOf = (path: string) => path.split(/[?#]/)[0];

function usePageFade(path: string) {
  const [shown, setShown] = useState(path);
  const [phase, setPhase] = useState<"in" | "out">("in");
  useEffect(() => {
    if (path === shown) return;
    const app = !SITE.has(pageOf(path).replace(/\/+$/, "") || "/");
    if (pageOf(path) === pageOf(shown) || prefersReducedMotion() || app) {
      setShown(path);
      return;
    }
    setPhase("out");
    const id = window.setTimeout(() => { setShown(path); setPhase("in"); }, FADE_MS);
    return () => window.clearTimeout(id);
  }, [path, shown]);
  const page = pageOf(shown);
  useLayoutEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
    else document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [page]);
  return { shown, phase };
}

function AppPage({ path }: { path: string }): ReactNode {
  const Page = appRoute(path);
  useEffect(() => {
    setMeta(`${Page.title} · TrueNav (testnet)`, DEFAULT_DESC);
  }, [Page.title]);
  return (
    <AppShell path={path}>
      <Suspense fallback={<Skel rows={6} h={18} />}>
        <Page.C {...Page.props} />
      </Suspense>
    </AppShell>
  );
}

export function App() {
  const path = usePath();
  const { shown, phase } = usePageFade(path);
  const appRef = useRef<HTMLDivElement>(null);
  const isSite = SITE.has(pageOf(shown).replace(/\/+$/, "") || "/");
  const [loading, setLoading] = useState(() => isSite && shouldShowLoader(window.location.search));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const go = () => live && setReady(true);
    if (document.fonts?.ready) void document.fonts.ready.then(go);
    else go();
    return () => { live = false; };
  }, []);
  const done = useCallback(() => setLoading(false), []);
  return (
    <RegistryProvider>
      <WalletProvider>
        <div ref={appRef} className={`app${loading ? " loading" : ""} fade-${phase}`} aria-hidden={loading || undefined}>
          {isSite ? <Site key={pageOf(shown)} path={shown} /> : <AppPage key={pageOf(shown)} path={shown} />}
        </div>
        {loading ? <Loader ready={ready} app={appRef} onDone={done} /> : null}
      </WalletProvider>
    </RegistryProvider>
  );
}

