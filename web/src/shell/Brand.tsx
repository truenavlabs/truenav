import { A } from "../ui";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <A href={href} className="brand" ariaLabel="TrueNav home">
      <span className="glyph" aria-hidden="true"><i /><i /><i /></span>
      <span className="wm">TrueNav</span>
    </A>
  );
}
