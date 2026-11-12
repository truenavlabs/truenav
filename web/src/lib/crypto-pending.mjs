// Stand-in for @noble/curves and @noble/hashes in the web bundle until those packages are approved for web/.
// Every call throws CryptoPendingError, so a check that needs signature recovery or sha256 never passes by accident.
export class CryptoPendingError extends Error {
  constructor() {
    super("crypto library pending approval: signature and hash checks run with npm run judge, not in this browser build");
    this.name = "CryptoPendingError";
  }
}
const pending = () => {
  throw new CryptoPendingError();
};
export const CRYPTO_PENDING = true;
export const secp256k1 = { Signature: { fromBytes: pending, fromCompact: pending }, verify: pending, getPublicKey: pending, recoverPublicKey: pending };
export const keccak_256 = pending;
export const sha256 = pending;
