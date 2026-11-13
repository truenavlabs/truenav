import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

// Scroll is reset by the app when the new page swaps in, so a cross fade does not jump the old page first.
export function navigate(href: string) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function follow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const href = event.currentTarget.getAttribute("href") || "/";
  if (href.startsWith("#") || /^https?:/.test(href)) return;
  event.preventDefault();
  navigate(href);
}

export function A({ href, className, children, title, ariaLabel, ariaCurrent, style, onFocus, onBlur, onMouseEnter, onMouseLeave }: {
  href: string; className?: string; children: ReactNode; title?: string; ariaLabel?: string; ariaCurrent?: "page";
  style?: CSSProperties; onFocus?: () => void; onBlur?: () => void; onMouseEnter?: () => void; onMouseLeave?: () => void;
}) {
  return (
    <a
      href={href} className={className} onClick={follow} title={title} aria-label={ariaLabel} aria-current={ariaCurrent} style={style}
      onFocus={onFocus} onBlur={onBlur} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    >
      {children}
    </a>
  );
}

export function Field({ label, value, tip }: { label: ReactNode; value: ReactNode; tip?: string }) {
  return (
    <div className="box">
      <div className="k">{label}</div>
      <div>{value}</div>
      {tip ? <div className="fieldnote">{tip}</div> : null}
    </div>
  );
}
