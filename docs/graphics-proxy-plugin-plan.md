# Graphics proxy as a plugin: implementation plan

Branch `v86gl`. Status (2026-09-30): Phases 1 to 3 implemented. Phase 4
(retro-gaming-site) waits until the site moves to a current build: the new
graphics bundle needs the new libv86.js, and the site still ships the build
of 2026-09-05/06. Phase 5 (upstream) is being prepared. Performance measurements (Phase 0 bench, 3DMark06)
are deferred until a 3DMark06 state is available. See "Deviations" at the end.

## Why

copy/v86#1629 (the graphics proxy) was closed. The maintainer asked for two
things:

- send the bug fixes as separate PRs;
- propose a way for API users to register a custom virtio device, so that the
  proxy can live outside v86.

For now glbridge stays in this repository (`src/browser/glbridge/`), with no
separate repository, but the rest of v86 must stop knowing about it. The
configuration becomes simpler for users at the same time.

Today a page writes:

```js
new V86({
    graphics_adapter: installV86GLGraphicsAdapter,  // a factory function
    graphics_options: { onError },
    v86gl_pci: { port: 0xF100, maxBatchBytes: 16 * 1024 * 1024 },
});
```

`graphics_adapter` and `v86gl_pci` are two halves of one feature: the renderer
and the device. They are separate options only because the device lives in
core and the renderer outside it. `v86gl_pci` is already redundant: setting
`graphics_adapter` enables the device with exactly those values, which are also
`V86GLPCI`'s defaults.

## Target configuration

```html
<script src="libv86.js"></script>
<script src="libv86-webgpu.js"></script>   <!-- only when the proxy is wanted -->
```

```js
new V86({
    graphics_adapter: "bochs_vga",   // the display hardware; this is the default
    graphics_proxy: true,            // or an options object
});
```

| Option | Values | Meaning |
|---|---|---|
| `graphics_adapter` | `"bochs_vga"` (default) | The display device the guest sees, like QEMU's `-vga`. `"vmware_svga"` and `"virtio_gpu"` are accepted once they exist. Any other value throws and lists the supported values. |
| `graphics_proxy` | `false` (default), `true`, or an object | Forward the guest's D3D/DDraw/GL calls to WebGPU. The object takes what `graphics_options` used to take (`onError`, `graphicsJournalMemoryBytes`, `gl`, `d3d8`, `d3d9`, `hostOptions`). Works with any `graphics_adapter`. |

The proxy is found the same way `starter.js` already finds xterm.js
(`xterm_lib || window["Terminal"]`): `libv86-webgpu.js` sets
`globalThis.V86GraphicsProxy`, and `graphics_proxy` looks it up. `libv86.js`
does not grow for users without WebGPU. retro-gaming-site's `game.html`
already loads both scripts this way.

Removed options throw a migration message instead of being ignored:

| Old | Error |
|---|---|
| `graphics_adapter: <function>` | `graphics_adapter now selects the display hardware; use graphics_proxy: true` |
| `v86gl_pci` | `v86gl_pci was removed; use graphics_proxy: true` |
| `graphics_options` | `graphics_options was removed; pass them as graphics_proxy: { ... }` |
| `graphics_proxy` without the bundle | `graphics_proxy requires libv86-webgpu.js to be loaded before new V86()` |

## Constraints

- **The guest ABI does not change.** The following stay as they are, so
  installed XP images keep working without touching the driver or the DLLs:
  - PCI 1AF4:107F, subsystem 5686, slot 0x13, I/O base 0xF100;
  - the config space and the request/reply layout;
  - the VGL2/D9WG/GLWG protocols.

  The slot matters beyond the driver: Windows keys device instances by bus
  location, so a moved device is enumerated as new hardware.
- **Old snapshots still restore.** `state[92]` currently holds the v86gl
  device state: an array tagged `STATE_MAGIC` 0x56514731, with the transport at
  index 1, the device fields at 2–7 and the graphics checkpoint at 8.
- **Both execution modes work:** CPU on the main thread, and CPU worker.
- **The same-thread part can go upstream unchanged.** The generic layer must
  not depend on fork-only pieces (CPU worker, display compositor, 36-bit bus)
  in a way that cannot be cut out.

## Architecture

```text
page (main thread)                               CPU side (main thread or CPU worker)
──────────────────────────────────               ──────────────────────────────────────
new V86({ graphics_adapter, graphics_proxy })
        │
        │ [2] friendly layer (starter.js)
        │     V86GraphicsProxy(options)
        ▼
  plugin host half           ◄── channel ──►     plugin device half
  src/browser/glbridge/                          src/browser/glbridge/v86gl_device.js
   - bridge, executors,                           - arena, SUBMIT parsing, backpressure
     compositor                                   - a descriptor handed to [1]
   - lifecycle hooks,                                     │
     called by V86                                        ▼
                                                 [1] generic layer (src/virtio_devices.js)
                                                  - VirtIO transport, PCI slot and ports
                                                  - device handle: requests, guest RAM
                                                  - snapshot slot state[92]
```

1. **Generic layer** (`src/virtio_devices.js`, plus hooks in `cpu.js`). It
   knows nothing about graphics. This is what goes upstream.
2. **Friendly layer** (one function in `starter.js`). It turns
   `graphics_adapter` and `graphics_proxy` into a display device choice and a
   plugin. Fork only.
3. **Plugin** (`src/browser/glbridge/`). A device half and a host half:
   - the device half is DOM-free and runs next to the CPU;
   - the host half is the renderer and runs on the page;
   - the two talk over a channel.

The channel is the one new idea. Today each mode relays batches its own way:

- main-thread mode sends a `v86gl-pci-frame` bus event carrying closures;
- worker mode sends messages from `cpu_worker_runtime.js`, with backpressure.

After this change both modes send the same messages. Only the channel's
transport differs.

### 1. Generic layer: `virtio_devices`

A device is a descriptor, and v86 builds the VirtIO transport from it:

```js
{
    "name": "v86gl",              // unique; the key in snapshots
    "pci_slot": 0x13,             // optional; default: first free slot from 0x10
    "io_base": 0xF100,            // optional; four 256-byte windows; default: allocated
    "device_id": 0x107F,
    "subsystem_device_id": 0x5686,
    "features": [0],              // v86 adds VIRTIO_F_VERSION_1
    "queues": [{ "size": 8 }],
    "config": [{ "bytes": 4, "read": () => 0x324C4756 }, /* ... */],
    "init": dev => {},            // once, with the device handle
    "notify": queue => {},        // the guest kicked a queue
    "reset": () => {},            // the guest wrote status 0, or the machine reset
    "get_state": () => state,     // synchronous; numbers, arrays, typed arrays
    "set_state": state => {},
    "upgrade_state": slot => entry,   // optional, see Snapshots
}
```

Descriptors are created last in `CPU.init`, after every built-in device, so
that slot allocation sees which slots are taken. The layer throws when a slot
or an I/O port is already taken. This check has to be explicit:
`PCI.register_device` only logs a warning when it overwrites a device.

The handle `dev` has quoted method names, so that the Closure ADVANCED build and
the uncompiled bundle agree:

| Method | Notes |
|---|---|
| `has_request(q)`, `pop_request(q)` | A request has `readable`, `writable`, `read()`, `write(bytes)` and `complete()`. |
| `flush(q)` | Writes the used ring and raises the interrupt. |
| `read_memory(addr, len)` | RAM only. Throws for holes, device windows and the legacy VGA/ROM range. Returns a view when the range has one contiguous backing, a copy otherwise. |
| `write_memory(bytes, addr)` | Goes through the bus, which invalidates compiled code. |
| `is_feature_negotiated(bit)`, `needs_reset()`, `config_changed()` | |

Two pieces of `V86GLPCI` move or change:

- `valid_range` and `contiguous_backing` move into the handle's memory
  accessors. They use `x64_phys_kind` and `x64_phys_resolve`, which only the
  fork has; the upstream version checks against `memory_size`.
- v86gl's hand-written two-descriptor parser is replaced by `pop_request`. The
  plugin checks `readable === 24 && writable === 16` and calls `needs_reset()`
  otherwise. `VirtQueue.push_reply_id` then has no caller besides `push_reply`,
  so fold it back in.

The public option is `virtio_devices: [descriptor, ...]`. These descriptors run
on the CPU's thread, so combining them with the CPU worker throws, the way
`handle9p` does today.

### Snapshots

`state[92]` becomes the slot for all custom virtio devices:

```js
state[92] = ["virtio_devices", 1,
    [name, transport_state, device_state, host_state], /* one per device */]
```

Each entry holds:

- `transport_state`: the VirtIO object, which v86 saves itself;
- `device_state`: from the descriptor's `get_state`;
- `host_state`: from the host half's `prepare_save` (next section), or
  `undefined` for plain descriptors.

On restore, entries are matched by name:

- A configured device without an entry is reset.
- An entry without a configured device throws:
  `snapshot contains virtio device "v86gl", which is not configured`. That is
  what the worker path does today; it beats silently dropping the graphics
  state.
- A slot without the `"virtio_devices"` tag is a legacy slot. v86 offers it to
  each descriptor's `upgrade_state`. v86gl recognizes `STATE_MAGIC` and returns
  the transport (index 1), the device fields (2–7) and the checkpoint (8). The
  magic number stays in the plugin.

Index 92 is also upstream's next free state index, so the same layout can go
upstream.

### 2. Friendly layer

One function in `starter.js`, `resolve_graphics_options(options)`:

- it validates the options described above;
- when `graphics_proxy` is set, it calls
  `globalThis["V86GraphicsProxy"](proxy_options)`.

It is the only place outside `glbridge/` that names the proxy. The result is a
plugin:

```js
{
    "name": "v86gl",
    "create_device": channel => descriptor,  // same-thread mode
    "worker_script": url,                    // worker mode: defines the same factory
    "connect": channel => {},                // the host half's end of the channel
    // ...host hooks
}
```

The host hooks are called by `V86` in main-thread mode and by
`CpuWorkerController` in worker mode. Each one is optional:

| Hook | When | Replaces (adapter method) |
|---|---|---|
| `ready` (a promise) | awaited before init finishes and before `initial_state` restores | `ready` |
| `attach_screen(screen)` | once; the fork-only display takeover | `screenCanvas`, `screenBackend`, `isGraphical`, `screenChanged` |
| `prepare_save()` → `host_state` | CPU stopped, before saving | `prepareSaveState` + `serializeCheckpoint` |
| `release_save()` | after saving, whether or not it succeeded | `releaseCheckpoint` |
| `before_restore()` | CPU stopped, before restoring | `beginStateRestore` + `waitForIdle(false, true)` |
| `after_restore(host_state)` | after the machine state is back | `onPCIStateRestored` + `finishStateRestore` |
| `cancel_restore()` | the restore failed | `cancelStateRestore` |
| `reset()` | before `restart` | `reset` |
| `destroy()` | `emulator.destroy()` | `destroy` |
| `screenshot()` | `screen_make_screenshot()` | `makeScreenshot` |

Related changes:

- `with_graphics_state` becomes `with_device_state` and loops over plugins. It
  keeps the same serialization of operations, CPU stop, speaker pause and
  resume rules.
- `attach_screen` receives
  `{ canvas: claim_canvas("webgpu"), set_backend, fallback, is_graphical, on_geometry_change }`.
  At most one plugin may take the screen.
- `emulator["graphics_adapter"]` (the bridge object that
  `performance_recorder.js` and `graphics_performance.js` read) becomes
  `emulator["graphics_proxy"]`.

### 3. The plugin

Files move and change inside `src/browser/glbridge/`:

| Now | After |
|---|---|
| `src/v86gl_pci.js` (an ES module that imports `VirtIO`) | `glbridge/v86gl_device.js`: a plain script with no imports, a descriptor factory that only uses the handle |
| `glbridge/graphics_adapter.js` (`installV86GLGraphicsAdapter`) | `glbridge/graphics_proxy.js` (`V86GraphicsProxy`), renamed so it is not confused with the `graphics_adapter` option |
| The relay in `cpu_worker_runtime.js`: the inflight map, `MAX_BATCHES`, `MAX_BYTES`, `can_accept`, `gpu-write`, `gpu-done`, the epoch | the device half |
| The relay in `cpu_worker.js`: `graphics()` and the stats counters | the host half |
| In `v86_network_bridge.js`: the `v86gl-pci-frame` bus listener, `attachPCIStateHooks`, `getPCIDevice`, the unmanaged-state mode | deleted: batches arrive over the channel, and state goes through the hooks |

Channel messages. Both directions carry the epoch, and a message with a stale
epoch is dropped:

| Direction | Message | Payload |
|---|---|---|
| device → host | `batch` | id, the frame header fields, `bytes` |
| host → device | `write` | id, offset in the arena, bytes |
| host → device | `done` | id. The device frees the capacity and processes the queue again. |

The channel has a `remote` flag:

- on the same thread, messages are delivered synchronously and `bytes` is a
  view of guest RAM (zero-copy, as today);
- in the worker, the device copies `bytes` before transferring them, as
  `cpu_worker_runtime.js` does now. The WebAssembly memory buffer must never be
  transferred.

One consequence: main-thread mode gains the worker's backpressure, at most 8
batches or 32 MiB in flight. Today it has none. Phase 2 measures the effect.

Build changes:

- `tools/build_glbridge.mjs` adds `v86gl_device.js` to `libv86-webgpu.js`.
- It also writes the file on its own as `build/glbridge/v86gl-device.js` for
  the worker. The CPU worker is a classic worker, so it loads the file with
  `importScripts`.
- The manifest lists the new file.

## Phases

Each phase ends with its tests green and one commit. Between Phase 2 and Phase
3, `graphics_proxy` combined with `cpu_worker` throws, so do not merge the
branch into master before Phase 3 is done.

### Phase 0: Baseline

- Run `make test-glbridge`, `make display-browser-tests` and
  `make cpu-worker-tests`, and record the results.
- Run `node tests/glbridge/virtio_transport_bench.cjs` and record the
  throughput.
- In retro-gaming-site, run a D3D9 title (3DMark06) and a D3D8 title (War3) in
  both modes. Save a snapshot of each; Phase 4 uses them to check that legacy
  snapshots restore.

### Phase 1: Generic layer

- `src/virtio_devices.js`: descriptor → VirtIO, slot and port allocation with
  collision checks, the handle, and the `state[92]` format with the legacy
  handoff.
- `cpu.js`: create the descriptors last in `init`, reset them in
  `reboot_internal`, and save/restore `state[92]`.
- `starter.js`: the `virtio_devices` option; throw in CPU worker mode.
- `v86.d.ts`: `VirtioDeviceDescriptor` and `VirtioDeviceHandle`.
- A new test, `tests/devices/virtio_devices_test.js`, that drives the ports the
  way `tests/glbridge/virtio_v86gl_test.js` does, using an echo device. It
  covers:
  - the PCI IDs are visible;
  - feature negotiation;
  - a request round trip;
  - a guest reset calls `reset`;
  - a snapshot round trip;
  - the unknown-name error;
  - the legacy slot handoff;
  - the slot collision error.
- v86gl itself is untouched and stays on its old path.

### Phase 2: v86gl on the generic layer (main-thread mode)

- Move `src/v86gl_pci.js` to `glbridge/v86gl_device.js`, rewritten on the
  handle. Remove it from `CORE_FILES` in the Makefile and from `cpu.js`.
- The channel with its local transport, and the device and host halves of the
  relay.
- Rename `graphics_adapter.js` to `graphics_proxy.js` and implement the hooks
  table. Delete the bus listener and the PCI state hooks in
  `v86_network_bridge.js`.
- In `starter.js`: the friendly layer, the removed-option errors, and
  `with_device_state`.
- In `main.js`: `load_graphics_proxy` checks for `V86GraphicsProxy`, and the
  page passes `graphics_proxy: { onError }`.
- In `v86.d.ts`: remove `v86gl_pci`, `graphics_options`,
  `V86GraphicsAdapter` and `V86GraphicsOptions`. Add the `graphics_adapter`
  string union and `graphics_proxy`.
- Update the 17 test files that use the old options. List them with
  `grep -rl -E "graphics_adapter|v86gl_pci|installV86GLGraphicsAdapter|graphics_options" tests`.
- Check: `make test-glbridge` and `make display-browser-tests` pass, and the
  transport bench is within 5% of Phase 0.

### Phase 3: CPU worker mode

- The worker loads each plugin's `worker_script` with `importScripts` before
  init. A generic per-device channel runs over the existing message pump as
  `{ "type": "device", "name": ..., ... }`.
- `host_state` crosses between threads the way today's checkpoint does:
  `rpc("save", [host_states])` on save, and a message back on restore.
- Delete the v86gl relay and `graphics_available` from `cpu_worker.js` and
  `cpu_worker_runtime.js`.
- Check: `make cpu-worker-tests` passes, including
  `cpu_worker_gpu_browser_test.html`, and the checks under "Done when" hold.

### Phase 4: retro-gaming-site and docs

- `app.js`: replace `graphics_adapter` and `v86gl_pci` with a per-game
  `graphics_proxy`. Rebuild `libv86.js` and `build/glbridge/*`, and copy them
  into `vendor/`.
- Run the Phase 0 titles in both modes, save and restore, and restore the
  Phase 0 snapshots (legacy slot).
- Docs: update the quick start in `glbridge.md` (config and file names), the
  device path in `display-design.md`, and this plan's status.

### Phase 5: Upstream

- Cut the same-thread generic layer (Phase 1 without the 36-bit bus parts) onto
  `upstream/master` as one PR, with the echo test and a
  `docs/custom-virtio-devices.md`. Cite `handle9p` as the precedent.
- Send separate bug-fix PRs:
  - `pci.js`: BAR holes in `set_state`;
  - `sb16.js`: reset the DAC on `set_state`, together with the speaker
    pause/generation fix;
  - `starter.js`: the `destroyed` guard during async init, and the standard
    `requestFullscreen`.
- The friendly layer, the worker channel and the display takeover stay in the
  fork.

## Done when

- `grep -rn v86gl src lib --exclude-dir=glbridge` finds nothing.
- Outside `glbridge/`, `V86GraphicsProxy` and `graphics_proxy` appear only in
  the friendly layer, `main.js` and the performance tools.
- The test suites pass in both modes, and the transport bench is within 5% of
  the baseline.
- XP titles render with the new configuration in both modes, save/restore
  works, and the Phase 0 snapshots restore.
- A page that uses an old option gets the migration error, not a silent
  VGA-only boot.

## Risks

- **Closure ADVANCED.** `index.html` uses `v86_all.js`, which is built with
  ADVANCED, so descriptor fields, handle methods and hooks must be read with
  quoted names. Test `index.html?graphics_proxy=1` against that build, not only
  against `libv86.js` (built with SIMPLE).
- **Backpressure in main-thread mode** may change throughput (see the Phase 2
  check). If it regresses, raise the limits for the local channel.
- **The generic request path** allocates an object per request, which the
  hand-written parser did not. There is one 24-byte request per batch, so this
  should not be measurable; the bench decides.
- **Slot and port collisions.** The descriptor fixes 0x13 and 0xF100. A future
  built-in device on either one now fails loudly at startup instead of
  silently replacing v86gl.

## Deviations

Where the implementation differs from the plan above:

- **No backpressure on one thread.** On the same thread the device does not
  hold batches back (the plan had main-thread mode take the worker's limits),
  so main-thread mode keeps its behavior from before. The limits (8 batches,
  32 MiB in flight) apply only to a `remote` channel.
- **The renderer tells the device whether it is there.** A fourth channel
  message, `available { value }`, goes from the host to the device. It keeps
  the guest-visible `NO_RENDERER` reply that the old bus event gave when no
  renderer handled a batch, for example when WebGPU fails to start.
- **Readbacks carry the arena generation**, not a batch id. They stay valid
  after `done`, as they were on the main thread before, and are dropped once
  the guest re-registers or resets its arena.
- **`start(context)` instead of `attach_screen(screen)`.** The plugin's
  renderer needs the screen canvas when it is created, so `start` receives the
  emulator, the screen (only when the plugin sets `wants_screen`) and the
  channel together, and returns the `ready` promise. `screen_changed` is a
  separate hook.
- **DMA goes to guest RAM only.** This is a rule of the generic layer:
  `has_request` checks the rings and `pop_request` checks every buffer.
  Anything else, such as a reply buffer in VGA memory, makes the driver reset
  the device, as `v86gl_pci.js` did.
- **`busy` and `idle` for draining the worker.** Before a save or restore the
  CPU worker controller waits, until nothing changes, for every plugin's
  `idle()` on the page and for the devices' `busy()` counts to reach 0 in the
  worker. `busy` is an optional descriptor hook of the generic layer. Host
  states cross the thread boundary as arguments and results of the
  save/restore RPCs; the `init` RPC returns those of `initial_state`.
- **Renderer errors across the worker no longer kill the emulator.** Before,
  they failed the whole CPU worker. Now the plugin reports them (`onError`)
  and tells the device that nothing renders, as it does on the main thread.
- **Port reads are normalized.** Configuration-space reads are made int32, or
  masked to the field's width, so descriptors return plain numbers.

