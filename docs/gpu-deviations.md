# GPU devices: deviations from real hardware

Where the emulated VMware SVGA II and virtio-gpu ([gpu-devices.md](gpu-devices.md))
do not behave like the hardware they model, because WebGPU lacks something or
because something is not done yet. The rule is the one the D3D8/D3D9 proxies
follow: a capability is declared only when code backs it; what WebGPU cannot
do is emulated and listed here rather than hidden.

## Emulated

| Id | Topic | How it is done | Difference from hardware |
| --- | --- | --- | --- |
| G-01 | Geometry shaders | The vertex shader runs as compute into records, the geometry shader as compute over them, then a draw of what it emitted; GS instancing | Room for `maxvertexcount` vertices per primitive is reserved; only stream 0 is drawn |
| G-02 | Stream output, `DrawAuto` | A compute pass after the vertex or geometry stage writes the targets and their filled sizes; `DrawAuto` reads the size; the statistics queries count primitives written and needed, and overflows | Stream 0 only; not for indirect draws, adjacency topologies or after tessellation |
| G-03 | Tessellation | Hull shader per patch in compute (control point, fork and join phases), the D3D11 reference tessellator in WGSL, domain shader per point, an indirect draw | No geometry shader or stream output after tessellation |
| G-04 | MSAA (4x, 8x) | Supersampling: a 4x surface is a 2W×2H texture, 8x is 4W×2H; sample index from the position; sample mask, oMask and alpha-to-coverage by discard; resolves average the block | Samples lie on a grid, not D3D's standard pattern, so edge coverage differs slightly |
| G-08 | Depth formats | D24 formats are WebGPU's `depth24plus(-stencil8)`; uploads of depth go through a draw that writes `frag_depth` (WebGPU copies data only into `depth16unorm` and stencil aspects) | An upload of depth costs a draw |
| G-09 | Formats WebGPU lacks | Stored wider and converted on upload and readback: 565, 1555, 4444, RGB32, UNORM16/SNORM16, A8, L8, L8A8, SNORM8 render targets, X8 formats | Wider storage; precision of blending into converted formats can differ |
| G-11 | Typed UAVs | Storage textures, the format taken from the bound view; read-write access only for R32 formats | Typed loads of other formats are not offered |
| G-12 | Doubles (SM5, GL 4.x) | Declared; computed as f32 (WGSL has no f64), including VMware's `DFRC` and `DRSQ` | Range and precision are float's |
| G-17 | Provoking vertex (GL: the last) | Draws with flat varyings get their vertices reordered, the last first (a rotation, so winding is kept): fixed orders without indices, a compute pass over the indices with them (restarts included); fans are drawn as lists | Indirect draws keep WebGPU's first vertex |
| G-18 | `eval_*` | The attribute at the fragment (each fragment is a sample when supersampled) | Not at the requested offset |
| G-25 | Format views across a typeless family | A view of another format of the same texel layout (R32G32B32A32_UINT of a FLOAT texture) uses an alias texture of that format; the contents follow the format used last, copied raw through a buffer | A copy each time a surface switches family |
| G-26 | Integer textures sampled with `sample` (GL `texture()` on an integer sampler) | The texel under the coordinates, by a load clamped to the level's edges | The sampler's wrap mode is not applied |
| G-27 | Comparison samplers declared "default" (Mesa's svga declares every sampler so) | The sampler's WGSL type comes from its use; a sampler used both ways gets a comparison twin | None |
| G-28 | Clip distances | WebGPU's `clip-distances` on the vertex stage | Not when the last stage before the rasterizer is a geometry or domain shader (warned) |
| G-29 | Integer clears with float values | Mesa's svga sends a UINT target's values as its signed ints (`-16.0` for `0xFFFFFFF0`): negative values wrap, the rest saturate as D3D converts | None for Mesa; D3D applications get D3D's saturation |
| G-30 | Host visible memory (virtio-gpu `virgl43-hostmem`) | The guest's writes are uploaded by page before each `SUBMIT_3D`; mapped buffers the GPU wrote are read back whole before the submit's fence | Page granularity; the whole buffer is read back after each submit that writes it |
| G-31 | 3D scanout | 3D results reach the screen by readback into the device's picture (only the dirty rectangle's columns from GX) | One readback per present |
| G-32 | SVGA video overlay | Drawn over the device's picture like the cursor (each unit a patch of the desktop with the video where it shows); BT.601 video range, nearest-neighbour scaling | No filtering when scaled |

## Not done

| Topic | State |
| --- | --- |
| `LOGICOPS_*` (GDI acceleration commands) | Not implemented |
| Pipeline statistics queries | Answered 0; timestamps come from `performance.now()` |
| Geometry shader streams 1–3 | Not drawn |
| virgl: tessellation evaluation without a control shader, tessellation followed by a geometry shader, image atomics and image size queries, indirect draws with a count buffer, GLES 3.2 | Not offered or not handled |
| virgl: `BLOB_MEM_HOST3D_GUEST`, mapping textures | Rejected (Mesa uses neither) |
| virtio-gpu 3D on Windows, Venus (Vulkan) | Deferred |
| SVGA resolution following the page | Not done: VMware does it through VMware Tools' service in the guest (vmtoolsd, `Resolution_Set` over a TCLO channel), which the backdoor does not have; virtio-gpu follows `V86.set_display_size` |

## Known issues (Mesa's svga on Linux, `tests/x64/gltest.c`)

At level `dx11-full`, 31 of the 34 cases match llvmpipe (at `dx11`, 30: see
`flat-indexed-strip`). The ones that do not:

| Case | What happens |
| --- | --- |
| `fan-lines-points` | Points (which Mesa's svga expands with its own geometry shader) come out mirrored vertically; lines and the fan are right |
| `flat-indexed-strip` (`dx11` and below only) | These levels do not declare `DX_PROVOKING_VERTEX`, so Mesa converts the indices for GL's last provoking vertex itself, and its conversion of a strip with a restart makes a triangle of the restart index; `dx11-full` declares it and GX reorders |
| `rect-buffer-integer-textures` | The rectangle texture's coordinate scale is not among the constants Mesa uploads (its extra constants hold only the buffer texture's size), so the rectangle reads its first texel |
| `compute-buffer` | Mesa bakes the grid size into the compute shader's immediates (`key.cs.grid_size`); the shader it sends has 0 for `gl_NumWorkGroups` |

The last two are in what Mesa sends, not in how GX runs it. On virtio-gpu
(virgl) all 34 cases match.
