#!/bin/sh
# Guarded RAM forwarding, native MIR certificates and actual CPU recovery.
set -eu
make ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
RUSTFLAGS="${RUSTFLAGS:-} -D warnings" cargo test ir::mir::forwarding
RUSTFLAGS="${RUSTFLAGS:-} -D warnings" cargo test ir::entry_tests
node tests/ir/differential/forwarding.mjs
