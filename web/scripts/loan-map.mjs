// Writes web/data/loan-map.json: fund_id, loan_id and loan_hash for the 16 live loans, from tee/loans.json.
// Only these three fields: document ids, principals and file paths stay out of the web bundle.
import { readFileSync, writeFileSync } from "node:fs";

const src = JSON.parse(readFileSync(new URL("../../tee/loans.json", import.meta.url), "utf8"));
const loans = src.loans.filter((l) => !l.tampered).map(({ fund_id, loan_id, loan_hash, asset_type }) => ({ fund_id, loan_id, loan_hash, asset_type }));
writeFileSync(new URL("../data/loan-map.json", import.meta.url), JSON.stringify({ source: "tee/loans.json (non-tampered loans only)", loans }, null, 1) + "\n");
console.log(`${loans.length} loans`);
