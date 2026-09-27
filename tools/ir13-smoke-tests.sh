#!/bin/sh
set -eu

mkdir -p build

# Public host API coverage on both the invariant debug core and pure experimental
# release core. This exercises normal CPU dispatch, Tier 1/2 promotion, SMC,
# snapshots, backend crossing and initialization failures.
make ir-backend-integration-tests

# Record the repeated same-core execution-budget matrix. Every sample uses a
# fresh VM; CI keeps raw runs and medians but deliberately has no speed threshold.
make ir13-budget-matrix

# The large Worker screen transport regression is host-only and catches ordering /
# stale-generation failures before starting a browser.
node tests/glbridge/cpu_worker_screen_test.mjs

if [ -z "${GL_CHROME:-}" ]; then
    for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
            GL_CHROME="$(command -v "$candidate")"
            export GL_CHROME
            break
        fi
    done
fi
if [ -z "${GL_CHROME:-}" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    GL_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    export GL_CHROME
fi
if [ -z "${GL_CHROME:-}" ]; then
    echo "IR-13 browser acceptance requires Chrome/Chromium (or GL_CHROME)." >&2
    exit 1
fi

make build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker.js build/cpu-worker-test.bin

# Public backend behavior in Chromium, both main-thread and dedicated Worker.
node tests/glbridge/gl_multipass_browser_runner.js ir_backend_browser_test.html

# Reuse the production Worker/device compatibility scenario with the IR core:
# VGA/canvas transport, virtio graphics backpressure, filesystem/disk RPC,
# SB16 PCM, save/restore, rejected restore recovery and main<->Worker snapshots.
node tests/glbridge/gl_multipass_browser_runner.js 'cpu_worker_browser_test.html?jit_backend=ir'

# Exercise the real AudioWorklet creation/save/restore path with an IR-selected
# dedicated CPU Worker.
node tests/glbridge/gl_multipass_browser_runner.js 'cpu_worker_audio_browser_test.html?jit_backend=ir'
