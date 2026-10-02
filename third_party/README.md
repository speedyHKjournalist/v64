# Third-party headers

Device interface definitions, used only to generate constant tables
(`tools/gen_svga_constants.js`) and to build guest test programs
(`tests/x64/vktest.c`); none of this is compiled into v86.

| Directory | Source | License |
| --- | --- | --- |
| `vmware-svga/` | Mesa, `src/gallium/drivers/svga/include/` (VMware SVGA II and SVGA3D, including `VGPU10ShaderTokens.h` and `svga3d_shaderdefs.h`), fetched 2026-10-01 from gitlab.freedesktop.org/mesa/mesa `main` | `GPL-2.0 OR MIT`; used under MIT |
| `virgl/` | virglrenderer, `src/virgl_protocol.h` and `src/virgl_hw.h`, fetched 2026-10-01 from gitlab.freedesktop.org/virgl/virglrenderer `main` | MIT |
| `virtio/` | Linux, `include/uapi/linux/virtio_gpu.h`, fetched 2026-10-01 from torvalds/linux `master` | BSD-3-Clause |
| `vulkan/` | Khronos Vulkan-Headers 1.4.354 (`vulkan.h`, `vulkan_core.h`, `vk_platform.h`, `vk_video/`), as Mesa 26.1.6 ships them in `include/vulkan/`, fetched 2026-10-02 | Apache-2.0 |

Each file keeps its own copyright and license header. Update a directory as a
whole and regenerate the constants.
