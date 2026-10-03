v86 has a built-in profiler, which instruments generated code to count certain
events and types of instructions. It can be used by building with `make
debug-with-profiler` and opening debug.html?cpu_worker=0 (the CPU in the page).

For debugging networking, packet logging is available in the UI in both debug
and release builds. The resulting `traffic.hex` file can be loaded in Wireshark
using file -> import from hex -> tick direction indication, timestamp %s.%f.

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
