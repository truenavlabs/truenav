import { A } from "../ui";
import { PageHead } from "../shell/kit";

export default function NotFound() {
  return (
    <>
      <PageHead title="Page not found" lead="There is no page at this address." />
      <p><A href="/overview">Overview</A> · <A href="/features">Verify it yourself</A> · <A href="/faq">FAQ</A></p>
    </>
  );
}
