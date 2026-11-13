import { createElement as h, useState } from "react";
import { bpsToPct, formatUsdFromCents, shortHash } from "./format.mjs";
import { Banner, Empty, Panel, SourceChip } from "./ui.mjs";

export function loansToCsv(loans, lens) {
  const dataRoom = lens === "data_room";
  const header = dataRoom
    ? ["loan_id", "loan_hash", "asset_type", "geography", "sector", "principal_cents", "coupon_bps", "ltv_bps", "bucket", "dpd", "verdict", "mark_cents", "expected_loss_cents", "verified"]
    : ["loan_hash", "asset_type", "verdict"];
  const lines = [header.join(",")];
  for (const loan of loans) {
    const d = loan.data_room || {};
    const rec = d.recorded || {};
    const demo = d.demo || {};
    const eng = d.engine || {};
    const cells = dataRoom
      ? [d.loan_id, loan.loan_hash, loan.asset_type, demo.geography ? `${demo.geography.country}/${demo.geography.region}` : "", demo.sector, rec.principal_cents, rec.coupon_bps, demo.ltv_bps, rec.bucket, rec.dpd, loan.verdict, eng.mark_cents, eng.expected_loss_cents, eng.verified]
      : [loan.loan_hash, loan.asset_type, loan.verdict];
    lines.push(cells.map((c) => `"${String(c ?? "").replaceAll('"', '""')}"`).join(","));
  }
  return lines.join("\n");
}

export function LoanBook({ loans = [], lens = "public", onOpen, onCsv, outOfSync }) {
  const [query, setQuery] = useState("");
  const [asset, setAsset] = useState("all");
  const [sort, setSort] = useState("loan");
  const dataRoom = lens === "data_room" && !outOfSync;
  const filtered = loans.filter((loan) => {
    if (asset !== "all" && loan.asset_type !== asset) return false;
    const id = loan.data_room && loan.data_room.loan_id || "";
    const blob = `${id} ${loan.loan_hash || ""} ${loan.asset_type || ""}`.toLowerCase();
    return blob.includes(query.trim().toLowerCase());
  }).slice().sort((a, b) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    if (typeof av === "number" && typeof bv === "number") return bv - av;
    return String(av).localeCompare(String(bv));
  });
  return h(Panel, {
    id: "tn-loan-book",
    title: "Loan book",
    mix: dataRoom ? "demo" : "recorded",
    note: dataRoom
      ? "Demo data room. In production only the manager and the enclave see this. Here it is fictional so you can see what TrueNav checks."
      : "Public lens: loan hash, asset type and recorded verdict. Pledge time is a live nft_token field and is not stored in the demo file.",
  },
  dataRoom ? h(Banner, null, "Demo data room. Fictional per-loan detail. Document text is not shown.") : null,
  outOfSync ? h(Banner, null, outOfSync) : null,
  h("div", { className: "tn-controls" },
    h("input", { "aria-label": "Filter loans", value: query, placeholder: "Filter", onChange: (e) => setQuery(e.target.value) }),
    h("select", { "aria-label": "Asset type", value: asset, onChange: (e) => setAsset(e.target.value) },
      h("option", { value: "all" }, "All assets"),
      h("option", { value: "real_estate" }, "Real estate"),
      h("option", { value: "invoices" }, "Invoices")),
    h("select", { "aria-label": "Sort", value: sort, onChange: (e) => setSort(e.target.value) },
      h("option", { value: "loan" }, "Loan"),
      h("option", { value: "principal" }, "Principal"),
      h("option", { value: "dpd" }, "Days past due")),
    h("button", {
      type: "button",
      className: "tn-btn",
      onClick: () => {
        const csv = loansToCsv(filtered, dataRoom ? "data_room" : "public");
        if (onCsv) onCsv(csv);
      },
    }, "CSV")),
  filtered.length ? h("table", { className: "tn-table" },
    h("thead", null, h("tr", null, headers(dataRoom).map((name) => h("th", { key: name, className: /principal|coupon|ltv|dpd|mark|loss/i.test(name) ? "num" : "" }, name)))),
    h("tbody", null, filtered.map((loan) => h("tr", {
      key: loan.loan_hash || loan.data_room.loan_id,
      onClick: () => onOpen && onOpen(loan),
    }, cells(loan, dataRoom))))) : h(Empty, null, "No loans match. Clear filters."));
}

function sortValue(loan, sort) {
  const rec = loan.data_room && loan.data_room.recorded || {};
  if (sort === "principal") return Number(rec.principal_cents || 0);
  if (sort === "dpd") return Number(rec.dpd || 0);
  return (loan.data_room && loan.data_room.loan_id) || loan.loan_hash || "";
}

function headers(dataRoom) {
  return dataRoom
    ? ["Loan", "Asset", "Geography", "Sector", "Principal", "Coupon", "LTV", "Status", "DPD", "Verdict", "Mark", "Expected loss"]
    : ["Loan hash", "Asset", "Verdict", "Tag"];
}

function cells(loan, dataRoom) {
  const d = loan.data_room || {};
  const rec = d.recorded || {};
  const demo = d.demo || {};
  const eng = d.engine || {};
  const open = h("td", null, h("button", { type: "button", className: "linkish" }, dataRoom ? d.loan_id : shortHash(loan.loan_hash)));
  if (!dataRoom) {
    return [open,
      h("td", { key: "a" }, loan.asset_type || ""),
      h("td", { key: "v" }, loan.verdict || ""),
      h("td", { key: "t" }, h(SourceChip, { tag: loan.public_tags && loan.public_tags.verdict || "recorded" }))];
  }
  const geo = demo.geography ? `${demo.geography.country} ${demo.geography.region}` : "";
  return [open,
    h("td", { key: "a" }, loan.asset_type || ""),
    h("td", { key: "g" }, geo),
    h("td", { key: "s" }, demo.sector || ""),
    h("td", { key: "p", className: "num tn-num" }, formatUsdFromCents(rec.principal_cents)),
    h("td", { key: "c", className: "num tn-num" }, rec.coupon_bps == null ? "" : bpsToPct(rec.coupon_bps)),
    h("td", { key: "l", className: "num tn-num" }, demo.ltv_bps == null ? "" : bpsToPct(demo.ltv_bps)),
    h("td", { key: "st" }, demo.status || ""),
    h("td", { key: "d", className: "num tn-num" }, rec.dpd ?? ""),
    h("td", { key: "v" }, loan.verdict || ""),
    h("td", { key: "m", className: "num tn-num" }, formatUsdFromCents(eng.mark_cents)),
    h("td", { key: "e", className: "num tn-num" }, formatUsdFromCents(eng.expected_loss_cents))];
}
