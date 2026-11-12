// App routes. Pages are lazy so each loads its own data and code.
import { lazy, type ComponentType } from "react";
import { SLOTS } from "./shell/slots";

const P = {
  Overview: lazy(() => import("./pages/Overview")),
  Funds: lazy(() => import("./pages/Funds")),
  Fund: lazy(() => import("./pages/Fund")),
  Loans: lazy(() => import("./pages/Loans")),
  Loan: lazy(() => import("./pages/Loan")),
  Verify: lazy(() => import("./pages/Verify")),
  Features: lazy(() => import("./pages/features/Index")),
  F1: lazy(() => import("./pages/features/TeeUnderwriting")),
  F2: lazy(() => import("./pages/features/Verdicts")),
  F3: lazy(() => import("./pages/features/Attestation")),
  F4: lazy(() => import("./pages/features/DoublePledge")),
  F5: lazy(() => import("./pages/features/Engine")),
  F6: lazy(() => import("./pages/features/Certificates")),
  F7: lazy(() => import("./pages/features/Roles")),
  F8: lazy(() => import("./pages/features/PaidReport")),
  F9: lazy(() => import("./pages/features/AgentPin")),
  F10: lazy(() => import("./pages/features/ReceiptsMirror")),
  F11: lazy(() => import("./pages/features/Evidence")),
  Data: lazy(() => import("./pages/Data")),
  Account: lazy(() => import("./pages/Account")),
  Faq: lazy(() => import("./pages/Faq")),
  Glossary: lazy(() => import("./pages/Glossary")),
  Support: lazy(() => import("./pages/Support")),
  Trust: lazy(() => import("./pages/Trust")),
  Methodology: lazy(() => import("./pages/Methodology")),
  Status: lazy(() => import("./pages/Status")),
  Roadmap: lazy(() => import("./pages/Roadmap")),
  NotFound: lazy(() => import("./pages/NotFound")),
};

type R = { C: ComponentType<any>; props: Record<string, unknown>; title: string };
const r = (C: ComponentType<any>, title: string, props: Record<string, unknown> = {}): R => ({ C, title, props });

const FEATURES: Record<string, [keyof typeof P, string]> = {
  "tee-underwriting": ["F1", "TEE underwriting"], verdicts: ["F2", "On-chain verdicts"], attestation: ["F3", "Attestation"],
  "double-pledge": ["F4", "Double-pledge lock"], engine: ["F5", "Scoring engine"], certificates: ["F6", "Certificates"],
  roles: ["F7", "Roles and pause"], "paid-report": ["F8", "Paid report API"], "agent-pin": ["F9", "Buyer agent pin"],
  "receipts-mirror": ["F10", "Receipts and mirror"], evidence: ["F11", "Judge and test evidence"],
};

export function appRoute(path: string): R {
  const url = new URL(path, "http://truenav.local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;
  let m: RegExpMatchArray | null;
  if (p === "/overview" || p === "/app") return r(P.Overview, "Overview");
  if (p === "/funds") return r(P.Funds, "Funds");
  if ((m = p.match(/^\/funds?\/([^/]+)$/))) return r(P.Fund, "Fund", { fundId: decodeURIComponent(m[1]).replace(/^harbor$/, "harbor-credit-fund").replace(/^meridian$/, "meridian-yield-fund"), tab: q.get("tab") || undefined });
  if (p === "/loans") return r(P.Loans, "Loans", { q: q.get("q") || "" });
  if ((m = p.match(/^\/loans\/([0-9a-f]{64})$/))) return r(P.Loan, "Loan", { hash: m[1] });
  if (p === "/verify") return r(P.Verify, "Verifier");
  if (p === "/features") return r(P.Features, "Verify it yourself");
  if ((m = p.match(/^\/features\/([a-z-]+)$/)) && FEATURES[m[1]]) return r(P[FEATURES[m[1]][0]], FEATURES[m[1]][1], { q });
  if (p === "/data") return r(P.Data, "Raw chain data");
  if (p === "/account") return r(P.Account, "Account", { id: "" });
  if ((m = p.match(/^\/account\/([^/]+)$/))) return r(P.Account, "Account", { id: decodeURIComponent(m[1]) });
  if (p === "/faq") return r(P.Faq, "FAQ", { q: q.get("q") || "" });
  if (p === "/glossary") return r(P.Glossary, "Glossary");
  if (p === "/support") return r(P.Support, "Support");
  if (p === "/trust") return r(P.Trust, "Trust and privacy");
  if (p === "/methodology" || p === "/how") return r(P.Methodology, "Methodology");
  if (p === "/status" || p === "/sources") return r(P.Status, "Data status");
  if (p === "/roadmap") return r(P.Roadmap, "Roadmap");
  if ((m = p.match(/^\/reports\/([^/]+)$/)) && SLOTS.Report) return r(SLOTS.Report, "Report", { fundId: decodeURIComponent(m[1]) });
  if ((m = p.match(/^\/(investor|manager|auditor)$/)) && SLOTS.roleHome?.[m[1] as "investor"]) return r(SLOTS.roleHome[m[1] as "investor"]!, m[1][0].toUpperCase() + m[1].slice(1));
  if (p === "/markets" && SLOTS.Markets) return r(SLOTS.Markets, "Markets");
  return r(P.NotFound, "Not found");
}
