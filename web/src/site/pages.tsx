// The marketing route table: path, page, <title> and meta description. App.tsx renders from it, and the tests walk it.
import { type ComponentType } from "react";
import { About } from "./About";
import { BuiltOnNear } from "./BuiltOnNear";
import { Docs } from "./Docs";
import { Evidence } from "./Evidence";
import { Home } from "./Home";
import { Investors } from "./Investors";
import { Managers } from "./Managers";
import { MethodologyPage } from "./Methodology";
import { Pilot } from "./Pilot";
import { Product } from "./Product";
import { Roadmap } from "./Roadmap";
import { Security } from "./Security";
import { Technology } from "./Technology";

export type SitePageDef = { C: ComponentType<any>; title: string; description: string };

export const SITE_PAGES: Record<string, SitePageDef> = {
  "/": { C: Home, title: "TrueNav: private verification for tokenized fund NAV", description: "TrueNav checks tokenized private-credit funds privately inside a TEE on NEAR. Investors see an independent value next to the reported NAV. Testnet demo, fictional funds." },
  "/product": { C: Product, title: "Product · TrueNav", description: "One check, both sides of the trade: an independent value for investors and a public receipt for managers, with the loans kept private. Testnet demo." },
  "/investors": { C: Investors, title: "For investors and allocators · TrueNav", description: "See the gap between a tokenized fund's reported NAV and the loans behind it: an independent value, a range and a score you can re-check yourself. Testnet demo." },
  "/managers": { C: Managers, title: "For fund managers and administrators · TrueNav", description: "Prove your NAV without exposing your loans. Documents are checked in a TEE and only a public receipt of allowlisted fields goes out. Testnet demo." },
  "/technology": { C: Technology, title: "Technology · TrueNav", description: "How private loan documents become a public receipt: a TEE, a public credit model, a contract on NEAR testnet and a verifier that needs no key." },
  "/built-on-near": { C: BuiltOnNear, title: "Built on NEAR · TrueNav", description: "Why TrueNav is built on NEAR: private inference in NEAR AI Cloud TEEs, OutLayer, a registry contract, and how it maps to the Privacy and Open Innovation tracks." },
  "/methodology": { C: MethodologyPage, title: "Methodology · TrueNav", description: "The published rules behind TrueVal, TrueRange and the TrueNav score from 0 to 100, with holds, caps and the demo model tables." },
  "/security": { C: Security, title: "Privacy and security · TrueNav", description: "What TrueNav keeps private, what is public, what the TEE and the contract check, and the known limits stated openly." },
  "/evidence": { C: Evidence, title: "Evidence · TrueNav", description: "Real NEAR testnet transactions and the commands that re-run each TrueNav check with no key, no account and no funds." },
  "/roadmap": { C: Roadmap, title: "Roadmap · TrueNav", description: "What is live on NEAR testnet today and what is planned. Every planned item is labeled as not live." },
  "/docs": { C: Docs, title: "Docs and whitepaper · TrueNav", description: "The TrueNav whitepaper and the public docs: try it, architecture, trust model, threat model, known limits and the source code." },
  "/about": { C: About, title: "About · TrueNav Labs", description: "TrueNav Labs builds private verification for tokenized credit on NEAR. Built at NEAR HACKATHON 2026, 5 to 14 November, for the Privacy and Open Innovation tracks." },
  "/pilot": { C: Pilot, title: "Request a pilot · TrueNav", description: "An invitation to try TrueNav on your own question. No pilot is running yet. Testnet only, with fictional funds." },
};

export const SITE_PATHS = new Set(Object.keys(SITE_PAGES));
export const siteKey = (path: string) => (path.split(/[?#]/)[0].replace(/\/+$/, "") || "/");
