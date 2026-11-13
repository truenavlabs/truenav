// Shared "open a ticket" control for the help bubble and the support page.
// Uses the URL builder in lib/ticket.mjs. Wallet id is opt-in and off by default.
import { useEffect, useState } from "react";
import { buildIssueUrl } from "../lib/ticket.mjs";
import { Ext } from "./kit";
import { useWallet } from "./wallet";

export function TicketAction({ page, compact = false }: { page: string; compact?: boolean }) {
  const { signedAccountId } = useWallet();
  const [includeAccount, setIncludeAccount] = useState(false);
  useEffect(() => {
    if (!signedAccountId) setIncludeAccount(false);
  }, [signedAccountId]);
  const href = buildIssueUrl({ page, accountId: signedAccountId, includeAccount });
  return (
    <div className={compact ? "hp-ticket" : "ticketbox"}>
      <p className={compact ? "hp-note" : "dim"}>Issues are public, and they open once the repository is public.</p>
      {signedAccountId ? (
        <label className="hp-opt">
          <input
            type="checkbox"
            checked={includeAccount}
            onChange={(e) => setIncludeAccount(e.target.checked)}
          />
          Include my wallet account in the issue
        </label>
      ) : null}
      <Ext href={href}>Open a ticket</Ext>
    </div>
  );
}
