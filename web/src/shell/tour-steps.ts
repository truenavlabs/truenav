// The guided product tour as plain data: one story across every app page, no JSX so tests can read it directly.
// An info step moves on with Next. An action step says exactly what to click and moves on by itself when the click
// has had its effect (a tab shows, a row turns red, the pill reads again). Next always works as a fallback.
// The step number lives in the URL (?tour=N), so a reload or a shared link resumes the tour.

export const TOUR_KEY = "truenav.tour";

const MERIDIAN = "/funds/meridian-yield-fund";
const LOAN = "/loans/33b1021e2f696e6a5832226e6512df342213901fdc889c9e189f93db6f89cedc"; // Meridian M-IN-03

export type TourDone =
  | { kind: "path"; path: string } // the click navigates: the page path becomes this
  | { kind: "exists"; selector: string } // the click changes the page: this element appears
  | { kind: "reread" }; // the live pill reads the registry again

export type TourStep = {
  id: string;
  kind: "info" | "action";
  path: string; // the page (and tab) the step is shown on
  target: string; // CSS selector of the one thing to point at
  mobileTarget?: string; // used instead of target on narrow screens
  title: string;
  body: string; // 1 to 3 short plain sentences: what this shows and what it proves
  act?: string; // action steps only: exactly what to click
  done?: TourDone; // action steps only: how the tour knows it worked
  link?: { label: string; tx?: "refusedPledge" };
};

const info = (id: string, path: string, target: string, title: string, body: string, more: Partial<TourStep> = {}): TourStep => ({ id, kind: "info", path, target, title, body, ...more });
const action = (id: string, path: string, target: string, title: string, act: string, body: string, done: TourDone, more: Partial<TourStep> = {}): TourStep => ({ id, kind: "action", path, target, title, act, body, done, ...more });

const FEATURE_WHAT = '[data-tour="f-what"]';

export const TOUR_STEPS: TourStep[] = [
  info("welcome", "/overview", ".pagehead h1", "Welcome to the TrueNav demo",
    "This tour visits every page, one place at a time. Funds, loans and documents are fictional, and every read comes from NEAR testnet. Skip it any time."),
  info("menu", "/overview", ".sb nav", "Every page is in the menu",
    "Funds, loans, role views, the verifier, the feature pages and the learn pages are all here. The tour visits each one.", { mobileTarget: ".menubtn" }),
  action("live-read", "/overview", ".livepill", "The live pill", "Click the live pill to read the chain again.",
    "Your browser reads the registry on NEAR testnet and shows the time and block of the read. That is how you know a number is read now and not pasted in.", { kind: "reread" }),
  info("nav-range", "/overview", "#t-nav", "Reported NAV against TrueRange",
    "Each marker is a fund's reported NAV. The bar is the range its loans can support after expected losses. A red diamond sits outside it."),
  action("all-funds", "/overview", 'main a[href="/funds"]', "Open the funds list", "Click All funds.",
    "The funds panel shows each fund's score and whether its NAV sits inside the range. Open the full list.", { kind: "path", path: "/funds" }),
  info("funds-table", "/funds", '[data-tour="funds-table"]', "Every fund on one table",
    "Each row has the score, TrueVal, the range, the reported NAV and a NAV check. Only two fictional funds are registered on this testnet registry."),
  action("open-meridian", "/funds", 'main a[href="/funds/meridian-yield-fund"]', "Open a fund", "Click Meridian Yield Fund.",
    "Meridian reports more NAV than its loans support. Open it to see why it scores red.", { kind: "path", path: MERIDIAN }),
  info("fund-score", MERIDIAN, ".kpirow", "The score and the numbers behind it",
    "The score runs from 0 to 100. Meridian is red because its reported NAV sits outside TrueRange."),
  action("tab-loans", MERIDIAN, '[data-tab="loans"]', "The loan book tab", "Click the Loan book tab.",
    "Each loan shows by hash, asset type and enclave verdict only. The borrower, the amount and the document never reach the chain.", { kind: "exists", selector: '[data-tour="loan-book"]' }),
  action("tab-pledges", `${MERIDIAN}?tab=loans`, '[data-tab="pledges"]', "The pledges tab", "Click Pledges and alerts.",
    "This tab stores every refused double pledge. Open it to see Meridian's.", { kind: "exists", selector: "#t-refused" }),
  info("refused", `${MERIDIAN}?tab=pledges`, "#t-refused", "A double pledge, refused on chain",
    "Meridian tried to pledge a loan Harbor already holds. The contract refused it and stored one blocked attempt and one alert against Meridian.", { link: { label: "See the transaction", tx: "refusedPledge" } }),
  action("tab-overview", `${MERIDIAN}?tab=pledges`, '[data-tab="overview"]', "Back to the summary", "Click the Overview tab.",
    "The summary tab holds the recompute check. Open it to see your browser re-check the score.", { kind: "exists", selector: "#t-recompute" }),
  info("recompute", `${MERIDIAN}?tab=overview`, "#t-recompute > .ph", "Recompute the score yourself",
    "Your browser ran the public scoring engine on the same inputs. Each row compares its answer with the signed certificate on chain: match or differs."),
  action("tab-stress", `${MERIDIAN}?tab=overview`, '[data-tab="stress"]', "The stress tab", "Click the Stress tab.",
    "Exposure, Cash flows, Stress and the Data room add demo detail on fictional loans. Stress shows what higher defaults do to TrueVal and is not a score change on chain.", { kind: "exists", selector: "#tn-stress" }),
  info("loans-list", "/loans", '[data-tour="loans-table"] > .ph', "Every pledged loan",
    "Each pledge is a non-transferable token, listed by hash. Filter by fund or asset type, or type a hash prefix."),
  action("open-loan", "/loans", `main a[href="${LOAN}"]`, "Open one loan", "Click the loan that starts 33b1021e.",
    "This is Meridian's loan M-IN-03. Its document passed the enclave check, but the servicer's data flags it.", { kind: "path", path: LOAN }),
  info("loan-verdict", LOAN, '[data-tour="verdict-panel"]', "What the chain holds for this loan",
    "The latest verdict with its expiry, and the hashes of the request and of the enclave's signed reply. The document itself is not on chain."),
  action("signature", LOAN, '[data-tour="check-signature"]', "Check the enclave's signature", "Click Check signature.",
    "Your browser recovers who signed the enclave's reply and compares it with the TEE signer registered on chain.", { kind: "exists", selector: '[data-tour="sig-result"] .ok' }),
  info("loan-privacy", LOAN, '[data-tour="loan-privacy"]', "What stays off chain",
    "On chain: the loan hash, the holder, the verdict, the anomaly codes and two hashes. Off chain: the document and the borrower."),
  info("view-investor", "/investor", ".pagehead", "The investor view",
    "One question: can I trust this NAV? It shows each fund's score and range from the same public data every role sees, with no access control."),
  info("view-manager", "/manager", ".pagehead", "The fund manager view",
    "Pick a fund to see its own refused pledges, alerts and loans. A testnet wallet is optional, and the only testnet write is a receipt run, shown in full before you sign."),
  info("view-auditor", "/auditor", ".pagehead", "The auditor view",
    "It lists the commands that re-check every number yourself. The page does not run them for you."),
  info("markets", "/markets", ".pagehead", "Markets, for context only",
    "External market data from third parties, for comparison. None of it feeds a TrueNav score."),
  info("privacy-boundary", "/trust", "#t-privacy-boundary > .ph", "Who sees what",
    "A table of who can see what, party by party, with its sources. It also lists what this design still leaks."),
  info("trust-attestation", "/trust", "#t-attestation-evidence > .ph", "Evidence about the enclave",
    "The recorded checks on the enclave's hardware report, with the date they last passed. It says what these checks prove and what they do not."),
  info("verifier", "/verify", ".pagehead", "The verifier",
    "It runs every check in your browser against the chain and the recorded evidence. Each row says checked now, recorded or not checked, so nothing passes by default."),
  action("tamper", "/verify", '#t-tamper [data-tamper="signer"]', "Try a tamper test", "Click Change the TEE signer.",
    "One piece of evidence is changed in memory, then every check runs again. The rows that depend on it turn red, so a bad change cannot pass.", { kind: "exists", selector: ".checkrow .st-fail" }),
  info("feature-tee-underwriting", "/features/tee-underwriting", FEATURE_WHAT, "TEE underwriting",
    "An AI model inside an enclave compares each loan document with the fund's claim and signs pass or flag. The cases here are recorded, and your browser re-checks the hashes of each reply."),
  info("feature-verdicts", "/features/verdicts", FEATURE_WHAT, "On-chain verdicts",
    "The registry stores each signed verdict with its expiry and the hashes of the request and the reply. The latest one counts, and an expired one stops counting."),
  action("feature-attestation", "/features/attestation", '[data-tour="flip-report"]', "Attestation, and a tamper", "Click Flip one bit of the report.",
    "The published attestation report must hash to the value stored on chain with the TEE signer. Flip one bit and the match breaks.", { kind: "exists", selector: '[data-tour="attest-result"] .bad' }),
  action("feature-double-pledge", "/features/double-pledge", '[data-tour="simulate-pledge"]', "The double-pledge lock", "Click Simulate the call.",
    "This replays the pledge decision order on the live lock state. By default Meridian pledges a loan Harbor holds, and the contract would refuse it.", { kind: "exists", selector: '[data-tour="pledge-result"]' }),
  action("feature-engine", "/features/engine", '[data-tour="apply-t1"]', "The scoring engine", "Click Apply the T1 flag.",
    "The public engine reruns in your browser. Flagging one Harbor loan, as the enclave did for an altered document, moves the score at once. It is a what-if and not a certificate.", { kind: "exists", selector: ".panel.wi" }),
  action("feature-certificates", "/features/certificates", '[data-tour="flip-cert"]', "Signed certificates", "Click Flip one signature byte.",
    "Certificates are signed by a test key held by TrueNav Labs, not a TEE key. Your browser recovers each signer. Flip one byte and the signature no longer matches a registered signer.", { kind: "exists", selector: '[data-tour="cert-flip-note"]' }),
  info("feature-roles", "/features/roles", FEATURE_WHAT, "Roles and pause",
    "Four roles split the registry's admin powers: admin, registrar, pauser and servicer. This page compares who holds each role now with the expected setup."),
  action("feature-paid-report", "/features/paid-report", '[data-tour="paid-step"]', "The paid report API", "Click the Step 1 button.",
    "This steps through the paid report rules: a free score, a refused report with no entitlement, then a one-use purchase. It is a simulation in your browser and nothing is spent.", { kind: "exists", selector: '[data-tour="paid-log"] .panel' }),
  action("feature-agent-pin", "/features/agent-pin", '[data-tour="agent-variant"]', "The buyer agent pin", "Click Wrong engine version_key.",
    "A buying agent trusts a score only from the exact engine build it pins. A receipt from another build is declined and nothing is bought. The agent is built and tested, not deployed.", { kind: "exists", selector: '[data-tour="agent-decision"] .n-bad' }),
  info("feature-receipts-mirror", "/features/receipts-mirror", FEATURE_WHAT, "Receipts and the Base mirror",
    "Receipts record each score run so a buyer can check it without trusting the operator. Version 3 and the Base mirror are designed and tested, but not deployed."),
  info("feature-evidence", "/features/evidence", FEATURE_WHAT, "Judge and test evidence",
    "One script checks each claim the project makes in its own stage and records the result. This page shows the stages and the test counts for a named commit."),
  info("raw-data", "/data", ".pagehead", "Raw chain data",
    "Every view method of the registry has a Run button. Your browser sends the call to a public NEAR testnet RPC and shows the JSON it gets back. Views are read-only."),
  action("report", "/reports/meridian-yield-fund", "#tn-report .tn-btn", "Build the report bundle", "Click Build JSON bundle.",
    "The report is a printable sheet plus a JSON bundle with a sha256 per section, so anyone can check it was not edited. Loan detail on the sheet is fictional.", { kind: "exists", selector: ".tn-report .tn-mono" }),
  info("methodology", "/app/methodology", ".pagehead", "How the score works",
    "TrueVal is what the loans are worth after expected losses, and TrueRange is how far that can swing. The score from 0 to 100 says how far to trust the reported NAV. The model tables are demo values, not calibrated."),
  info("roadmap", "/app/roadmap", ".pagehead", "What comes next",
    "None of it is live. It covers correlated defaults, manager signed NAV, a certificate key held in a TEE and more."),
  info("status", "/status", ".pagehead", "Data status",
    "Every source this site reads, how each one is labelled, and when it was last read. Live, recorded and demo data each carry their own label."),
  info("glossary", "/glossary", ".pagehead", "Glossary",
    "Plain definitions of the terms used here, such as TrueVal, TrueRange and double pledge. The question mark next to a metric opens the same text."),
  info("faq", "/faq", ".pagehead", "Questions and answers",
    "Answers for investors, fund managers and technical readers. Each answer names the document it comes from."),
  info("support", "/support", ".pagehead", "Help and support",
    "How to ask a question, report a problem or report a security issue, and how to tell whether the testnet itself is down."),
  info("features-index", "/features", ".pagehead", "All features, one page each",
    "That was the tour. Every feature has its own page with a test you can run here. Take the tour again from this page any time."),
];

export const pathnameOf = (href: string) => new URL(href, "http://x").pathname.replace(/\/+$/, "") || "/";

/** The step in a URL, 1 to the last step, or 0 when there is none. */
export function parseTour(href: string): number {
  const v = new URL(href, "http://x").searchParams.get("tour");
  if (!v || !/^\d+$/.test(v)) return 0;
  const n = Number(v);
  return n >= 1 && n <= TOUR_STEPS.length ? n : 0;
}

/** The URL of step n: the step's page with ?tour=n. */
export function tourHref(path: string, n: number): string {
  const u = new URL(path, "http://x");
  u.searchParams.set("tour", String(n));
  return u.pathname + u.search;
}

export const tourStart = () => tourHref(TOUR_STEPS[0].path, 1);

/** Auto start once, on the app home only, and never when the tour was started, finished, skipped or switched off. */
export function shouldAutoStart({ pathname, search, stored }: { pathname: string; search: string; stored: string | null }): boolean {
  if (stored) return false;
  if (pathname !== "/overview" && pathname !== "/app") return false;
  const q = new URLSearchParams(search);
  return !q.has("notour") && !q.has("noloader") && !q.has("tour");
}
