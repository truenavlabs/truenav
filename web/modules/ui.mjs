import { createElement as h } from "react";

const CHIP = {
  live: "live",
  recorded: "recorded",
  computed: "computed",
  demo: "demo",
  external: "external",
  snapshot: "snapshot",
  stale: "stale",
  unavailable: "stale",
  green: "green",
  yellow: "yellow",
  red: "red",
};

export function SourceChip({ tag, title }) {
  const raw = String(tag || "recorded");
  const key = raw.toLowerCase().split(/[\s(]/)[0];
  const cls = CHIP[key] || "external";
  return h("span", { className: `tn-chip ${cls}`, title: title || raw }, raw);
}

export function Explain({ text }) {
  return h("span", { className: "tn-explain" },
    h("button", { type: "button", className: "tn-explain-btn", "aria-label": text }, "?"),
    h("span", { className: "tn-explain-pop", role: "tooltip" }, text));
}

export function Panel({ title, kicker, mix, note, children, id }) {
  return h("section", { className: "tn-panel", id },
    h("header", { className: "tn-panel-h" },
      h("div", null,
        kicker ? h("p", { className: "tn-kicker" }, kicker) : null,
        h("h2", null, title)),
      mix ? h(SourceChip, { tag: mix }) : null,
      note ? h("p", { className: "tn-source" }, note) : null),
    h("div", { className: "tn-panel-b" }, children));
}

export function Banner({ children }) {
  return h("div", { className: "tn-banner" }, children);
}

export function Empty({ children }) {
  return h("p", { className: "tn-empty" }, children);
}
