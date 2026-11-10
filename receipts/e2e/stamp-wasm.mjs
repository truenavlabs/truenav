// CI only: stamp the contract wasms that the pinned image just built, so ensureContractWasm uses them as they are
// instead of rebuilding on the host. Run on the runner (not in the container): the stamp hashes host paths.
//   node receipts/e2e/stamp-wasm.mjs
import { isFresh, stampContractWasm } from "./ensure-wasm.mjs";

// Every wasm the receipts e2e, v3-sandbox and mirror steps load through ensureContractWasm.
export const PINNED_IMAGE_WASMS = [
  { crate: "receipts", artifact: "truenav_receipts", sandbox: true },
  { crate: "query", artifact: "truenav_query" },
  { crate: "receipts/mock-outlayer", artifact: "mock_outlayer" },
  { crate: "mirror/mock-signer", artifact: "truenav_mock_signer" },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const w of PINNED_IMAGE_WASMS) {
    const { dest, stamp } = stampContractWasm(w);
    if (!isFresh(w)) throw new Error(`${dest} is still stale after stamping`);
    console.log(`stamped ${dest} ${stamp.slice(0, 12)}...`);
  }
}
