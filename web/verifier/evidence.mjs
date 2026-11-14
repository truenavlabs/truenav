// Load the committed evidence files the verifier checks. readText(path) returns the file text: in the browser use
// fetch against wherever the files are served, in Node readFileSync. Paths are repository-relative.
export const EVIDENCE_PATHS = Object.freeze({ status: "tee/status.json", liveRegistry: "certify/live-registry.json", receiptsPin: "receipts/pinned-builds.json", receiptsBuild: "receipts/v3-build.json" });

/** Browser helper: readText for files served under baseUrl (e.g. the repository root on the static host). */
export const fetchText = (baseUrl) => async (path) => {
  const r = await fetch(new URL(path, baseUrl));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
};

/** @returns {Promise<{status, liveRegistry, verdicts, reportB64, paths}>}; throws when a file is missing or not JSON. */
export async function loadEvidence(readText) {
  const status = JSON.parse(await readText(EVIDENCE_PATHS.status));
  const liveRegistry = JSON.parse(await readText(EVIDENCE_PATHS.liveRegistry));
  const paths = { ...EVIDENCE_PATHS, verdicts: status.verdicts_file, report: status.report_file };
  const verdicts = JSON.parse(await readText(paths.verdicts));
  const reportB64 = await readText(paths.report);
  const pinned = JSON.parse(await readText(EVIDENCE_PATHS.receiptsPin));
  const build = JSON.parse(await readText(EVIDENCE_PATHS.receiptsBuild));
  const receipts = {
    account: "receipts.tnlab-718ca9.testnet",
    sha256: pinned.receipts,
    engineSha256: build.engine && build.engine.sha256,
    method: build.method_version || "truenav-v3.0.1",
    storage_deposit: "350000000000000000000000",
    outlayer_tgas: 200,
    callback_tgas: 80,
    outlayer: "outlayer.testnet",
  };
  return { status, liveRegistry, verdicts, reportB64, paths, receipts };
}
