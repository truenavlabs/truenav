// Helpers for the certify/testnet.mjs run record. Kept separate so a unit test can cover the
// no-recorded-TEE path without sending transactions or touching the network.
// When tee is null, the record must stay honest: pending, not passed, and no invented verdicts.

export function teeRunFields(tee, teeSigner) {
  if (!tee) {
    return {
      tee_status: "pending",
      tee_reason: "no recorded TEE verdict set for this contract id; loans stay pending",
      tee_signer: null,
      tee_model: null,
    };
  }
  return {
    tee_status: "submitted",
    tee_reason: null,
    tee_signer: teeSigner,
    tee_model: tee.model,
  };
}

export function runRecordNote(network, tee) {
  const prefix = network === "sandbox" ? "Sandbox" : "Live testnet";
  const cert = "Certificate signer is a test key, not TEE";
  if (!tee) {
    return `${prefix} run of certify/testnet.mjs. ${cert}. No recorded TEE verdict set for this contract id; loan verdicts were not submitted and loans stay pending.`;
  }
  return `${prefix} run of certify/testnet.mjs. ${cert}; loan verdicts are signed by the attested NEAR AI Cloud model TEE.`;
}

export function runRecordSummary({ failed, tee }) {
  if (failed) return "some checks FAILED";
  if (!tee) return "on-chain checks passed; TEE pending, not run";
  return "all checks passed";
}

export function buildRunRecord({
  tee,
  teeSigner,
  network,
  rpc,
  contract_id,
  admin_and_servicer,
  fund_accounts,
  signer_address,
  signer_kind,
  engine_commit,
  signed_at_ms,
  double_pledge_loan_hash,
  scores_from_chain,
  steps,
}) {
  return {
    note: runRecordNote(network, tee),
    network,
    rpc,
    contract_id,
    admin_and_servicer,
    fund_accounts,
    signer_address,
    signer_kind,
    engine_commit,
    signed_at_ms,
    double_pledge_loan_hash,
    ...teeRunFields(tee, teeSigner),
    scores_from_chain,
    steps,
  };
}
