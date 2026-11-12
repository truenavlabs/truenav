import { createElement as h } from "react";
import { SourceChip } from "./ui.mjs";

/** items: [{ id, label, valueText, changeText, chip, source, attribution, fetchedAt, dim }] */
export function MarketTicker({ items = [], contextNote }) {
  const row = items.length ? items : [];
  const track = row.length ? row.concat(row) : [];
  return h("div", { className: "tn-ticker", id: "tn-ticker" },
    h("div", { className: "tn-ticker-track" },
      track.map((item, i) => h("span", {
        className: `tn-tick${item.dim ? " tn-dim" : ""}`,
        key: `${item.id}-${i}`,
        title: [item.attribution, item.source, item.fetchedAt].filter(Boolean).join(". "),
      },
      h("b", null, item.label),
      h("span", { className: "tn-num" }, item.valueText),
      item.changeText ? h("span", { className: String(item.changeText).startsWith("-") ? "tn-down" : "tn-up" }, item.changeText) : null,
      item.chip ? h(SourceChip, { tag: item.chip }) : null))),
    h("p", { className: "tn-attr" },
      contextNote || "Market data is context only. It does not feed a TrueNav score. Data provided by CoinGecko where a CoinGecko price is shown. Other figures cite their source chip."));
}
