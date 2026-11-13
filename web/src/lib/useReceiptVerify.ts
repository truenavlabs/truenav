// React state for the read-only "verify this receipt yourself" panel. Logic only, no layout:
// the view lives in shell/ReceiptVerify.tsx. All chain access is view calls and tx status RPC.
import { useCallback, useEffect, useRef, useState } from "react";
import { defaultClients, verifyReceipt } from "./receipt-verify.mjs";

export type Check = { id: string; label: string; state: "live" | "fail" | "unchecked"; detail: string; source?: string };
export type VerifyResult = {
  kind: string;
  detail: string;
  nextRequest?: string;
  receipt?: { tokenId: string; seq: string; requestId?: string | null; method?: string | null; band?: string | null; score?: unknown; wrapperSha?: string | null; envelopeSha?: string | null; blockHeight?: string | null };
  explorerUrl?: string | null;
  tx?: { hash: string | null; explorerUrl: string | null } | null;
  checks: Check[];
  summary: { counts: { live: number; fail: number; unchecked: number }; ok: boolean };
};

export type VerifyPhase =
  | { phase: "idle" }
  | { phase: "loading"; query: string }
  | { phase: "done"; result: VerifyResult }
  | { phase: "error"; message: string };

type Clients = { viewReceipts: (method: string, args?: Record<string, unknown>) => Promise<unknown>; viewRegistry: (method: string, args?: Record<string, unknown>) => Promise<unknown>; rpc: (method: string, params: unknown) => Promise<unknown> };

export function useReceiptVerify({ initialQuery = "", auto = true, clients }: { initialQuery?: string; auto?: boolean; clients?: Clients } = {}) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<VerifyPhase>({ phase: "idle" });
  const live = useRef(true);
  const api = useRef<Clients | null>(clients ?? null);
  if (!api.current) api.current = defaultClients() as Clients;

  const run = useCallback(async (q: string = query) => {
    setState({ phase: "loading", query: q });
    try {
      const clients = api.current;
      if (!clients) throw new Error("verify clients were not set");
      const result = (await verifyReceipt({ query: q, ...clients })) as VerifyResult;
      if (live.current) setState({ phase: "done", result });
    } catch (e) {
      if (live.current) setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [query]);

  useEffect(() => {
    live.current = true;
    if (auto) void run(initialQuery);
    return () => {
      live.current = false;
    };
    // Mount (or remount via key) loads get_config so an empty contract is shown without a paste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { query, setQuery, state, run };
}
