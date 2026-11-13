// React state for the request_run write button. Logic only, no layout: the view lives in shell/ReceiptRunAction.tsx.
// Flow: pick a token -> review (read-only preflight views) -> confirm (exact call shown) -> wallet -> outcome.
import { useCallback, useEffect, useRef, useState } from "react";
import { RECEIPTS_CONTRACT, viewFunction } from "./near.mjs";
import { confirmRows, preflightRequestRun, sendConfirmedCall } from "./receipts-write.mjs";

export type RunCall = {
  receiverId: string; method: string; args: { token_id: string }; argsJson: string;
  gas: string; gasTgas: number; depositYocto: string; depositNear: string;
};
export type RunOutcome =
  | { kind: "stored" | "run_failed" | "refused" | "submitted" | "unknown"; hash: string | null; explorerUrl: string | null; detail: string }
  | { kind: "rejected" | "timeout" | "guard" | "error"; message: string };
export type RunPhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "blocked"; reasons: string[] }
  | { phase: "confirm"; call: RunCall; rows: [string, string][] }
  | { phase: "signing"; call: RunCall; rows: [string, string][] }
  | { phase: "done"; call: RunCall; outcome: RunOutcome };

type Send = (method: string, args?: Record<string, unknown>, opts?: { gas?: string; depositYocto?: string }) => Promise<unknown>;

type View = (o: { contractId: string; method: string; args: Record<string, unknown> }) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Read-only view on the receipts contract (near.mjs viewFunction, testnet RPC with failover). */
const receiptsView = (method: string, args: Record<string, unknown>) => (viewFunction as unknown as View)({ contractId: RECEIPTS_CONTRACT, method, args });

export function useReceiptsRun({ accountId, sendReceiptsCall }: { accountId: string; sendReceiptsCall: Send }) {
  const [tokens, setTokens] = useState<string[]>([]);
  const [tokenId, setTokenId] = useState("");
  const [state, setState] = useState<RunPhase>({ phase: "idle" });
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    receiptsView("list_tokens", {})
      .then((list) => {
        if (!live.current || !Array.isArray(list)) return;
        const ids = list.map((t: { token_id?: unknown }) => t && t.token_id).filter((x: unknown): x is string => typeof x === "string");
        setTokens(ids);
        setTokenId((cur) => cur || ids[0] || "");
      })
      .catch(() => {
        if (live.current) setState({ phase: "blocked", reasons: ["Could not read the receipts token list from testnet RPC."] });
      });
    return () => {
      live.current = false;
    };
  }, []);

  // A different account or token invalidates a pending confirm.
  useEffect(() => {
    setState((s) => (s.phase === "signing" ? s : { phase: "idle" }));
  }, [accountId, tokenId]);

  const review = useCallback(async () => {
    setState({ phase: "checking" });
    try {
      const r = await preflightRequestRun({ accountId, tokenId, view: receiptsView });
      if (!live.current) return;
      if (r.ok && r.call) setState({ phase: "confirm", call: r.call as RunCall, rows: confirmRows(r.call) as [string, string][] });
      else setState({ phase: "blocked", reasons: r.reasons });
    } catch {
      if (live.current) setState({ phase: "blocked", reasons: ["Could not read the receipts contract from testnet RPC. Nothing was sent."] });
    }
  }, [accountId, tokenId]);

  const confirm = useCallback(async () => {
    if (state.phase !== "confirm") return;
    const { call, rows } = state;
    setState({ phase: "signing", call, rows });
    const outcome = (await sendConfirmedCall(sendReceiptsCall, call)) as RunOutcome;
    if (live.current) setState({ phase: "done", call, outcome });
  }, [state, sendReceiptsCall]);

  const cancel = useCallback(() => setState({ phase: "idle" }), []);

  return { tokens, tokenId, setTokenId, state, review, confirm, cancel };
}
