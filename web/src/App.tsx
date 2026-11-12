import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader, shouldShowLoader } from "./components/Loader";
import { SLUGS } from "./copy";
import { DashShell } from "./dashboard/Shell";
import { FundPage } from "./dashboard/FundPage";
import { FundsPage } from "./dashboard/FundsPage";
import { prefersReducedMotion } from "./lib/motion";
import { About } from "./site/About";
import { Home } from "./site/Home";
import { Product } from "./site/Product";
import { Technology } from "./site/Technology";
import { How } from "./screens/How";
import { Investor } from "./screens/Investor";
import { Manager } from "./screens/Manager";
import { Verifier } from "./screens/Verifier";
import { A, usePath } from "./ui";

const FADE_MS = 200; // out, then in: a 0.4 s cross fade between pages

function Routes({ path }: { path: string }) {
  const url = new URL(path, "http://truenav.local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const fund = p.match(/^\/fund\/([^/]+)$/);
  const q = url.searchParams;
  if (p === "/") return <Home freezeAt={q.has("t") ? parseFloat(q.get("t") || "0") : undefined} />;
  if (p === "/product") return <Product />;
  if (p === "/technology") return <Technology />;
  if (p === "/about") return <About />;
  if (p === "/funds") return <FundsPage />;
  if (fund) {
    const id = decodeURIComponent(fund[1]);
    return <FundPage key={id} tokenId={SLUGS[id] ?? id} />;
  }
  if (p === "/verify") return <DashShell route="verify" crumb={<b>receipts</b>}><Verifier key={url.search} search={url.search} /></DashShell>;
  if (p === "/investor") return <DashShell route="investor" crumb={<b>investor</b>}><Investor /></DashShell>;
  if (p === "/manager") return <DashShell route="manager" crumb={<b>manager · fund private</b>}><Manager /></DashShell>;
  if (p === "/how") return <DashShell route="how" crumb={<b>method</b>}><How /></DashShell>;
  return (
    <DashShell route="funds" crumb={<b>not found</b>}>
      <div className="card cb">Not found. <A href="/funds">Back to funds</A></div>
    </DashShell>
  );
}

const pageOf = (path: string) => path.split(/[?#]/)[0];

// Fades the old page out and the new one in. Same-page changes (query only) swap without a fade.
function usePageFade(path: string) {
  const [shown, setShown] = useState(path);
  const [phase, setPhase] = useState<"in" | "out">("in");
  useEffect(() => {
    if (path === shown) return;
    if (pageOf(path) === pageOf(shown) || prefersReducedMotion()) {
      setShown(path);
      return;
    }
    setPhase("out");
    const id = window.setTimeout(() => {
      setShown(path);
      setPhase("in");
    }, FADE_MS);
    return () => window.clearTimeout(id);
  }, [path, shown]);
  const page = pageOf(shown);
  useLayoutEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
  }, [page]);
  return { shown, phase };
}

export function App() {
  const path = usePath();
  const { shown, phase } = usePageFade(path);
  const appRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(() => shouldShowLoader(window.location.search));
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
    <>
      <div ref={appRef} className={`app${loading ? " loading" : ""} fade-${phase}`} aria-hidden={loading || undefined}>
        <Routes key={pageOf(shown)} path={shown} />
      </div>
      {loading ? <Loader ready={ready} app={appRef} onDone={done} /> : null}
    </>
  );
}
