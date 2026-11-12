// The app's one registry read, shared by every page. Live when the chain answers; when it does not, pages get the
// committed recorded read, tagged "recorded" with its date, and never shown as live.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadRegistry } from "../../data/registry.mjs";
import { createCache, cachedLoader } from "../../data/cache.mjs";
import { dataState } from "../../data/derive.mjs";
import recordedJson from "../../data/recorded/registry-368aa2.json";

export type Registry = Awaited<ReturnType<typeof loadRegistry>>;
export type ViewTag = "live" | "recorded";

const cache = createCache();
const load = cachedLoader(cache, "registry", () => loadRegistry());
export const RECORDED = recordedJson as unknown as Registry;

type Ctx = {
  reg: Registry | null; // the live read (null while loading)
  view: Registry; // what pages render: live read, or the recorded read when offline or loading failed
  tag: ViewTag; // tag for everything in `view`
  state: "loading" | "live" | "partial" | "offline" | "stale";
  loading: boolean;
  refresh: () => void;
  now: number;
};
const RegistryContext = createContext<Ctx | null>(null);

export function RegistryProvider({ children }: { children: ReactNode }) {
  const [reg, setReg] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const run = useCallback((force = false) => {
    setLoading(true);
    load({ force })
      .then((r) => setReg(r as Registry))
      .catch(() => setReg(null))
      .finally(() => {
        setLoading(false);
        setNow(Date.now());
      });
  }, []);
  useEffect(() => {
    run();
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, [run]);
  const value = useMemo<Ctx>(() => {
    const ds = reg ? (dataState(reg, now).state as Ctx["state"]) : loading ? "loading" : "offline";
    const usable = reg && reg.state !== "offline";
    return { reg, view: usable ? reg! : RECORDED, tag: usable ? "live" : "recorded", state: loading && !reg ? "loading" : ds, loading, refresh: () => run(true), now };
  }, [reg, loading, now, run]);
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

export function useRegistry(): Ctx {
  const c = useContext(RegistryContext);
  if (!c) throw new Error("RegistryProvider missing");
  return c;
}

/** Run an async read when deps change; returns { data, error, loading, retry }. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [s, setS] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setS((p) => ({ ...p, loading: true, error: null }));
    fn().then(
      (data) => live && setS({ data, error: null, loading: false }),
      (e) => live && setS({ data: null, error: e && e.message ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...s, retry: () => setN((x) => x + 1) };
}
