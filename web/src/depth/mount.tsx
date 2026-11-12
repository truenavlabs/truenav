// Fills the shell slots with the depth modules (web/modules, web/data/demo, web/data/feeds). The heavy parts (the
// demo dataset and the feed client) load on first use, so the judge path does not pay for them.
import { lazy, Suspense, type ComponentType } from "react";
import { SLOTS } from "../shell/slots";
import { A } from "../ui";

function wrap<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const L = lazy(load);
  return (p: P) => <Suspense fallback={null}><L {...p} /></Suspense>;
}
const impl = () => import("./impl");
const fundTab = (id: string, label: string, name: "Exposure" | "CashFlows" | "Stress" | "DataRoom" | "Reports") => ({
  id, label, Component: wrap<{ fundId: string }>(() => impl().then((m) => ({ default: m[name] }))),
});

SLOTS.Ticker = wrap(() => impl().then((m) => ({ default: m.Ticker })));
SLOTS.Markets = wrap(() => impl().then((m) => ({ default: m.Markets })));
SLOTS.fundTabs = [
  fundTab("exposure", "Exposure", "Exposure"),
  fundTab("cashflows", "Cash flows", "CashFlows"),
  fundTab("stress", "Stress", "Stress"),
  fundTab("dataroom", "Data room (demo)", "DataRoom"),
  fundTab("reports", "Reports", "Reports"),
];
SLOTS.roleHome = {
  investor: wrap(() => impl().then((m) => ({ default: m.Investor }))),
  manager: wrap(() => impl().then((m) => ({ default: m.Manager }))),
  auditor: wrap(() => impl().then((m) => ({ default: m.Auditor }))),
};
SLOTS.Report = wrap<{ fundId: string }>(() => impl().then((m) => ({ default: m.Report })));
SLOTS.LoanExtra = wrap<{ hash: string }>(() => impl().then((m) => ({ default: m.LoanExtra })));
SLOTS.ReportButton = ({ fundId }: { fundId: string }) => <A className="xb ghost" href={`/reports/${fundId}`}>Report</A>;
