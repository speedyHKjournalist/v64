v86 has a built-in profiler, which instruments generated code to count certain
events and types of instructions. It can be used by building with `make
debug-with-profiler` and opening debug.html?cpu_worker=0 (the CPU in the page).

For debugging networking, packet logging is available in the UI in both debug
and release builds. The resulting `traffic.hex` file can be loaded in Wireshark
using file -> import from hex -> tick direction indication, timestamp %s.%f.

## The step profile: what compiled code leaves to the interpreter

IR Tier-0 and the x64 page tier interpret some instructions one at a time
inside their page functions ("steps"): forms without a template, accesses
refused by the fast path, faults. The step profile counts them in one store
([`src/rust/step_profile.rs`](../src/rust/step_profile.rs)), keyed by
StepKey v1, a u32 whose fields are the opcode and its map, VEX's pp and L,
the F2/F3, 66 and REX.W prefixes, ModRM.reg for opcodes it extends (groups,
x87), a retry bit (the x64 page tier refused an access), the mode (real,
virtual-8086, 16- and 32-bit protected, 16- and 32-bit compatibility,
64-bit), the stepping tier, and an ISA field (x86 is 0; A64 is to use it).
The source file has the exact layout.

It is off by default: on, every step decodes its instruction into a hash
table. Turn it on with the JIT switch `step_profile` (`JIT_SWITCHES=step_profile=1`,
the V86 option `jit_switches`, or `set_jit_switches` from
[`src/jit_switches.js`](../src/jit_switches.js)) and read it with
`step_profile()` from [`tools/step_profile.mjs`](../tools/step_profile.mjs),
which also names keys (`"prot32 tier0 0F A2"`). The exports:
`step_profile_snapshot()` sorts it and returns the number of keys,
`step_profile_key(i)` and `step_profile_count(i)` read entry `i`,
`step_profile_get(key)` one key, `step_profile_reset()` empties it.

- `tests/bench/run.mjs --fallbacks` turns it on for one more round of each
  benchmark, which is not timed, and prints the most stepped keys.
- `JIT_STATS=1` records (tools/bench/jit_stats.mjs) carry the 40 most
  stepped keys while it is on.
- The x64 page tier's earlier interface reads the same store:
  `x64_page_profile(1)` turns it on, `x64_page_profile_get(key)` sums it by
  the old key (bits 0-17 of StepKey), as `WIN_STEP_PROFILE` and
  `X64_STEP_PROFILE` in the Windows and Linux harnesses print it.
- `ir_t0_steps(key)` is separate and always on: Tier-0's steps by their
  first two bytes, prefixes included, which tests read.

## The mode ledger: retired instructions by mode and engine

The JIT switch `mode_ledger` (off by default) counts retired instructions
(the definition of `core_statistics_get(core, 0)`: a REP instruction once, a
faulting one not at all) by mode (`x64::state::ExecutionMode`: real,
virtual-8086, 16- and 32-bit protected, 16- and 32-bit compatibility,
64-bit), by whether 32-bit code ran with flat segments, and by how they ran:
`interpreted` (outside compiled code), `tier0_native`, `tier0_step`,
`region_native`, `page_native`, `page_step` and `page_retry`. While it is on,
its sum grows exactly as the retired count does
(`tests/ir/differential/tier0_mode_ledger.mjs`, `tests/x64/mode_ledger.mjs`).
Each count goes to the mode its run started in: an interpreted run of
instructions, an activation of compiled code (which leaves when the mode
changes) or one step.

`mode_ledger(exports)` in [`tools/bench/jit_stats.mjs`](../tools/bench/jit_stats.mjs)
reads it as `{ mode: { way: retired } }`, flat 32-bit code under
`"<mode>.flat"`; `JIT_STATS=1` records carry it while it is on, and
`mode_ledger_reset()` empties it. The count is per Wasm instance: with cores
in workers, each worker has its own.

## Windows guests in node (tests/x64/windows_boot.mjs)

The Windows harness can measure a running program from a saved state, so a
scene is profiled again and again without booting:

- `savestate <file>` (a line in `<out>/command.txt`) streams the machine to
  `<file>.state` (with a 3D renderer the GPU's contents are in it; such a state
  passes 4 GiB, so it is written with `save_state_stream`), the disk overlays to
  `<file>.hda.ovl` and `<file>.hdb.ovl`, and the harness's own state to
  `<file>.json`. `WIN_STATE_LOAD=<file>` starts from there instead of booting
  (with the same `WIN_*` machine settings).
- `WIN_RATES=<s>`: every `<s>` seconds an `svga3d-rates` event with the SVGA3D
  commands per second, the frames (screen target updates) per second, the
  guest's MIPS (all cores), how often core 0 was halted, and the renderer's
  backlog. The remote renderer page logs `renderer-stats` (batches, bytes,
  latency from arrival to done) every 10 s.
- `WIN_CPU_PROFILE=<s>`: host CPU profiles, one per window; after each, an
  `X64_WIN_PROFILE_MODULES` line gives the generated code's share by guest
  module (page functions are named by linear page: `x64_page_<page>` for long
  mode, `t0_<page>` for compatibility mode).
- `x64_page_stat` counters (in `X64_WIN_PROGRESS`): control register writes
  by register and full flushes, page walks, and the 32-bit TLB fills of
  compatibility mode and refills of pages it had already. A high refill count
  means some path translates although the TLB could answer.
- `WIN_SHOT_MS`: the screenshot interval (a 1280x1024 PNG every 2 s costs the
  host a few per cent).

Use the release build (`TEST_RELEASE_BUILD=1`): the source tree runs the debug
wasm. Runs from one state differ by about 10% in frames per second; compare
several of each.

The harness itself costs the host about 5–8%: screenshots, logs, and the
WebSocket channel to the renderer page in headless Chrome
([`tests/x64/gpu_remote_renderer.mjs`](../tests/x64/gpu_remote_renderer.mjs);
3DMark06 on Windows 8.1, 2026-10-02). A browser page has none of it, so node
runs understate what a page reaches by about that much.
