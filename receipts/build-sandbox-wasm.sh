#!/bin/bash
# Sandbox-only receipts wasm. It is not the pinned testnet build.
# Output: receipts/target/near-sandbox/truenav_receipts.wasm
# The cargo target dir is receipts/target/sandbox-cargo so target/near stays the default build.
set -euo pipefail
cd "$(dirname "$0")"
out=target/near-sandbox
cargo_dir=target/sandbox-cargo
mkdir -p "$out" "$cargo_dir"
saved=$(mktemp -d)
if [ -d target/near ]; then cp -a target/near "$saved/near"; fi
cleanup() {
  if [ -d "$saved/near" ]; then
    rm -rf target/near
    mv "$saved/near" target/near
  elif [ -f target/near/truenav_receipts.wasm ] && grep -a -q 'outlayer.test.near' target/near/truenav_receipts.wasm; then
    rm -rf target/near
  fi
  rm -rf "$saved"
}
trap cleanup EXIT
if command -v cargo-near >/dev/null 2>&1; then
  CARGO_TARGET_DIR="$PWD/$cargo_dir" cargo near build non-reproducible-wasm --locked --features sandbox
else
  CARGO_TARGET_DIR="$PWD/$cargo_dir" RUSTFLAGS="--cfg near" cargo build --release --locked --target wasm32-unknown-unknown --features sandbox
fi
found=$(find "$cargo_dir" -name 'truenav_receipts.wasm' -type f | head -1)
if [ -z "$found" ] && [ -f target/near/truenav_receipts.wasm ]; then
  found=target/near/truenav_receipts.wasm
fi
test -n "$found"
cp "$found" "$out/truenav_receipts.wasm"
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz "$out/truenav_receipts.wasm" -o "$out/truenav_receipts.wasm"
fi
grep -a -q 'outlayer.test.near' "$out/truenav_receipts.wasm"
echo "sandbox wasm $out/truenav_receipts.wasm ($(wc -c < "$out/truenav_receipts.wasm") bytes)"
