import { LIVE_REGISTRY, STATUS } from "../../shell/evidence";
import { accountUrl, short } from "../../shell/fmt";
import { Ext, FeatureFrame, Note, PageHead, Panel, SrcTag, StatusChip } from "../../shell/kit";
import { useRegistry } from "../../shell/store";

const WHO: [string, string, string][] = [
  ["admin", "register_fund, set_role, set_servicer_pledge_key", "Binds fund ids to accounts and hands out roles."],
  ["registrar", "add_signer, remove_signer, add_tee_signer, remove_tee_signer, add_pledge_signer, remove_pledge_signer", "Keeps the signer lists: certificate keys, TEE keys, pledge ticket keys."],
  ["pauser", "pause, unpause", "Stops writes. Reads never stop."],
  ["servicer", "submit_verdict, release_loan", "Submits enclave verdicts and releases repaid loans."],
  ["a registered fund", "pledge_loan (with a fresh servicer signature)", "Pledges loans in its own name."],
  ["anyone", "submit_certificate (kept only if signed by a registered key), every view method", "Reads are open to everyone."],
];

export default function Roles() {
  const { view, tag } = useRegistry();
  const roles = (view.roles || {}) as Record<string, string | boolean>;
  const exp = LIVE_REGISTRY;
  const tee = (view.teeSigners as { address: string; model_id: string; attestation_sha256: string }[] | undefined) ?? [];
  const rows: [string, string, string][] = [
    ["admin", String(roles.admin ?? "n/a"), String(exp.roles.admin)],
    ["registrar", String(roles.registrar ?? "n/a"), String(exp.roles.registrar)],
    ["pauser", String(roles.pauser ?? "n/a"), String(exp.roles.pauser)],
    ["servicer", String(roles.servicer ?? "n/a"), String(exp.roles.servicer)],
    ["paused", String(roles.paused ?? "n/a"), String(exp.roles.paused)],
    ["certificate signers", JSON.stringify(view.signers ?? null), JSON.stringify(exp.certificate_signers)],
    ["servicer pledge key", String(view.pledgeKey ?? "n/a"), exp.servicer_pledge_address],
    ["pledge ticket signers", JSON.stringify(view.pledgeSigners ?? null), JSON.stringify((exp as { pledge_signers?: string[] }).pledge_signers ?? [])],
    ["TEE signer", tee[0]?.address ?? "n/a", String(STATUS.tee_signer)],
    ["code hash", String(view.codeHash ?? "n/a"), exp.code_hash],
  ];
  const tryIt = (
    <>
      <Panel title="Live roles against what the repository expects" pad={false} tags={<><SrcTag tag={tag} source="get_roles, get_signers, get_servicer_pledge_key, get_pledge_signers, get_tee_signers, view_code" /><SrcTag tag="recorded" source="certify/live-registry.json, tee/status.json" /></>}>
        <div className="tscroll"><table className="dt">
          <thead><tr><th>Item</th><th>On chain now</th><th>Repository expects</th><th>Result</th></tr></thead>
          <tbody>{rows.map(([k, live, want]) => (
            <tr key={k}><td>{k}</td><td className="mono" style={{ wordBreak: "break-all", whiteSpace: "normal" }}>{live.endsWith(".testnet") ? <Ext href={accountUrl(live)}>{live}</Ext> : live}</td><td className="mono" style={{ wordBreak: "break-all", whiteSpace: "normal" }}>{want}</td><td>{live.toLowerCase() === want.toLowerCase() ? <span className="ok">match</span> : <span className="bad">differs</span>}</td></tr>
          ))}</tbody>
        </table></div>
      </Panel>
      {tee[0] ? <p className="dim mt">TEE signer model {tee[0].model_id}; attestation report sha256 {short(tee[0].attestation_sha256, 10, 8)} (see F3).</p> : null}
      <Panel className="mt" title="Who can call what" pad={false} tags={<SrcTag tag="recorded" source="contract/src/lib.rs" />}>
        <div className="tscroll"><table className="dt"><thead><tr><th>Caller</th><th>Methods</th><th>What for</th></tr></thead>
          <tbody>{WHO.map(([w, m, why]) => <tr key={w}><td>{w}</td><td className="mono" style={{ fontSize: 11.5 }}>{m}</td><td>{why}</td></tr>)}</tbody></table></div>
      </Panel>
      <Note tone="info">Pause stops writes (pledges, verdicts, certificates, releases), never reads. Each role is refused every other role's job (contract/tests/roles.rs).</Note>
      <Note tone="warn">Known limit N-07: the certificate signer and the servicer pledge key are the same test address. Domain prefixes (truenav-cert-v1, truenav-pledge-v1) stop one signature being used as the other, so this is role concentration, not a bypass. Admin and registrar are also one account.</Note>
    </>
  );
  return (
    <>
      <PageHead crumbs={[["Verify it yourself", "/features"], ["F7 Roles and pause"]]} title="Roles and pause" lead="Who controls the registry, read live and compared with what the repository says it should be." />
      <FeatureFrame
        what="Four roles split the registry's admin powers: admin, registrar, pauser, servicer. Signer lists are data, so keys rotate without a code change."
        status={<StatusChip kind="live" />}
        tryIt={tryIt}
        proves={["Who holds each role and each signer list right now, and that it matches the committed expectation.", "That the deployed code hash is the expected one."]}
        notProves={["That the role holders act honestly. They are TrueNav Labs test accounts.", "That the code hash maps to this source. Rebuild and compare to check that."]}
        run={["npm run verify:live-signer", "cd contract && cargo test"]}
        sources={["contract/src/lib.rs", "contract/tests/roles.rs", "certify/live-registry.json", "certify/verify-live-signer.mjs"]}
      />
    </>
  );
}
