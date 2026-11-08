// The three TEE documents of each synthetic fund, as the mock bank host serves them (GET /v1/tokens/<id>/<doc>):
// bank-feed, manager-export (the servicer tape for a credit fund) and issuer-claims. Synthetic only.
import { datasets } from "../demo/data.mjs";

export const FUNDS = ["DEMO-CREDIT", "DEMO-RENTAL", "HONEST-CREDIT", "HONEST-RENTAL"];
export function fundDocs() {
  const docs = Object.fromEntries(datasets().map((d) => [d.id, { "bank-feed": d.bank_feed, "manager-export": d.kind === "credit" ? d.servicer_tape : d.manager_export, "issuer-claims": d.issuer }]));
  for (const f of FUNDS) if (!docs[f]) throw new Error(`synthetic dataset ${f} missing`);
  return docs;
}
