import { A } from "../ui";
import { Ext, Note, PageHead, Panel } from "../shell/kit";
import { TicketAction } from "../shell/Ticket";
import { ISSUES_URL } from "../lib/ticket.mjs";

export default function Support() {
  return (
    <>
      <PageHead title="Support" lead="How to ask a question, report a problem or report a security issue." />
      <div className="grid2">
        <Panel title="Questions and problems">
          <p>Open an issue on the TrueNav repository on GitHub.</p>
          <TicketAction page="/support" />
          <p className="mt">You can also browse <Ext href={ISSUES_URL}>GitHub Issues</Ext> once the repository is public.</p>
          <p className="mt">Many questions are answered in the <A href="/faq">FAQ</A> and the <A href="/glossary">Glossary</A>, or by the <strong>?</strong> button at the bottom right.</p>
        </Panel>
        <Panel title="Report a security issue">
          <p>Do not open a public issue for a vulnerability. Open a private security advisory on the repository (GitHub, Security tab).</p>
          <p className="dim mt">From SECURITY.md.</p>
        </Panel>
        <Panel title="Is something down?">
          <p>The <A href="/status">Data status</A> page shows each data source, when it was last read and whether the site is showing live or recorded data.</p>
        </Panel>
        <Panel title="Email">
          <p>A support address on a TrueNav Labs domain is planned. Until it exists, use GitHub.</p>
        </Panel>
      </div>
      <Note tone="info">TrueNav is a hackathon prototype on NEAR testnet with fictional data. Do not use it with real funds or real loan documents.</Note>
    </>
  );
}
