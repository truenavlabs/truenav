#!/bin/bash
# Sandbox-only receipts wasm. It is not the pinned testnet build.
# Output: receipts/target/near-sandbox/truenav_receipts.wasm
# The cargo target dir is receipts/target/sandbox-cargo so target/near stays the default build.
# cargo-near writes the optimized wasm at $cargo_dir/near/truenav_receipts.wasm. That file is
# copied by name. A find of the cargo dir is not used, because it also contains the unoptimized wasm.
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
  src="$cargo_dir/near/truenav_receipts.wasm"
  if [ ! -f "$src" ]; then
    echo "FAIL sandbox wasm missing: $src" >&2
    exit 1
  fi
  cp "$src" "$out/truenav_receipts.wasm"
else
  CARGO_TARGET_DIR="$PWD/$cargo_dir" RUSTFLAGS="--cfg near" cargo build --release --locked --target wasm32-unknown-unknown --features sandbox
  src="$cargo_dir/wasm32-unknown-unknown/release/truenav_receipts.wasm"
  if [ ! -f "$src" ]; then
    echo "FAIL sandbox wasm missing: $src" >&2
    exit 1
  fi
  cp "$src" "$out/truenav_receipts.wasm"
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz "$out/truenav_receipts.wasm" -o "$out/truenav_receipts.wasm"
  fi
fi
if ! grep -a -q 'outlayer.test.near' "$out/truenav_receipts.wasm"; then
  echo "FAIL $out/truenav_receipts.wasm has no sandbox account" >&2
  exit 1
fi
bytes=$(wc -c < "$out/truenav_receipts.wasm" | tr -d ' ')
hash=$(sha256sum "$out/truenav_receipts.wasm" | cut -d' ' -f1)
echo "sandbox wasm sha256=$hash bytes=$bytes path=$out/truenav_receipts.wasm"
