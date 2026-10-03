# GPU devices: VMware SVGA II and virtio-gpu

v86 emulates two 3D display adapters besides the Bochs VGA: **VMware SVGA II**
(`graphics_adapter: "vmware_svga"`) and **virtio-gpu** as virtio-vga
(`graphics_adapter: "virtio_gpu"`). Their 3D work runs on the page's WebGPU
device. This document describes the design as built; the deviations from real
hardware are listed in [gpu-deviations.md](gpu-deviations.md). The original
plan, with the milestone history and the probing notes, is
[vmware-svga-virtio-gpu-plan.zh-CN.md](vmware-svga-virtio-gpu-plan.zh-CN.md)
(Chinese).

| Guest | Device | Driver | What works |
| --- | --- | --- | --- |
| Windows 8.1 x64 | SVGA II | VMware Tools 13.1.5 ("VMware SVGA 3D", WDDM) | D3D9 (3DMark06 runs to the end), D3D10/10.1/11 up to FL11_0 with 8x MSAA, DWM composition |
| Windows 8.1 x64 | virtio-gpu | viogpudo (virtio-win 0.1.240, w8.1, test signed) | 2D, EDID, cursor, live resolution changes |
| Linux x86_64 (Alpine) | SVGA II | vmwgfx + Mesa svga | OpenGL 4.3 core (SM5), GLES 3.1, KMS |
| Linux x86_64 (Alpine) | virtio-gpu | virtio_gpu + Mesa virgl (Mesa 25.2) | OpenGL 4.3 core/compat, GLES 3.1, blob scanouts, persistent buffer mappings |
| Linux x86_64 (Alpine) | virtio-gpu (level `venus`) | virtio_gpu + Mesa venus (Mesa 26.1) | Vulkan 1.1: vulkaninfo, transfers, synchronization, mapped memory, graphics, compute, queries, dynamic rendering (`vktest`: same results as lavapipe), vkcube on weston, snapshots |

## Configuration

Only two options are public:

```js
new V86({
    graphics_adapter: "vmware_svga",   // required: "bochs_vga" | "vmware_svga" | "virtio_gpu" | "none"
    vram_size: 64 << 20,               // optional, a power of two; the adapter's default otherwise
});
```

Each adapter is a plugin (`build/v86-bochs-vga.js`, `build/v86-vmware-svga.js`,
`build/v86-virtio-gpu.js`) loaded on demand from beside the libv86 bundle, or
from `graphics_adapter_path`. The plugins share the VGA core
(`src/graphics_adapters/vga_core.js`), so BIOS, VBE and boot screens work on
every adapter; one `bios/vgabios.bin` serves all three, its PCI ROM header
rewritten at load with the adapter's IDs (SeaBIOS only runs option ROMs whose
IDs match the device).

**Levels.** What a device declares to the guest (capability bits, devcaps,
virtio features, capsets) is fixed by a *level*. At power-on the plugin picks
the highest level that is implemented and that the page can run (3D levels
need the WebGPU renderer, `build/glbridge/libv86-webgpu.js`). The level and
everything it declared go into snapshots; a restore declares exactly that
again, so a level's ABI is frozen and new capabilities only ever come with a
new level. Tests pin a level with `graphics_adapter_test: { level }`.

| Adapter | Levels, lowest first | Default |
| --- | --- | --- |
| `vmware_svga` | `2d`, `2d-full`, `vgpu9`, `gb9`, `dx10`, `dx10.1`, `dx11`, `dx11-full` | `dx11-full` with a renderer, `2d-full` without |
| `virtio_gpu` | `2d`, `2d-blob`, `virgl`, `virgl43`, `virgl43-blob`, `virgl43-hostmem`, `venus` | `virgl43-hostmem` with a renderer, `2d-blob` without |

## Architecture

```text
=== guest ======================================================================
 Win 8.1: vm3dum*.dll / vm3dmp.sys        Linux: Mesa svga / virgl + vmwgfx / virtio_gpu
        │ FIFO, command buffers, registers        │ virtqueues
=== CPU thread (or CPU worker) =================================================
 v86-vmware-svga.js                        v86-virtio-gpu.js
  registers, FIFO, command buffers, IRQ     control and cursor queues, EDID, events
  GMR / MOB / OTable / COTable walks        resources, backing, blobs
  2D in VRAM                                2D resources
  VGPU9 → D9WG commands                     virgl → SVGA DX commands
  DX (VGPU10) → GX commands                 TGSI → VGPU10 tokens
        └──────────────┬──────────────────────────┘
                       │ renderer channel: submit / reset ↓   write / done / lost ↑
=== page (WebGPU) ==============================================================
   svga_renderer.js:  D9WG executor (legacy 3D)   GX executor (DX, virgl)
                                    shader IR: VGPU10 tokens → WGSL
```

- **The CPU side** (the plugin) does everything that touches guest memory:
  register semantics, command parsing, page table walks, 2D. A 3D command is
  validated, the guest data it references is read, and both go into a
  self-contained batch. Without WebGPU (node, Canvas2D) the devices offer only
  their 2D levels and remain fully usable.
- **The renderer** (`src/browser/glbridge/svga_renderer.js`) runs batches on
  the GPU and never reads guest memory. Answers (readbacks, query results) go
  back as `write` messages; `done` follows a batch's last write. In CPU worker
  mode the device is in the worker and the renderer stays on the page; the
  channel is the same.
- **Completion order.** Fences (SVGA FIFO fences, MOB fences, command buffer
  status, virtio fenced responses) complete only after every batch sent before
  them is `done`, so a driver that waits for a fence sees the readbacks and
  query results.
- **Scanout.** 3D results reach the screen by readback into the device's
  picture (Screen Objects, Screen Targets, virtio scanouts), which the display
  hub shows like any 2D picture. Cursors, screenshots and snapshots therefore
  work the same at every level.

## VMware SVGA II

PCI `15AD:0405`, class `0300`. BAR0: 16 I/O ports (INDEX, VALUE, BIOS,
IRQSTATUS); BAR1: VRAM (the VGA core's LFB); BAR2: the FIFO.

- **2D** (`2d`, `2d-full`): registers, FIFO with RESERVE, `UPDATE`, ROP copies,
  cursors (mono, color, alpha), Screen Object 1/2, GMR1/GMR2, command buffers
  with device contexts, display topology, INTx.
- **Video overlay** (`dx11-full`, `svga_video.js`): 32 overlay units set and
  shown through `SVGA_CMD_ESCAPE`; YV12, YUY2 and UYVY frames from a GMR or
  VRAM, scaled into their destination rectangle, with the color key. Like the
  cursor, the overlay is drawn over the device's picture, not into guest
  memory. The same level declares `DX_PROVOKING_VERTEX` (GX reorders for GL's
  last-vertex flat shading).
- **Legacy 3D** (`vgpu9`): the SVGA3D commands 1040–1082 become D9WG commands
  (`svga3d.js`, `svga3d_d9wg.js`), the same executor the D3D9 proxy uses. Each
  SVGA3D context is a D9WG device.
- **GB objects** (`gb9`): MOBs with every page table format, object tables, GB
  surfaces whose authoritative copy moves between MOB and GPU
  (`UPDATE`/`READBACK`/`INVALIDATE`), GB contexts and shaders, Screen Targets,
  cursor MOB, MOB fences.
- **DX** (`dx10`, `dx10.1`, `dx11`): DX contexts, COTables in guest memory, all
  view and state objects, shaders, stream output, queries, predication, UAVs,
  compute, tessellation (`svga3d_dx.js` → GX). D3D9 applications on Windows
  still use the legacy commands; surfaces move between D9WG and GX on the GPU
  (`SURFACE_IMPORT`/`EXPORT`), so DWM composites D3D9 windows without
  readbacks.
- **Devcaps and formats** come from one table (`svga_dx_formats.js`), checked
  per format against what GX implements. The Windows user-mode driver opens a
  feature level only when its devcap list (read from `vm3dum64_10.dll`) is
  satisfied, so the tables follow those lists exactly.

## virtio-gpu

virtio-vga `1AF4:1050` (subsystem `1AF4:1100`, revision 1, class `0300`). BAR0:
VRAM (the VGA core's LFB, also viogpudo's frame buffer); BAR2: the four virtio
capabilities in one 128 KiB memory BAR, as QEMU's virtio-vga (viogpudo maps
only memory BARs); BAR4 (level `virgl43-hostmem`): 64 MiB of host visible
memory, a shared memory capability (shmid 1).

- **2D**: display info and EDID (the preferred mode follows
  `V86.set_display_size`), resources with scattered backing, transfers,
  scanouts (up to 16, side by side), cursor queue, display events, fences.
  The demo page follows the window's size, and with `?displays=N` gives the
  guest N displays, each a share of the window's width.
- **Blobs** (`2d-blob`, `virgl43-blob`): `BLOB_MEM_GUEST` resources scanned out
  straight from guest memory (`SET_SCANOUT_BLOB`), cursors from blobs, and
  `CONTEXT_INIT`.
- **virgl** (`virgl`, `virgl43`): the translation is on the device side, the
  way Mesa's svga driver works: gallium state becomes SVGA DX commands for GX
  (`virgl_context.js`), TGSI text becomes VGPU10 tokens (`tgsi.js`,
  `tgsi_vgpu10.js`), so GX has one front end. Each virgl sub-context is a GX
  context; virgl handles are DX object ids; rasterizer states and shaders get
  variants per draw (the next stage's inputs, Y flip and depth range, view
  swizzles, flat shading, alpha test, tessellation phases).
- **Host visible memory** (`virgl43-hostmem`): `PIPE_RESOURCE_CREATE`
  templates, `BLOB_MEM_HOST3D` resources and `MAP_BLOB` into BAR4 give Mesa
  `ARB_buffer_storage`. BAR4 is an `mmio_ram` region: the guest reads and
  writes it at memory speed, and the pages it writes are uploaded into their
  blobs before each `SUBMIT_3D` (`mmio_ram_take_dirty`); mapped buffers the
  GPU wrote are read back before the submit's fence completes.

## Venus (Vulkan)

Level `venus` adds Venus contexts (capset 4) to `virgl43-hostmem`, for Mesa's
venus driver, and a 128 MiB BAR4. Venus is Vulkan's API serialized: the
guest driver encodes each command, the device decodes it, keeps the Vulkan
objects and answers.

- **Wire format**: `venus_protocol.js` is generated by
  `tools/venus_protocol_gen.mjs` from the C Mesa generates for its driver
  (`src/virtio/venus-protocol`): its encoders become the device's request
  decoders, its reply decoders the device's reply encoders. The same tool
  writes the driver's side (`tests/devices/venus_guest_protocol.js`) for
  device tests. Both are checked byte for byte against Mesa's own C
  (`tools/venus_oracle/oracle.c`, `tests/devices/venus_protocol.js`).
- **Transport** (`venus.js`): the driver's shared memory is `HOST3D` blobs of
  blob id 0 mapped into BAR4. Command rings live there; the device reads them
  whenever the machine's timers run (no idle rings, no notifications needed),
  keeps the `ALIVE` status bit up for the driver's watchdog, writes replies
  into the reply stream the driver names, and runs `vkExecuteCommandStreamsMESA`
  streams. A submission (`SUBMIT_3D`) that waits holds the control queue,
  as virglrenderer's in-order processing does.
- **Vulkan model** (`venus_vk.js` and `venus_vk_*.js`): instance and physical
  device queries from `venus_device_info.js` (Vulkan 1.1 on WebGPU's
  guaranteed limits and formats); devices, queues, memory, buffers, images,
  views, samplers, command pools and buffers, fences, semaphores (binary and
  timeline), events, queries, shaders, pipelines, descriptor sets, render
  passes. Command buffers keep their commands; a submission becomes one VX
  batch when its timeline waits are met.
- **Memory**: a `VkDeviceMemory` is a GPU buffer; host visible memory is also
  exported as a blob the guest maps into BAR4. The pages the guest writes are
  uploaded before each submission; the byte ranges the GPU writes (copies,
  fills, image to buffer copies, storage buffers) are read back into the
  mapping before the submission's fence and semaphores signal. A range the GPU
  has written but not yet returned is never overwritten by an upload.
- **VX** (`src/browser/glbridge/vx/vx_executor.js`) runs VX batches on WebGPU:
  memory, textures, views, samplers, copies (row by row when the pitch is not
  WebGPU's), fills, clears, blits and resolves as render passes, and the
  graphics and compute commands. SPIR-V becomes WGSL with naga
  (`src/browser/glbridge/vx/naga`, built to `build/glbridge/vx_naga.wasm`):
  combined image samplers are split first, Vulkan's binding b is WGSL's 2b
  (2b + 1 for the sampler half), push constants become a storage buffer, Y is
  flipped. Pipelines use WebGPU's automatic layouts; bind groups are made per
  pipeline from the bound sets' contents.
- **Queries**: a pool's results are a VX memory. Occlusion queries are
  WebGPU's (the render pass names the pool it uses: the model looks ahead
  for the first one begun in it), resolved into that memory when the pass
  ends; timestamps are the time the device makes the batch. The results of
  a submission's queries come back before its fence;
  `vkCmdCopyQueryPoolResults` copies them on the GPU.
- **Dynamic rendering** (`VK_KHR_dynamic_rendering`): `vkCmdBeginRendering`
  is a render pass of the views it names; pipelines take their formats from
  `VkPipelineRenderingCreateInfo`.
- **WSI**: Venus offers `VK_KHR_swapchain` when the device imports sync
  files into semaphores (`VK_KHR_external_semaphore_fd`, `_fence_fd`). The
  driver makes the sync files itself (a `SUBMIT_3D` on the queue's timeline)
  and tells the device what they did with `vkImportSemaphoreResourceMESA`,
  `vkWaitSemaphoreResourceMESA` and `vkResetFenceResourceMESA`: a pending
  signal that went into a sync file no longer lands on its semaphore or
  fence. Without dma-buf, Mesa's WSI is its software one: each present
  copies the swapchain image into a host visible buffer (read back before
  the present's fence) and from there into the compositor's `wl_shm` buffer.
  vkcube on weston runs at about 60 frames per second.
- **Snapshots**: the model keeps the VX command that made each renderer
  object (memory, image, view, sampler, shader, pipeline, query pool). Before
  a save the rings run until the device's requests are answered, the GPU
  finishes, and every memory's and image's contents are read back. A
  snapshot holds the contexts (rings, reply streams, the model's objects as
  JSON), the blobs with their mappings, the creation commands and the
  contents; a restore makes the renderer's objects again and fills them.
  A command that waited is read again from where its ring stopped.

## GX

GX (`src/browser/glbridge/gx/gx_executor.js`) is the WebGPU backend of the DX
commands, shared by SVGA DX and virgl. It takes the SVGA DX commands nearly
as they are (`GX.DX` carries the context and the command), plus a few
operations of its own (surface definition, uploads, readbacks, copies, query
ends, integer clears).

- **Surfaces** are WebGPU buffers or textures. Formats WebGPU lacks are stored
  wider and converted on upload and readback. A TYPELESS surface is one
  texture of one format; a view of another format of the same texel layout
  gets an *alias* texture of that format, and the contents follow the format
  used last (copied raw through a buffer).
- **Pipelines** are cached by shaders, state objects, target formats,
  topology and vertex layout; consecutive draws share a render pass.
- **Multisampling is supersampling**: a 4x surface is a 2W×2H texture, 8x is
  4W×2H; every format can be multisampled and no pass mixes sample counts.
- **Emulated stages** run as compute: geometry shaders (records, then a draw of
  what they emitted), stream output (with `DrawAuto` and statistics),
  tessellation (hull shader per patch, the D3D11 reference tessellator ported
  to WGSL, domain shader per point, an indirect draw).
- **Shaders**: `shader_ir/dxbc_frontend.js` decodes VGPU10 tokens (SM4.0–5.0
  plus VMware's opcodes) and `shader_ir/wgsl_emitter.js` writes WGSL for an
  interface (the pipeline's vertex inputs, varyings, targets, sampler kinds).
  Generated WGSL is checked with naga in the tests.

## Snapshots

Device-level checkpoints, not command journals: before a save the device lets
the GPU finish and reads back what only the GPU has.

- **SVGA**: GB objects live in guest memory already; GPU-newer surfaces are
  written back to their MOBs, DX context state is kept in the context MOB
  format. Legacy (`vgpu9`) surfaces are read back into the snapshot.
- **virtio-gpu**: 3D resources are read back; virgl contexts are saved as the
  commands that made their live objects plus their bound state; host visible
  mappings with their bytes.
- A restore checks adapter and level and rebuilds the GPU side lazily.

## Tests

| Layer | Where |
| --- | --- |
| Device units (registers, FIFO, GMR/MOB, command buffers, virtqueues, EDID, blobs, host visible memory, snapshots) | `tests/devices/vmware_svga*.js`, `tests/devices/virtio_gpu*.js`, `tests/devices/virgl_tgsi.js` (`make devices-test`) |
| Shader translation, tessellator | `tests/glbridge/` (`make test-glbridge`), `tests/gpu/shaders/` |
| Linux guest, real GPU in headless Chrome | `tests/x64/linux_gpu.mjs` with `GPU_ADAPTER`, `GPU_LEVEL`, `GPU_SCENARIO` (`gltest`: `tests/x64/gltest.c`, 34 GL/GLES cases compared with llvmpipe in the guest; `virgl`: kmscube, a snapshot while drawing, weston, es2gears; `venus`: vulkaninfo and `tests/x64/vktest.c`, run on lavapipe and on Venus) and `GPU_RENDERER=chrome` |
| Venus protocol and transport | `tests/devices/venus_protocol.js`, `tests/devices/virtio_gpu_venus.js` (with sync files and a snapshot) |
| Venus WSI and snapshots in a Linux guest | `tests/x64/linux_gpu.mjs` with `GPU_LEVEL=venus GPU_SCENARIO=vkcube GPU_RENDERER=chrome`: weston (pixman), vkcube on Venus timed and screenshotted, a snapshot saved and restored while it draws |
| VX on WebGPU | `tests/glbridge/vx_transfer_browser_test.html` |
| Windows guest | `tests/x64/windows_boot.mjs` with an overlay of the user's image; `tools/windows/d3d11cmp.c` (D3D11 cases compared with WARP) |
