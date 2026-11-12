// Mount points for the depth modules (built on a separate branch in web/modules/ and web/data/demo|feeds/).
// The shell and pages only read these props. src/depth/mount.tsx fills them from web/modules at start-up. Every slot is optional: an empty slot renders nothing, never a placeholder that pretends.
import type { ComponentType, ReactNode } from "react";

export type FundTabSlot = { id: string; label: string; Component: ComponentType<{ fundId: string }> };

export type Slots = {
  /** Market ticker strip under the top bar (external feeds). */
  Ticker?: ComponentType;
  /** Full markets page at /markets. */
  Markets?: ComponentType;
  /** Extra fund detail tabs: data room loan book, exposure, cash flows, stress, documents, reports. */
  fundTabs: FundTabSlot[];
  /** Extra panel on the overview page (for example market context). */
  OverviewExtra?: ComponentType;
  /** Role views: home page per role, keyed "investor" | "manager" | "auditor". */
  roleHome?: Partial<Record<"investor" | "manager" | "auditor", ComponentType>>;
  /** Printable report page for a fund at /reports/:fundId. */
  Report?: ComponentType<{ fundId: string }>;
  /** Extra panel on a loan page (data room lens for a demo loan). */
  LoanExtra?: ComponentType<{ hash: string }>;
  /** Report bundle download button for a fund. */
  ReportButton?: ComponentType<{ fundId: string }>;
  /** Wallet button in the top bar (NEP-413 sign-in), pending the dependency approval. */
  Wallet?: ComponentType;
  /** AI answer backend for the help bubble. Absent: the bubble answers from the FAQ and glossary in the browser. */
  ask?: (question: string, page: string) => Promise<{ answer: string; sources: string[] } | null>;
};

export const SLOTS: Slots = {
  fundTabs: [],
};

export const slotOr = (C: ComponentType | undefined, fallback: ReactNode = null) => (C ? <C /> : fallback);
