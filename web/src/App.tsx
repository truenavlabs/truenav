import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader, shouldShowLoader } from "./components/Loader";
import { prefersReducedMotion } from "./lib/motion";
import { About } from "./site/About";
import { Home } from "./site/Home";
import { Product } from "./site/Product";
import { Technology } from "./site/Technology";
import { AppShell } from "./shell/AppShell";
import { RegistryProvider } from "./shell/store";
import { WalletProvider } from "./shell/wallet";
import "./shell/assist";
import { Skel } from "./shell/kit";
import { usePath } from "./ui";
import { appRoute } from "./routes";

const FADE_MS = 200;

function Site({ path }: { path: string }) {
  const url = new URL(path, "http://truenav.local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return <Home freezeAt={url.searchParams.has("t") ? parseFloat(url.searchParams.get("t") || "0") : undefined} />;
  if (p === "/product") return <Product />;
  if (p === "/technology") return <Technology />;
  if (p === "/about") return <About />;
  return null;
}

const SITE = new Set(["/", "/product", "/technology", "/about"]);
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
    document.title = `${Page.title} · TrueNav (testnet)`;
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

