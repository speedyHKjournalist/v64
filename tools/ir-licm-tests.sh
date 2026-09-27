#!/usr/bin/env bash
# Focused IR-11 regression entry; no guest OS image or network service required.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
make ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
cargo test ir::passes::licm
node tests/ir/wasm/licm.mjs
node tests/ir/differential/licm.mjs
