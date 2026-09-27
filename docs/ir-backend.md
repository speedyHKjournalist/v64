# IR backend

IR is the only JIT. Every V86 instance compiles with automatic IR compilation
plus the page-granular Tier-0; the legacy code generator (analysis, codegen and
the generated jit/analyzer tables) has been removed from the core.
Unsupported instructions continue through the existing interpreter.
`jit_backend` accepts only `"ir"` (or omission); `"legacy"` is rejected with
`emulator-error`.

Every core build contains IR (there is no feature flag);
`build/v86-ir-runtime.wasm` is a copy of `build/v86.wasm` kept for the IR tests'
paths. `make run` builds
`build/v86.wasm`; the stock `index.html` loads it (the debug page loads
`build/v86-debug.wasm`) with Tier-0, `x87_fast_math` and `x87_jit_cache` on and
the CPU Worker checkbox checked. None of these need URL parameters any more;
`?ir_tier0=0`, `?x87_fast_math=0`, `?x87_jit_cache=0` and `?cpu_worker=0` turn
them off, and Manual **Start Emulation** keeps only such non-default values in
the rebuilt URL.

Reload the page after rebuilding; an already-running VM keeps its constructor
policy.

Pass options in a browser, Node, or CPU Worker configuration:

```js
const emulator = new V86({
    wasm_path: "build/v86.wasm",
    ir_opt_level: 2,
    ir_passes_disabled: [],
    ir_region_budget: {
        hot_threshold: 64,
        promotion_threshold: 256,
        max_source_bytes: 192,
        execution_budget: 256,
        rep_iterations: 64,
    },
    // BIOS, disks, display and other normal V86 options go here.
    // cpu_worker: true,
    // cpu_worker_url: "build/cpu-worker.js",
});
emulator.add_listener("emulator-error", error => console.error(error));
emulator.add_listener("emulator-loaded", async () => {
    console.log(await emulator.get_jit_info());
});
```

The budget object is optional; the example shows every default. Heat thresholds
accept integers 1–1,000,000; source bytes accept 15–960; execution and REP budgets
accept 1–4,096. Tier 2 doubles the byte window with a 960-byte cap. The independent
instruction, CFG, cache and per-frame compiler bounds in [ir-auto.md](ir-auto.md)
still apply. Unknown budget keys, invalid numbers and a budget that is not an
object are rejected. No JS-to-Wasm integer truncation is used to validate
these options.

`ir_tier0` (default true; `false` leaves only the region tiers) is the
page-granular Tier-0 below the region tier: hot code pages become one Wasm
function each, with templates for integer, x87, SSE/SSE2 and MMX code (see
[ir-page-tier-design.md](ir-page-tier-design.md)). With it, the IR core ran
the CPU benchmark suite ([cpu-benchmarks.md](cpu-benchmarks.md)) and the
Windows XP boot faster than the removed legacy JIT.

`disable_jit: true` disables IR scheduling: only the interpreter runs. A core
built without IR, a backend other than `"ir"` or an invalid budget emits
`emulator-error` before `emulator-loaded` or guest autostart, in either
execution mode.

Backend selection is a constructor policy. It is not serialized in guest
snapshots and is not a public runtime switching API. Reset/restart and snapshot
restore keep the destination VM's policy while invalidating compiled code.
The existing low-level IR test/explicit compilation interfaces are separate;
changing them can override the constructor's automatic policy.

`get_jit_info()` returns a copy immediately for a main-thread CPU and a Promise
for a CPU Worker. It reports the backend (`"ir"`), IR availability/enabled
state, effective budgets, automatic compilation/promotion counters and IR cache
entries/hits. IR counters wrap at 2^32 and continue across cache
clear/reset/restore. No guest RAM, mutable CPU state, or Wasm table is exposed by
the Worker RPC. Performance recordings include the actual selected backend as
`metadata.jit_backend`, alongside the existing core SHA-256 when available.

`ir_opt_level` accepts 0 (no optional optimization), 1 (Tier-1 canonicalization
at both tiers), or 2 (the default Tier-1/Tier-2 pipeline). Heat/promotion and
correctness checks still operate at every level. Level 0 may hit compilation
budgets earlier because simplification is disabled; normal interpreter fallback
still applies. These controls govern automatic compilation; explicit test compile
APIs keep their own parameters.

`ir_passes_disabled` is a list of unique pass names: `prune`, `merge`, `phis`,
`copy`, `fold`, `flags`, `helper_state`, `gvn`, `dce`, `licm`, `mir_fold`, `stack`,
`allocation`, `state_elision`, `ram_loop`, `ram_forward`, `ram_guard`. Disabling a
pass does not enable it at a lower optimization level. `allocation` controls the
optional post-lowering allocation pass, not the required initial typed locals.
Loop caching does not implicitly enable a disabled forwarding pass. Unknown or
duplicate names and invalid levels are rejected
before autostart. All verifier, StateMap, fault and cache admission checks remain.

Both options pass through the real Worker initialization path, appear as copied
effective policy in `get_jit_info()`, and survive reset/restore as destination
policy. They require rebuilding the experimental (including fallback) core.
The stock page accepts and preserves, for example,
`&jit_backend=ir&ir_opt_level=1&ir_passes_disabled=gvn,ram_forward` across manual
Start Emulation. Constructor arrays use the ordinary JavaScript list syntax.

`ir_verify` accepts `off`, `debug` (default), or `every_pass`. Necessary lowering,
import, recovery, RAM-proof and publication checks remain enabled in every mode.
`debug` additionally runs the independent owned-MIR verifier at compiler boundaries
in assertion-enabled cores. `every_pass` runs it after lowering and after each
machine pass even in release cores. The normal release default adds no graph
verification to the hot compilation path. Verification covers dominance, operand
availability, local interference, typed edge copies, recovery expressions and
low-level import/RAM certificates without retaining HIR.

`ir_dump` accepts `off` (default), `hir`, `mir`, `wasm`, or `all`. The optimized HIR,
final MIR and emitted module can be inspected using `await emulator.get_ir_dumps()`.
Records describe completed compilations, not necessarily published or executed
artifacts. The ring holds the newest 16 records, at most 64 KiB each of HIR/MIR
text and 256 KiB of Wasm per record. A record has `pc`, `tier`, `hir`, `mir`, `wasm`
(`Uint8Array`) and a `truncated` mask (HIR=1, MIR=2, Wasm=4). Truncated Wasm is not
an executable module. Text truncation preserves UTF-8 boundaries. Results are
copies; `get_ir_dumps(true)` copies and then clears the ring synchronously in the
CPU owner. Worker RPC returns the same independent data. Dumps are not included
in guest snapshots; retained records may precede a reset/restore.

`ir_stats` accepts `off` (default), `sampled` (period 128) or `debug` (period 1).
It configures the existing diagnostic session at startup. Basic scheduler/cache
counters remain available with statistics off. `configure_ir_diagnostics(period)`
can subsequently choose another sample period; `get_jit_info().ir_stats` reports
the effective off/debug/sampled category and `ir.diagnostics.sample_period` the
exact period. See [timing semantics](ir-diagnostics.md).

All three options are constructor controls for IR, pass through the Worker, are
reported by `get_jit_info()`, and are preserved by the stock page across manual
Start Emulation. For example:
`&jit_backend=ir&ir_verify=every_pass&ir_dump=all&ir_stats=sampled`.
Use default verification, dumps off and statistics off for performance acceptance;
inspection and every-pass verification intentionally add compilation overhead.

Validation entry points:

* `make ir-backend-integration-tests`: shared public API scenarios on invariant
  debug and pure experimental release cores.
* `make ir-backend-browser-tests`: the same scenarios in Chromium's main thread
  and a real dedicated CPU Worker, using an isolated browser profile.
* `make ir-backend-tests`: the pre-existing standalone Wasm emitter fixtures;
  this is distinct from public backend selection.
