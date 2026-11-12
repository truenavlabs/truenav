// Minimal stand-in so Node can render these components to HTML without the react package.
// The shell imports the real react package. This file is only for the local harness and tests.

export function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child != null && child !== false && child !== true);
  const next = props ? { ...props } : {};
  if (flat.length) next.children = flat.length === 1 ? flat[0] : flat;
  return { $$typeof: "truenav-harness", type, props: next };
}

export function useState(init) {
  const value = typeof init === "function" ? init() : init;
  return [value, function setState() {}];
}

export const Fragment = Symbol.for("react.fragment");

export function renderToHtml(node) {
  if (node == null || node === false || node === true) return "";
  if (Array.isArray(node)) return node.map(renderToHtml).join("");
  if (typeof node === "string" || typeof node === "number") return escapeHtml(String(node));
  if (!node || node.$$typeof !== "truenav-harness") return "";
  if (typeof node.type === "function") return renderToHtml(node.type(node.props || {}));
  if (node.type === Fragment) return renderToHtml(node.props && node.props.children);
  const props = node.props || {};
  const attrs = [];
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || value == null || value === false) continue;
    if (typeof value === "function") continue;
    const name = ATTR[key] || key;
    if (value === true) {
      attrs.push(name);
      continue;
    }
    attrs.push(`${name}="${escapeHtml(String(value))}"`);
  }
  const inner = renderToHtml(props.children);
  if (VOID.has(node.type)) return `<${node.type}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
  return `<${node.type}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${inner}</${node.type}>`;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ATTR = {
  className: "class",
  htmlFor: "for",
  strokeWidth: "stroke-width",
  strokeDasharray: "stroke-dasharray",
  textAnchor: "text-anchor",
};

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
