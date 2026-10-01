# VMware SVGA II 与 virtio-gpu 实现计划

> 状态：计划，尚未实现（2026-10-01，分支 `virtual_gpu`）。
> 范围：`graphics_adapter: "vmware_svga"` 和 `"virtio_gpu"` 两种显示设备，2D 和 3D 的全部特性。
> 主要验收客户机是 Windows 8.1 x64；Linux x86_64（Alpine 3.24）用来调试和验收开源驱动。
> 3DMark06 是 Windows 上第一个大型验收程序。
> 本文替代 2026-09-29 那份 virtio-gpu 计划（`virtio-gpu-webgpu-plan.zh-CN.md`），那个文件从未提交，已不在仓库里。它的主要判断已并入本文第 6 节。
> 2026-10-01 修订：三种显示适配器都做成插件，`graphics_adapter` 必须显式配置（4.8 节）；Windows 上的 virtio-gpu 3D（D1）和 Venus（D6）暂缓。

## 0. 结论先行

1. **在 Windows 上，SVGA II 是完整 3D 的路线，客户机侧不用写代码。**
   VMware Tools 里的 "VMware SVGA 3D" 是一整套 WDDM 驱动（内核驱动，D3D9/10/11 用户态驱动，OpenGL ICD），由 VMware 签名。
   我们只在宿主机实现设备：寄存器、FIFO 和命令缓冲区、GMR/MOB 客户机内存，以及 SVGA3D 命令到 WebGPU 的翻译。
   装上这套驱动后，Win 8.1 的 DWM 也改用硬件合成，不再由 WARP 在模拟 CPU 上做软件渲染。
2. **在 Windows 上，virtio-gpu 只有 2D。**
   - 现成的 Windows 驱动 viogpudo 只是显示驱动（DOD），没有 3D。
   - 它的 Win 8.1 构建在 2023-10-26 被移出源码树，所以要用这之前发布的 virtio-win。
   - Windows 上 virtio-gpu 的 3D 暂缓（D1）。以后要做的话，有两条路：走现有的图形代理（v86gl，需要 x64 版 `v86gl.sys`），或者自己写 WDDM 3D 驱动。
   - virtio-gpu 的 3D（virgl）面向 Linux 客户机，客户机侧不用写代码。Venus（Vulkan）暂缓（D6）。
3. **宿主机后端分三块，各自复用：**
   - **VGPU9**（SVGA3D 旧式命令，结构和 D3D9 一致）→ 现有的 D9WG 执行器 `d3d9_executor.js`。它已经能完整跑 3DMark06 的 SM2.0/3.0。
   - **VGPU10/SM5**（SVGA3D 的 DX 命令，D3D10/11 那种状态对象模型）和 **virgl**（Gallium 状态对象模型）→ 新建的共享后端 **GX**。GX 带一个共享的着色器 IR 和 WGSL 生成器，前端分别解析 VGPU10 token（DXBC 格式）和 TGSI。
   - **2D 扫描输出** → 现有的 DisplayHub 和 WebGPU 合成器，新增"GPU 纹理直接作为扫描输出"。
4. **"所有特性"的定义。** 两个设备向客户机声明的每一个能力位、命令、capset 和格式，都属于以下三类之一：
   - 真实实现；
   - 模拟实现，并在偏差表里登记（第 7 节）；
   - 不声明，并写明原因。

   WebGPU 没有的功能（几何着色器、曲面细分、流输出、8x MSAA、逻辑运算等）一律"模拟加登记"。这沿用 D3D8 迁移时定下的原则：做近似实现并记录偏差，而不是藏起能力位。
5. **先在 Linux 上调通，再上 Windows。**
   - vmwgfx + Mesa svga、virtio_gpu + Mesa virgl 都是开源的。
   - Alpine x86_64 的内核和 Mesa 已经带了这些驱动（已核实，见第 2 节）。
   - 出问题时可以对着驱动源码查。Windows 驱动是闭源的，只用来验收。
6. **3DMark06 测试状态必须在 v86 里用新设备抓取。**
   PCI 硬件是状态的一部分，驱动也只在启动时读一次能力位。所以 SVGA 的 3DMark06 状态要等里程碑 S3 冻结设备 ABI 之后再抓。在那之前，可以先把磁盘内容准备好（第 10 节）。
7. **三种显示适配器都是插件，按 `graphics_adapter` 加载。**
   - `bochs_vga`、`vmware_svga`、`virtio_gpu` 各是一个独立文件，只加载配置选中的那一个。
   - `graphics_adapter` 必须显式配置，不写就报错。界面和预设配置默认填 `bochs_vga`。
   - 核心只保留 PCI 总线、端口、`mmio_ram`、DisplayHub 和 presenter（4.8 节）。

## 1. 目标、范围和"完整"的定义

### 1.1 设备

| 设备 | PCI 身份 | 最终能力等级 |
| --- | --- | --- |
| VMware SVGA II | `15AD:0405`，子系统 `15AD:0405`，class `0300`（VGA） | 相当于 VMware 硬件版本 18：DX11 / SM5，客户机 GL 4.3（见第 2 节） |
| virtio-gpu | `1AF4:1050`，子系统 `1AF4:1100`，做成 virtio-vga（class `0300`，带 VGA 兼容） | 特性位 `VIRGL`、`EDID`、`RESOURCE_UUID`、`RESOURCE_BLOB`、`CONTEXT_INIT`；capset `VIRGL`、`VIRGL2`；`VENUS` 暂缓（D6） |

两种设备都替换现在的 Bochs VGA，占用同一个 PCI 槽位（`pci_functions(platform).vga`），其他设备的地址保持不变。同一时刻只有一种显示设备。

### 1.2 客户机与驱动

| 客户机 | 设备 | 驱动 | 用途 |
| --- | --- | --- | --- |
| Windows 8.1 x64 | SVGA II | VMware Tools 的 "VMware SVGA 3D"。13.1.5 仍支持 8.1 x64，前提是装了 KB2919355；早期等级可能需要更旧的 Tools，A0 决定 | 主要验收：D3D9（3DMark06）、D3D10/11、OpenGL ICD、DWM |
| Windows 8.1 x64 | virtio-gpu | virtio-win 的 viogpudo（2023-10 之前发布、带 w8.1 构建的版本） | 2D；3D 暂缓（D1） |
| Alpine 3.24 x86_64 | SVGA II | `vmwgfx.ko` + Mesa `svga` | 调试与验收：GL 2.1 → 3.3 → 4.1 → 4.3 |
| Alpine 3.24 x86_64 | virtio-gpu | `virtio_gpu.ko` + Mesa `virgl` | 调试与验收：GL/GLES（Vulkan 暂缓，D6） |
| Windows XP（可选） | SVGA II | VMware Tools 10.0.x 的 XPDM 驱动 | 未核实这个驱动的 3D 支持程度，只作为附加验收 |

### 1.3 WebGPU 做不到的特性怎么处理

- 能力位只有在背后有代码时才声明。做法和 `d3d8_proxy.c` 的 `fill_caps` 一样：每个声明的位都注明由哪段代码实现。
- 能模拟的就模拟，并在第 7 节登记一条偏差 `G-xx`，写清和真机的差别。
- 完全无法模拟的不声明，写明原因。驱动会因此降低功能级别；如果某个等级必需的特性无法提供，那个等级就不开放。
- 能力集合由"等级"（第 4.8 节）固定下来。同一个等级里的能力位不随浏览器浮动。开机时自动选等级，选定后写进存档；恢复时沿用存档里的等级，浏览器支持不了就报错，而不是悄悄改变能力位。否则同一个存档在不同浏览器上会看到不同的设备。

### 1.4 明确不做的

- **SVGA3（`15AD:0406`）。** Win 8.1 用不到。以后要支持 ARM 客户机时，可以在 SVGA II 的命令层前面加一层接口适配。
- **virtio-gpu 的 `GFXSTREAM_VULKAN`（3）、`CROSS_DOMAIN`（5）、`DRM`（6，原生上下文）三个 capset。**
  它们分别要求宿主机有 Android gfxstream、Wayland 透传和宿主机内核 GPU 驱动，在浏览器里没有意义，不声明。
- **MSI/MSI-X。** viogpudo 有 INTx 路径（已核实），vmwgfx 也支持传统中断。两个设备都只用 INTx。

暂缓（不在本轮排期里，以后再定）：

- **Windows 上 virtio-gpu 的 3D**（D1）：包括走 v86gl 代理（原 V6）和自己写 WDDM 驱动（原 V8）两条路。
- **Venus / Vulkan**（D6，原 V7）。6.5 节保留可行性分析，供以后参考。

## 2. 已核实的事实和来源

| 事实 | 来源 |
| --- | --- |
| SVGA II 寄存器 0–84（`SVGA_REG_TOP` = 85）、`SVGA_CAP_*` / `SVGA_CAP2_*` 全表、FIFO 命令 0–46、端口偏移（INDEX 0 / VALUE 1 / BIOS 2 / IRQSTATUS 8）、`SVGA_ID_0..3`、IRQ 标志 | Linux `drivers/gpu/drm/vmwgfx/device_include/svga_reg.h`（`GPL-2.0 OR MIT`） |
| SVGA3D 命令：旧式 1040–1082，GB 对象 1091–1142，DX 1143–1226，之后的扩展到 1291 | 同目录 `svga3d_cmd.h` |
| DevCap 索引：`DXCONTEXT` 95、`DXFMT_*` 100–243、`SM41` 244、`MULTISAMPLE_2X/4X` 245/246、`SM5` 258、`MULTISAMPLE_8X` 259、`MAX` 262 | 同目录 `svga3d_devcaps.h` |
| SeaVGABIOS 的 `bochsvga.c` 遇到厂商 `0x15ad` 时从 BAR1 取 LFB，virtio 从 BAR0 取，所以 BIOS 代码不用改 | coreboot/seabios `vgasrc/bochsvga.c` |
| 但 VGA BIOS 的 PCI ROM 头必须写对设备号。v86 通过 PCI 扩展 ROM BAR（`0xFEB00000`）提供 VGA BIOS，而 SeaBIOS 的 `map_pcirom` 只执行 PCIR 头里厂商号/设备号与设备一致的 ROM。SeaVGABIOS 的 `CONFIG_VGA_BOCHS_VMWARE`（`15ad:0405`）、`CONFIG_VGA_BOCHS_VIRTIO`（`1af4:1050`）等变体只有这几个字节不同，代码在运行时读设备真实的 ID。所以 v86 加载时直接改写 PCIR 里的 ID，并重算 SeaBIOS 放在第 6 字节的校验和（`scripts/buildrom.py`），同一个 `vgabios.bin` 给三种显卡共用，不另外构建（A1 已实现，`patch_vga_bios_ids`） | coreboot/seabios `src/optionroms.c`、`vgasrc/Kconfig`、`scripts/buildrom.py`；v86 `src/cpu.js` 加载 VGA BIOS 的代码 |
| VMware Tools 13.1.5 仍支持 Windows 8.1 x64（需要 KB2919355），8.1 的驱动处于只修严重问题的维护状态 | Broadcom "VMware Tools compatibility with guest operating systems" |
| DX10.1 需要硬件版本 16 及以上，DX11 需要 18 及以上；客户机 OpenGL 驱动支持 3.3/4.1/4.3 兼容模式 | VMware Workstation 16/17 文档 "Prepare a Virtual Machine to Use Accelerated 3D Graphics" |
| viogpudo 是 DOD。Win 8.1 目标在 commit `c165bd54`（2023-10-26）删除，现在只构建 Win10/11 | virtio-win/kvm-guest-drivers-windows `viogpu/viogpudo/viogpudo.vcxproj` 的历史 |
| viogpudo 把 BAR0 当帧缓冲段：BAR0 够大时直接用它的物理地址，不够大就自己分配。BAR 可以是 I/O 端口，支持 INTx。实现了 `DxgkDdiEscape`，但只用来设置自定义分辨率。INF 匹配 `PCI\VEN_1AF4&DEV_1050&SUBSYS_1100…&REV_01` 和裸的 `VEN/DEV` | `viogpudo.cpp`（`HWInit`、`Escape`）、`common/viogpu_pci.cpp`、`viogpudo.inx` |
| viogpu3d（PR #943）：Win10 及以上，D3D10 用户态驱动用 Mesa + 打过补丁的 virglrenderer 构建，2023 年提交后一直没有合并 | PR #943 及相关讨论 |
| Alpine linux-lts 的 virt 配置有 `DRM_VMWGFX=m`、`DRM_VIRTIO_GPU=m`、`DRM_BOCHS=m`；Mesa 在 x86_64 上的 gallium 驱动包含 `svga` 和 `virgl`，Vulkan 驱动包含 `virtio`（Venus） | alpinelinux/aports `main/linux-lts/virt.x86_64.config`、`main/mesa/APKBUILD` |
| 本机 mingw-w64 14.0 有 `wdm.h`/`ntddk.h`/`video.h`/`d3dhal.h`，以及 D3D10/11/DXGI 的头文件和导入库；没有 WDDM 驱动头文件（`dispmprt.h`、`d3dkmddi.h`、`d3dumddi.h`）。`osslsigncode` 没装 | 本机检查 |

### 2.1 未核实，由 A0 解决

- **U1** Win 8.1 的 VMware 驱动在什么能力位下会加载、启用 3D、选择 VGPU9 还是 DX 路径？是否要求 GB 对象？是否用 backdoor（端口 `0x5658`）？INF 里的硬件 ID 是什么？
- **U2** 设备声明了 DX 能力时，VMware 的 D3D9 用户态驱动（`vm3dum*.dll`）发出的是 VGPU9 还是 VGPU10 命令？这决定了 3DMark06 在 DX 等级下走 D9WG 还是走 GX。
- **U3** 哪个 virtio-win 版本的 ISO 里还有 `viogpudo\w8.1\amd64`，签名是否是正式签名？
- **U4** 用户的 Win 8.1 镜像有没有装 KB2919355（Build 9600.17031 及以上）？
- **U5** VMware 驱动开放 D3D11 FL11_0 时，是否要求设备支持 8x MSAA？WebGPU 只有 1x 和 4x。

## 3. v86 现状

| 部分 | 现状 | 本计划要改什么 |
| --- | --- | --- |
| `src/vga.js` | Bochs VGA + VBE；LFB 是 BAR0（`mmio_ram` 区域，带 `on_move`）；作为 DisplaySource 接入 DisplayHub | 移出核心：拆成共享的 VGA 核心加 `bochs_vga` 插件，SVGA II 和 virtio-vga 也内嵌同一份 VGA 核心（4.8 节） |
| `src/cpu.js` | 和 VGA 的耦合只有四处：创建 `VGAScreen`（2661 行）、存档 `state[52]`、VGA BIOS 加载（写 `0xC0000`，同时作为 PCI 扩展 ROM 放在 `0xFEB00000`）、`devices.vga` | 改为通过插件接口创建适配器；`state[52]` 加上适配器名字；VGA BIOS 由插件提供；`devices.vga` 保留为别名 |
| `src/rust/cpu/mmio_ram.rs` | 最多 4 个设备内存区域，带 4 KiB 页脏位图和 RGBA 转换 | 增加不做像素转换的区域（FIFO、共享内存）；设备读 FIFO 指针时用原子读 |
| `src/pci.js` | 32 位内存 BAR（`on_move`），I/O BAR，没有 MSI，没有 64 位 BAR | 支持 prefetchable 位和一个设备上的多个内存 BAR，验证大于等于 128 MiB 的 BAR 能被 SeaBIOS 分配 |
| `src/virtio.js` | 只支持 modern 设备；四个 capability 固定放在 I/O 端口的 BAR0–3；class code 固定；没有 MMIO capability 和共享内存 capability | 每个 capability 可以指定 BAR 号和偏移，也可以几个共用一个 BAR；class code 可配置；BAR0 留给 VRAM；支持 `SHARED_MEMORY_CFG`（类型 8） |
| `src/vmware.js` | backdoor：GETVERSION、绝对坐标鼠标、剪贴板、GETTIME；没有 RPCI/GuestRPC | 按 A0 的结论决定是否补 GuestRPC 的最小子集 |
| `src/display.js` 和合成器 | 只有一个画布；扫描输出是 CPU 送来的像素（`put_pixels`）；窗口层；没有光标平面 | 增加 GPU 纹理扫描输出、光标平面、多屏布局 |
| `src/browser/glbridge/d3d9-webgpu/` | D9WG 执行器：D3D9 SM1–3、固定管线、各种 D3D9 特性，已跑通 3DMark06；没有 `serializeState` | VGPU9 的后端。存档由 SVGA 层自己负责，不依赖执行器序列化（第 4.7 节） |
| 图形存档 | 按命令日志重放 | 对新设备不适用：DWM 持续渲染，日志会无限增长。改为设备级检查点 |
| `src/browser/starter.js` | `graphics_adapter` 可以不写（默认 Bochs VGA），只接受 `"bochs_vga"` | 必须显式配置，不写就报错；按配置加载插件；接受 `"vmware_svga"`、`"virtio_gpu"` 及各自的选项 |
| 构造 `V86` 的地方 | 仓库里有 225 个文件（测试 200 多个、`examples/` 18 个、`src/browser` 3 个）都没写 `graphics_adapter` | 用脚本统一补上 `graphics_adapter: "bochs_vga"` |
| `cpu.read_blob_physical` / `write_blob_physical` | 能访问 4 GiB 以上的物理地址（扩展内存） | DMA 统一用它们 |

## 4. 总体架构

```text
=== 客户机 ====================================================================
 Win 8.1: vm3dum*.dll / vm3dmp.sys        Linux: Mesa svga/virgl + vmwgfx/virtio_gpu
        │ FIFO / 命令缓冲区 / 寄存器              │ virtqueue
=== CPU 线程（或 CPU worker）===================================================
 插件 v86-vmware-svga.js                  插件 v86-virtio-gpu.js
 （内嵌 VGA 核心）                          （内嵌 VGA 核心）
  - 寄存器、FIFO、命令缓冲区、IRQ            - 控制队列/光标队列、事件、EDID
  - GMR/MOB/OTable 遍历，DMA                - 资源和 backing 页表，DMA
  - 2D 命令在本地执行（VRAM）                - 2D 资源在本地执行
  - 3D 命令：取齐引用的客户机数据后封包       - SUBMIT_3D：同样封包
        └──────────────┬───────────────────────────┘
                       │ gpu_channel（批次 / 回写 / fence / 扫描输出通知）
=== 主线程 =====================================================================
   svga3d/：VGPU9 → D9WG 执行器（现有）
            VGPU10/SM5 → GX
   virgl/：virgl → GX
   GX：资源与视图、状态对象到管线、GS/SO/细分模拟、查询、着色器 IR 到 WGSL
                       │
                       ▼
   合成器：扫描输出（CPU 像素或 GPU 纹理）+ 光标平面 + v86gl 窗口层 → 一个 <canvas>
```

### 4.1 CPU 侧和渲染侧的分工

- **CPU 侧**（适配器插件，跑在 CPU 所在的线程，不依赖 WebGPU）：
  - 所有寄存器语义、FIFO 和命令缓冲区的解析、IRQ；
  - 客户机内存寻址（GMR、MOB 页表、OTable、virtio backing）；
  - 2D 命令（直接在 VRAM 或 2D 资源上执行）；
  - 3D 命令只做两件事：校验长度，把引用到的客户机数据读出来，和命令一起打成自包含的批次。
  - 没有 WebGPU 时（node、Canvas2D 回退），设备只声明 2D 等级，照样完整可用。
- **渲染侧**（`src/browser/glbridge/`，在图形包 `libv86-webgpu.js` 里）：只处理批次，不直接读客户机内存。这和 v86gl 设备与渲染器的分工一致，CPU worker 模式不需要额外设计。
- 渲染侧要写回客户机内存时（readback、查询结果、MOB fence），发 `write` 消息给 CPU 侧，由 CPU 侧写入，然后再让对应的 fence 完成。

### 4.2 gpu_channel

新文件 `src/gpu_channel.js`，以 `v86gl_device.js` 的通道为原型，两个设备共用：

| 方向 | 消息 | 内容 |
| --- | --- | --- |
| 设备 → 渲染器 | `submit` | `{ seq, stream, bytes, completions }`：`stream` 区分 SVGA 的命令缓冲区上下文、virgl 上下文或 ring；`completions` 列出这个批次完成后要做的事（写 fence、写查询结果、置 CB 状态、发 IRQ） |
| 设备 → 渲染器 | `scanout` | `{ screen, kind: "cpu" \| "gpu", surface, rect }` |
| 渲染器 → 设备 | `write` | `{ seq, address, bytes }`：写客户机物理内存 |
| 渲染器 → 设备 | `done` | `{ seq }`：批次及其所有回写都完成了 |
| 渲染器 → 设备 | `lost` | WebGPU 设备丢失。设备向客户机报错（SVGA 置 `SVGA_IRQFLAG_ERROR`，virtio 回错误响应），由驱动走自己的恢复流程 |

- 流量控制沿用 v86gl 的上限：跨线程时最多 8 个批次、32 MiB 在途，超过就让客户机等。
- 同一线程时批次立即执行，但需要 `mapAsync` 的步骤仍然是异步的。

### 4.3 客户机内存访问

- 所有 DMA 经过 `read_blob_physical`/`write_blob_physical`，支持 4 GiB 以上的扩展内存。GMR 的 PPN64、MOB 的 64 位页表、virtio 的 64 位地址都按 64 位处理。
- 页表遍历的结果按 (MOB/GMR id, 世代号) 缓存，在 `REMAP_GMR2`、`UPDATE_GB_MOB_MAPPING`、`DESTROY` 时失效。
- FIFO 和共享内存区域在并行模式下是 SharedArrayBuffer。设备读 `SVGA_FIFO_NEXT_CMD` 一类"发布指针"时要用 `Atomics.load`，之后才能读数据；写 `SVGA_FIFO_STOP`、`SVGA_FIFO_FENCE` 时用 `Atomics.store`。

### 4.4 同步、完成和 TDR

- **SVGA fence**（`SVGA_CMD_FENCE`、MOB fence、`SVGA_REG_FENCE`）在它之前的所有批次都 `done` 之后才前进，并按 IRQMASK 触发 `ANY_FENCE`/`FENCE_GOAL`。
- **`SVGA_REG_SYNC` / `SVGA_FIFO_BUSY`**：SYNC 是门铃。设备把 FIFO 里的命令取空、封进批次，就可以释放 FIFO 空间（推进 STOP）并清 BUSY，不必等 GPU 完成。真正的完成用 fence 表示。
- **命令缓冲区**：每个上下文按顺序处理。`status` 在批次 `done` 后写为 `COMPLETED`，再按 `NO_IRQ` 标志决定是否触发 `COMMAND_BUFFER` 中断。
- **virtio-gpu**：带 `VIRTIO_GPU_FLAG_FENCE` 的命令，在它和它之前的命令都完成后，才把描述符放进 used ring。Linux 要求 fence 按顺序完成。带 `INFO_RING_IDX` 时按 ring 分别排序。
- **TDR**：WDDM 在 GPU 两秒（客户机时间）不响应时会重置驱动。模拟器里客户机时间跟随墙钟，而宿主机编译着色器或回读时可能卡住。对策：
  - fence 必须及时完成；
  - 着色器编译异步进行，但对客户机保持"按顺序完成"；
  - 测试镜像里设置 `TdrDelay=60`、`TdrDdiDelay=60`，调试时再设 `TdrLevel=0`。

### 4.5 扫描输出和合成

- **CPU 扫描输出**（VRAM 2D 模式、Screen Object 的 VRAM/GMR 后备、virtio 2D 资源）：和现在的 VGA 一样，走 DisplayHub 的 `put_pixels`，脏区域来自 `UPDATE` 命令或 mmio_ram 的脏页位图（SVGA 的 `TRACES` 模式）。
- **GPU 扫描输出**（Screen Target 绑定的 GB 表面、`PRESENT` 到屏幕、virgl 表面做扫描输出）：DisplayHub 只记录"屏幕 N = GPU 表面 id + 矩形"，合成器直接从渲染器拿纹理，不回读到 CPU。
- **光标平面**：合成器新增光标层，接收 SVGA 的单色光标、彩色光标、alpha 光标和 CURSOR4，以及 virtio 的 `UPDATE_CURSOR`/`MOVE_CURSOR`。
- **多屏**：SVGA 的 Screen Object 和 virtio 的多个 scanout 按客户机报告的位置拼在一个外接矩形里显示。这个矩形就是画布尺寸。
- **DisplayHub 切换**：设备处于 VGA/VBE 模式（`SVGA_REG_ENABLE` = 0，或 virtio 驱动还没 `SET_SCANOUT`）时显示 VGA 核心；驱动接管后切到设备自己的扫描输出。`display-design.md` 里"virtio-gpu 接管后 VGA 让位"的设想由此落地。
- v86gl 代理的窗口层照样叠加在上面，遮挡上报的机制不变。

### 4.6 GX 与着色器 IR

GX 是 VGPU10/SM5 和 virgl 共用的 WebGPU 后端（`src/browser/glbridge/gx/`）：

- **资源和视图**：buffer、1D/2D/3D/cube/数组/多重采样纹理，SRV/RTV/DSV/UAV 视图，格式转换表。
- **状态对象到管线**：blend、depth-stencil、rasterizer、sampler、输入布局。按（着色器、状态、RT 格式、拓扑、顶点拉取布局）缓存 `GPURenderPipeline`。
- **渲染通道**：连续的 draw 尽量合并进同一个 render pass，遇到 RT 切换、clear、copy 或 query 时才结束。
- **模拟**：
  - GS：用计算着色器执行，结果写入存储缓冲，再用间接绘制画出来；
  - 流输出：同一套捕获缓冲，`DrawAuto` 读计数；
  - 曲面细分：HS 在计算着色器里跑；细分器用计算着色器实现，算法参照 Mesa `gallium/auxiliary/tessellator`（微软参考细分器，MIT 许可）；DS 当作对生成点做顶点拉取的 VS；
  - 条件渲染：在 GPU 上把间接绘制的参数清零；
  - 顶点拉取：用于超过 8 个缓冲、16 个属性，或格式 WebGPU 不支持的情况。
- **查询**：occlusion 和 timestamp 用 WebGPU 的原生查询；SO 统计用计数器；pipeline statistics 近似（G-13）。
- **着色器 IR**（`src/browser/glbridge/shader_ir/`）：结构化控制流、SSA 风格的值、资源绑定表；一个 WGSL 生成器；几个变换遍（GS/细分改写为计算着色器、顶点拉取、provoking vertex、深度范围修正）。前端：
  - `dxbc_frontend.js`：VGPU10 token，SM4.0/4.1/5.0 加上 VMware 扩展操作码；
  - `tgsi_frontend.js`：virgl 传来的 TGSI 文本。

  D3D9 字节码继续由现有的 `d3d9_shader_pipeline.js` 处理，不迁到新 IR。
- 所有生成的 WGSL 都进 naga 验证语料库，和现在的 D9WG/GL 做法一样。

### 4.7 存档和恢复：设备级检查点

现有的"日志重放"不适合新设备：DWM 和桌面会话一直在渲染，日志会无限增长。新设备在 `prepare_save` 时先排空在途批次，然后：

- **SVGA，GB 模式**：设计上就适合做检查点。OTable、COTable 和 MOB 都在客户机内存里，本来就随内存存档。宿主机只需要：
  - 把"GPU 上比 MOB 新"的表面写回它绑定的 MOB，语义同 `READBACK_GB_SURFACE`；
  - 把上下文状态写进上下文 MOB。上下文 MOB 的内容对客户机不透明，格式由我们定。

  恢复时按需从 OTable 和 MOB 惰性重建 GPU 对象。
- **SVGA，旧式（VGPU9）**：表面没有客户机后备，由宿主机回读所有表面内容，写进存档里的 blob。SVGA 层本来就保存了每个上下文的完整状态影子（切换上下文时需要它），一并存档。恢复时在一个新的 D9WG 执行器里重新发出创建和上传命令。这条路不依赖执行器本身能序列化。
- **virtio-gpu**：
  - 2D 资源恢复时从 backing 重新传输；
  - 3D 资源的内容回读后存进 blob；
  - virgl 对象存的是"活着的对象各自的创建命令"，大小有上限，不保存历史；绑定状态恢复时重新下发。
- 存档里记录设备种类、等级和能力集合。恢复到配置不同的模拟器时明确报错。

### 4.8 配置和显示适配器插件

**配置**

对用户只公开两个选项：

```js
new V86({
    graphics_adapter: "vmware_svga",   // 必填："bochs_vga" | "vmware_svga" | "virtio_gpu" | "none"
    vram_size: 64 << 20,               // 可选，不写就用该适配器的默认值
});
```

- **`vram_size`** 替代现在的 `vga_memory_size`，对三种适配器含义相同：显存 BAR 的大小，也就是 Bochs 的 LFB、SVGA 的 BAR1、virtio-vga 的 BAR0。
  - 必须是 2 的幂，范围由各适配器规定，不合法就报错。
  - 默认值：`bochs_vga` 保持现在的 8 MiB；`vmware_svga` 和 `virtio_gpu` 分别在 S1 和 V1 定。viogpudo 只有在 BAR0 不小于 16 MiB 时才直接用它当帧缓冲，所以 virtio 的默认值至少 16 MiB。
  - 旧名字 `vga_memory_size` 报错并提示改名。反正 `graphics_adapter` 改成必填后，所有配置都要改一遍，用同一个脚本一起改（41 个文件）。`index.html` 的 `?vram=` 查询参数保持不变。
- **能力等级不再由用户选择。**
  - 开机时，插件自动选出"已经实现、并且当前浏览器的 WebGPU 支持"的最高等级。没有 WebGPU，或者没有加载 `libv86-webgpu.js` 时，退到 2D 等级，并在控制台说明原因。
  - 选出的等级写进存档。恢复时沿用存档里的等级，不重新选择；当前浏览器支持不了这个等级就报错。所以新版本必须一直保留旧的等级，不能删除。
  - 测试和开发需要固定等级，比如 D2 规定 3DMark06 第一次跑 `vgpu9`，之后每级回归。为此留一个测试专用的内部选项，不写进公开文档，名字在实现时定。
- **其余设备参数都不公开**，固定成合理的默认值：
  - virtio 的特性位（`virgl`、`blob`、`context_init` 等）按"已实现并且浏览器支持"自动打开，规则和 SVGA 的等级一样；
  - 屏幕数和 scanout 数固定为 1。多屏代码照样实现，用前面那个测试选项打开。

- **`graphics_adapter` 必填。** 不写就报错，错误信息列出可用的值。
  - 界面（`index.html`、`debug.html` 的下拉框）、`main.js` 的预设、`examples/` 和测试一律显式写 `"bochs_vga"`，这就是"默认 Bochs VGA"的含义。
  - 只接受已经实现的值，其余报错。旧的函数形式（`installV86GLGraphicsAdapter`）照旧报错。
  - `"none"` 表示不要显示设备，只用串口（D7）。这时不加载任何插件，也不加载 VGA BIOS，SeaBIOS 在没有显卡的情况下照常启动。`wait_until_vga_screen_contains` 一类依赖 VGA 文本的接口会报出明确的错误。
- SVGA 等级依次为：`"2d"`、`"2d-full"`、`"vgpu9"`、`"gb9"`、`"dx10"`、`"dx10.1"`、`"dx11"`。每个等级对应一组固定的能力位和 devcap 值（附录 A，由 A0 和各个 S 里程碑填写）。这些名字只在内部、存档和测试里出现。
- `"vgpu9"` 及以上，以及 virtio 的 `virgl`，需要 `libv86-webgpu.js`。

**插件**

| 插件文件 | 内容 | PCI ID（VGA BIOS 的 ROM 头改写成它） |
| --- | --- | --- |
| `v86-bochs-vga.js` | VGA 核心 + Bochs PCI 外壳（原来的 `vga.js`） | `1234:1111` |
| `v86-vmware-svga.js` | VGA 核心 + SVGA II 设备的 CPU 侧（第 5 节） | `15ad:0405` |
| `v86-virtio-gpu.js` | VGA 核心 + virtio-gpu 设备的 CPU 侧（第 6 节） | `1af4:1050` |

- **插件描述符**：`{ name, vga_bios, create(machine, options) }`。`create` 返回的设备对象实现 `get_state`、`set_state`、`reset`、`destroy`，需要时再实现异步的 `prepare_save`/`after_restore`（3D 等级要用，用来排空 GPU 并写回 MOB）。
- **`machine` 接口**只暴露 `vga.js` 现在实际用到的那些，再加上 SVGA 和 virtio 需要的：
  - PCI 注册（多个内存 BAR、`on_move`、ROM BAR）、端口注册、`mmap_register`；
  - `mmio_ram_*`（allocate、map、backing、dirty、pixels）；
  - 物理内存读写（含 4 GiB 以上）；
  - 中断；
  - `MachineClock` 和 vblank 挂钩；
  - DisplayHub（注册 DisplaySource）、bus、平台信息；
  - 核心的 `VirtIO` 类（virtio-gpu 用）。

  这些都用带引号的属性名，Closure ADVANCED 编译不会改名。插件单独用 Closure 编译，配一个 externs 文件描述这个接口，保留类型检查。
- **virtio-gpu 为什么不走现有的 `virtio_devices` 接口**：它需要内嵌 VGA 核心，还需要一个内存 BAR 作 VRAM，而 `virtio_devices` 只支持 I/O 端口的 virtio。所以它走显示适配器接口，在内部复用 `VirtIO` 类。
- **VGA 核心**是共享源码（`src/graphics_adapters/vga_core.js`），在构建时分别打进三个插件。同一时刻只加载一个插件，所以重复打包不浪费运行时内存。
- **加载**：
  - 先查全局注册表：页面可以自己用 `<script>` 或 `require` 提前加载插件，做法同 xterm 和 `libv86-webgpu.js`；
  - 没找到，就按需加载插件文件。默认在 libv86 包自己旁边找 `v86-<name>.js`：页面里用经典脚本加载时取 `document.currentScript`，node 里用 CommonJS 的 `__dirname`；两者都没有时（ES 模块、worker）退回相对页面或当前目录的 `build/`，和 `wasm_path` 的默认值一致；用 `graphics_adapter_path` 可以指定插件文件的完整路径（D7）。CPU worker 模式下，页面先把路径解析成绝对 URL 再交给 worker；
  - CPU 在 worker 里时，只在 worker 里加载（`importScripts`），页面不需要设备代码；
  - 并行模式下设备只在 machine 线程，vCPU worker 不加载；
  - node 用同样的规则，从 `build/` 加载。
- **VGA BIOS**：仍由 `vga_bios` 选项提供（三种显卡共用 `bios/vgabios.bin`）。v86 加载时把 ROM 头的 PCI ID 改写成插件描述符里的 `pci_vendor`/`pci_device`，原因见第 2 节。`"none"` 不加载 VGA BIOS。
- **存档**：`state[52]` 改为 `{ adapter, version, state }`。没有适配器名字的旧存档按 `bochs_vga` 恢复。适配器不一致时报错，信息里写明存档用的是哪个适配器。
- **兼容**：`cpu.devices.vga` 保留为当前适配器 VGA 核心的别名。`tests/devices/mmio_ram.js`、`tests/x64/frame_buffer.mjs`、`windows_boot.mjs` 等 7 个文件直接用了它。`mmio_ram` 的区域由适配器最先申请，区域号顺序和现在一致，旧存档里的区域布局不变。
- **上游**：上游基本不会接受把 VGA 移出核心，这一部分会一直是 fork 自己的改动。插件接口要保持通用，必要时核心仍能静态编进 `bochs_vga`，方便以后拆出可以提交上游的部分。

### 4.9 文件布局

| 位置 | 文件 |
| --- | --- |
| 核心 `src/` | `graphics_adapter.js`（注册表、加载器、`machine` 接口）；`vga.js` 移走 |
| 插件源码 `src/graphics_adapters/` | `vga_core.js`、`bochs_vga.js`、`vmware_svga/`（`svga_device.js`、`svga_fifo.js`、`svga_cmdbuf.js`、`svga_gmr.js`、`svga_mob.js`、`svga_2d.js`、`svga_devcaps.js`、`svga_constants.js`）、`virtio_gpu/`（`virtio_gpu_device.js`、`virtio_gpu_2d.js`、`virtio_gpu_constants.js`）、`gpu_channel.js`（插件和渲染器共用） |
| 构建产物 | `build/v86-bochs-vga.js`、`build/v86-vmware-svga.js`、`build/v86-virtio-gpu.js`（Closure SIMPLE，和 libv86.js 一样），随各个 libv86 包一起构建 |
| 渲染 `src/browser/glbridge/` | `svga3d/`（`svga3d_renderer.js`、`vgpu9_d9wg.js`、`svga_dx.js`、`svga_formats.js`）、`gx/`、`shader_ir/`、`virgl/`、`gpu_checkpoint.js` |
| 第三方头文件 | `third_party/vmware-svga/`（Linux 的 `device_include/*.h`，按 MIT 条款使用，另加 Mesa 的 `VGPU10ShaderTokens.h`）、`third_party/virgl/`（`virgl_protocol.h`、`virgl_hw.h`，MIT）、`include/uapi/linux/virtio_gpu.h` |
| 工具 | `tools/gen_svga_constants.js`、`tools/gen_virgl_constants.js`、`tools/gpu_trace/`（抓取和重放） |
| 测试 | `tests/devices/vmware_svga.js`、`tests/devices/virtio_gpu.js`、`tests/gpu/`（trace 重放、着色器语料）、`tests/x64/linux_gpu.mjs`、`tests/x64/windows_gpu.mjs` |

常量全部从头文件生成，不手抄。`gl_constants.js` 已经是这么做的。

## 5. VMware SVGA II 设计

### 5.1 PCI 和 VGA 兼容

| BAR | 类型 | 大小 | 内容 |
| --- | --- | --- | --- |
| BAR0 | I/O | 16 字节 | `INDEX`（+0）、`VALUE`（+1）、`BIOS`（+2）、`IRQSTATUS`（+8） |
| BAR1 | 内存，32 位，prefetchable | `vram_size`（默认 64 MiB） | 帧缓冲。就是 VGA 核心的 LFB 区域，SeaVGABIOS 的 VBE 也从这里取 LFB |
| BAR2 | 内存，32 位 | 2 MiB | FIFO：FIFO 寄存器区、3D 能力记录、命令环 |

- VGA 的旧端口和 VBE dispi 端口（`0x1CE`/`0x1CF`）都保留，由内嵌的 VGA 核心处理，因此 BIOS、DOS、Windows 启动画面和 Basic Display 驱动都照常工作。
- `SVGA_REG_ENABLE` = 1 时 DisplayHub 切到 SVGA 扫描输出；设置 HIDE 位或 ENABLE = 0 时切回 VGA 核心。

### 5.2 寄存器

按能力位分组实现。只有声明了某个能力位，才实现对应的寄存器；没实现的寄存器读出 0，写入记日志。

| 组 | 寄存器 | 要点 |
| --- | --- | --- |
| 身份和模式 | `ID`、`ENABLE`、`WIDTH`、`HEIGHT`、`MAX_WIDTH/HEIGHT`、`DEPTH`、`BITS_PER_PIXEL`、`PSEUDOCOLOR`、`RED/GREEN/BLUE_MASK`、`BYTES_PER_LINE`、`PITCHLOCK`、`HOST_BITS_PER_PIXEL` | ID 协商最高到 `SVGA_ID_2`；8 位模式用调色板寄存器（`SVGA_PALETTE_BASE` 起） |
| 内存 | `FB_START`、`FB_OFFSET`、`VRAM_SIZE`、`FB_SIZE`、`MEM_START`、`MEM_SIZE`、`MEMORY_SIZE`、`MAX_PRIMARY_MEM`、`GBOBJECT_MEM_SIZE_KB`、`SUGGESTED_GBOBJECT_MEM_SIZE_KB`、`MOB_MAX_SIZE` | `*_START` 跟随 BAR 的实际位置 |
| FIFO 和同步 | `CONFIG_DONE`、`SYNC`、`BUSY`、`FIFO_CAPS`、`FENCE`、`FENCE_GOAL` | 见 5.3 |
| 能力 | `CAPABILITIES`、`CAP2`、`DEV_CAP`（先写索引再读值）、`DEVEL_CAP` | 由等级决定 |
| 客户机信息 | `GUEST_ID`、`GUEST_DRIVER_ID`、`GUEST_DRIVER_VERSION1..3` | 只记日志，方便诊断驱动版本 |
| 多屏 | `NUM_DISPLAYS`、`NUM_GUEST_DISPLAYS`、`DISPLAY_ID`、`DISPLAY_IS_PRIMARY`、`DISPLAY_POSITION_X/Y`、`DISPLAY_WIDTH/HEIGHT` | `DISPLAY_TOPOLOGY` 能力 |
| GMR | `GMR_ID`、`GMR_DESCRIPTOR`、`GMR_MAX_IDS`、`GMR_MAX_DESCRIPTOR_LENGTH`、`GMRS_MAX_PAGES` | 5.5 |
| 命令缓冲区 | `COMMAND_LOW/HIGH`、`CMD_PREPEND_LOW/HIGH` | 5.6 |
| 中断 | `IRQMASK`、`IRQ_STATUS`（加上 I/O 端口 `IRQSTATUS`） | 5.7 |
| 光标 | 旧式 `CURSOR_*`（ID/X/Y/ON）、`CURSOR4_ON/X/Y/SCREEN_ID/SUBMIT`、`CURSOR_MOBID`、`CURSOR_MAX_BYTE_SIZE`、`CURSOR_MAX_DIMENSION` | 5.4 |
| Screen Target | `SCREENTARGET_MAX_WIDTH/HEIGHT`、`BLANK_SCREEN_TARGETS` | 5.9 |
| 其他 | `TRACES`、`SCRATCH_SIZE` 和 scratch 寄存器、`SCREENDMA`、`MSHINT`、`DIRTY_TRACKING`、`REGS_START_*`、`FB_START_*` | 声明了对应的 `CAP2` 才实现 |

### 5.3 FIFO

- FIFO 寄存器区的字段：`MIN`、`MAX`、`NEXT_CMD`、`STOP`、`CAPABILITIES`、`FLAGS`、`FENCE`、`3D_HWVERSION`、`PITCHLOCK`、光标旁路（`CURSOR_ON/X/Y/COUNT/LAST_UPDATED`）、`RESERVED`、`CURSOR_SCREEN_ID`、`3D_HWVERSION_REVISED`、`3D_CAPS`（索引 32–287，旧式 3D 能力记录）、`GUEST_3D_HWVERSION`、`FENCE_GOAL`、`BUSY`。
- `SVGA_FIFO_CAPABILITIES` 声明 `FENCE`、`ACCELFRONT`、`PITCHLOCK`、`VIDEO`、`CURSOR_BYPASS_3`、`ESCAPE`、`RESERVE`、`SCREEN_OBJECT`、`GMR2`、`SCREEN_OBJECT_2`，按等级取舍。
- **处理时机**：每次写 `SVGA_REG_SYNC` 时处理；另外每个 vblank 轮询一次作为兜底。
- **环形缓冲**：命令可能跨越 `MAX` 回绕，设备把跨界的命令拷到一个连续的临时缓冲里再解析。
- **`RESERVE` 协议**：客户机可能在 FIFO 里原地写一个大命令，然后用 `RESERVED` 字段提交，这种情况要单独处理。
- 3D 命令的格式是 `SVGA3dCmdHeader { id, size }`，和 2D 命令（只有 32 位 id）混在同一个流里。

### 5.4 2D、Screen Object、光标、多屏

| 命令 | 实现 |
| --- | --- |
| `UPDATE`、`UPDATE_VERBOSE` | 把 VRAM 里的脏矩形送到扫描输出。声明了 `TRACES` 时，也会直接用脏页位图 |
| `RECT_COPY`、`RECT_ROP_COPY`、`FRONT_ROP_FILL` | 直接在 VRAM 上做；ROP3 在 CPU 上算 |
| `DEFINE_CURSOR`、`DEFINE_ALPHA_CURSOR` | 送到合成器的光标平面；AND/XOR 掩码在 CPU 上转成 RGBA |
| `DEFINE_SCREEN`、`DESTROY_SCREEN` | Screen Object 1/2：每个屏幕的位置、尺寸、后备存储（VRAM 或 GMR） |
| `DEFINE_GMRFB`、`BLIT_GMRFB_TO_SCREEN`、`BLIT_SCREEN_TO_GMRFB` | GMR 里的帧缓冲和屏幕之间的拷贝 |
| `ANNOTATION_FILL`、`ANNOTATION_COPY` | 作为下一个 blit 的附加信息：填充提示和拷贝来源 |
| `DEFINE_GMR2`、`REMAP_GMR2` | 5.5 |
| `FENCE`、`NOP`、`NOP_ERROR` | `NOP_ERROR` 会触发 `ERROR` 中断，驱动用它做自检 |
| `ESCAPE` | 视频叠加（`SVGA_ESCAPE_VMWARE_VIDEO*`）在 S8 实现；其他 escape 记日志后忽略 |

### 5.5 GMR / GMR2

- **寄存器方式（GMR1）**：写 `GMR_ID`，再写 `GMR_DESCRIPTOR`（指向描述符链的 PPN）。描述符是 `{ppn, numPages}` 列表，`numPages` 为 0 表示跳到下一个描述符页。
- **命令方式（GMR2）**：`DEFINE_GMR2`、`REMAP_GMR2`，支持 PPN32/PPN64 列表、单页、偏移。
- 特殊 id：`SVGA_GMR_FRAMEBUFFER`（VRAM）和 `SVGA_GMR_NULL`。
- 上限通过 `GMR_MAX_IDS`、`GMRS_MAX_PAGES`、`MEMORY_SIZE` 报告。
- `SVGAGuestPtr {gmrId, offset}` 解析成若干段连续的物理地址，再交给 DMA。

### 5.6 命令缓冲区

- 提交方式：客户机先写 `COMMAND_HIGH`，再写 `COMMAND_LOW`。`COMMAND_LOW` 的低位是上下文号：`CONTEXT_0`、`CONTEXT_1`（高优先级队列）或 `CONTEXT_DEVICE`。
- `SVGACBHeader`（64 字节对齐）：
  - `status`、`errorOffset`、`id`、`flags`（`NO_IRQ`、`DX_CONTEXT` 等）；
  - `length`、`ptr`（物理地址或 MOB + 偏移）、`offset`、`dxContext`。
- 设备写回的状态：`COMPLETED`、`QUEUE_FULL`、`COMMAND_ERROR`（同时写 `errorOffset`）、`CB_HEADER_ERROR`、`PREEMPTED`、`SUBMISSION_ERROR`、`PARTIAL_COMPLETE`。
- 设备上下文命令：启停上下文、抢占；`CMD_BUFFERS_2` 还有队列启动、异步停止、清空。`CMD_PREPEND_*` 指定的前置命令要在每个缓冲区之前执行。
- 精确的布局和枚举值以 `svga_reg.h` 为准。上面列名称只是为了说明范围。

### 5.7 中断

- 中断标志：`ANY_FENCE`、`FIFO_PROGRESS`、`FENCE_GOAL`、`COMMAND_BUFFER`、`ERROR`、`REG_FENCE_GOAL`。
- 清除方式：写 1 清除，通过 I/O 端口 `IRQSTATUS` 或寄存器 `IRQ_STATUS`。
- 电平触发：只要 `(status & IRQMASK) != 0`，INTx 就保持有效。

### 5.8 VGPU9（旧式 3D）→ D9WG

| SVGA3D 命令 | 翻译成 |
| --- | --- |
| `SURFACE_DEFINE(_V2)` | 记下格式、面、mip 尺寸和 hint。GPU 资源在第一次使用时才创建：按用途选 `CREATE_TEXTURE_2D/CUBE/VOLUME`、`CREATE_BUFFER` 或深度表面。缓冲格式的表面可能同时被当作顶点缓冲和索引缓冲 |
| `SURFACE_DESTROY` | `DESTROY_RESOURCE` |
| `SURFACE_DMA` | 方向是到宿主机时：CPU 侧从 GMR 读出数据，封进 `UPDATE_TEXTURE`/`UPDATE_BUFFER`。方向是到客户机时：`READBACK_SURFACE`，结果用 `write` 消息回写，之后的 fence 等它完成。`DISCARD`/`UNSYNCHRONIZED` 标志照章处理 |
| `SURFACE_COPY`、`SURFACE_STRETCHBLT` | `STRETCH_RECT` 或拷贝 |
| `CONTEXT_DEFINE/DESTROY` | 整个设备只用一个 D9WG 设备，SVGA 层为每个上下文维护完整的状态影子。切换上下文时只下发有差异的状态 |
| `SETTRANSFORM`、`SETZRANGE`、`SETMATERIAL`、`SETLIGHTDATA`、`SETLIGHTENABLED`、`SETCLIPPLANE` | 对应的 D9WG 固定管线命令 |
| `SETRENDERSTATE` | `SVGA3dRenderStateName` 到 `D3DRENDERSTATETYPE` 的映射表，由生成器从头文件生成 |
| `SETTEXTURESTATE` | 拆成 `SET_TEXTURE`、`SET_SAMPLER_STATE`、`SET_TEXTURE_STAGE_STATE` |
| `SETRENDERTARGET` | `SET_RENDER_TARGET`（COLOR0–3）、`SET_DEPTH_STENCIL_SURFACE_LEVEL`（surface + face + mip） |
| `SETVIEWPORT`、`SETSCISSORRECT`、`CLEAR` | 同名命令 |
| `SHADER_DEFINE/DESTROY`、`SET_SHADER`、`SET_SHADER_CONST` | `CREATE_VERTEX/PIXEL_SHADER`（D3D9 字节码直接透传）、`SET_*_SHADER`、`SET_*_CONSTANT_F/I/B` |
| `DRAW_PRIMITIVES` | 顶点声明数组（surface + 偏移 + 步长 + 用途）转成缓存起来的 `CREATE_VERTEX_DECLARATION`、`SET_STREAM_SOURCE(_FREQ)`、`SET_INDICES` 和绘制；`SVGA3dPrimitiveRange` 带索引宽度和 bias |
| `BEGIN/END/WAIT_FOR_QUERY` | `CREATE_QUERY` 加异步结果；`SVGA3dQueryResult` 写回 GMR |
| `PRESENT`、`PRESENT_READBACK`、`BLIT_SURFACE_TO_SCREEN` | 目标是 GPU 扫描输出的，交给合成器；目标是 VRAM/GMR 后备的，回读后写入 |
| `GENERATE_MIPMAPS`、`ACTIVATE/DEACTIVATE_SURFACE`、`SCREEN_DMA` | `GENERATE_MIPS`；ACTIVATE/DEACTIVATE 只是 hint；`SCREEN_DMA` 是屏幕和 GMR 之间的拷贝 |

- 旧式 3D 能力记录写在 FIFO 的 `3D_CAPS` 区：`SVGA3dCapsRecordHeader` 后面跟 (索引, 值) 对。
- 3DMark06 需要的能力：
  - VS/PS 3.0，4 个 MRT；
  - `A16B16G16R16F` 可混合、可过滤；`R32F`；
  - 硬件阴影图格式（`Z_D24S8_INT`、`Z_DF24` 等）；
  - VS 纹理采样所需的格式。

  D9WG 执行器都已支持，这里只需把它的能力如实映射成 SVGA devcap。

实现时定下的做法（2026-10-01，`svga3d.js`、`svga3d_tables.js`、`svga3d_d9wg.js`，渲染侧 `svga_renderer.js`）：

- **每个 SVGA3D 上下文对应一个 D9WG 设备。** 执行器本来就按设备保存完整的 D3D9 状态，表面、着色器和顶点声明是各设备共用的资源。所以 CPU 侧不必为切换上下文维护状态影子。`CONTEXT_DEFINE` 每次都分配新的设备句柄，得到干净的默认状态。
- **缓冲表面按用途建 D9WG 资源。** `SVGA3D_BUFFER` 表面在第一次被绘制用作顶点缓冲、16 位或 32 位索引缓冲时，才建对应的 D9WG 缓冲。CPU 侧保留它的字节（缓冲只经 `SURFACE_DMA` 改变），新建的用途可以直接装满，`SURFACE_DMA` 回读到客户机也不用经过 GPU。
- **画面经回读回到设备（暂代 4.5 节的 GPU 扫描输出）。** `PRESENT` 和 `BLIT_SURFACE_TO_SCREEN` 都回读源表面的对应行，由设备按格式转换、缩放、裁剪后写进 Screen Object 的画面，没有 Screen Object 时写进寄存器模式的帧缓冲。光标、截图、存档、`BLIT_SCREEN_TO_GMRFB` 因此都和 2D 等级一样工作。代价是每次呈现多一次回读。合成器直接显示 GPU 纹理的做法留到性能需要时再做。
- **完成顺序。** `SVGA_CMD_FENCE` 和命令缓冲区的完成状态，排在它之前送出的所有批次之后（`after_work`）。渲染器跑完一个批次、送回它的所有写入之后，才发 `done`。所以驱动在 fence 或命令缓冲区完成之后，一定能读到回读的数据和查询结果。
- **语义差异的换算**：`CULLMODE`（剔除哪一面）加 `FRONTWINDING`（哪种绕序是正面）合成 D3D9 的剔除绕序；`ALPHAREF` 是 0–1 的浮点数；`OUTPUTGAMMA`、纹理的 `GAMMA` 为 2.2 时表示 sRGB；纹理参数里 SVGA3D 的 `ALPHA`/`ONE_MINUS` 位对应 D3D 的 `ALPHAREPLICATE`/`COMPLEMENT`，位置正好相反；`SVGA3D_BLENDOP_BLENDFACTOR` 是 D3D 的 14；D3D9 的 `SetRenderTarget` 会重置视口和裁剪矩形，SVGA3D 不会，所以换 0 号目标后重新下发两者。

### 5.9 GB 对象

| 组 | 命令 / 机制 | 要点 |
| --- | --- | --- |
| OTable | `SET_OTABLE_BASE(64)`、`READBACK_OTABLE`、`GROW_OTABLE` | 表类型：MOB、SURFACE、CONTEXT、SHADER、SCREENTARGET、DXCONTEXT。表项在客户机内存里，设备按需读写 |
| MOB | `DEFINE_GB_MOB(64)`、`REDEFINE_GB_MOB64`、`DESTROY_GB_MOB`、`UPDATE_GB_MOB_MAPPING` | 页表格式：`PTDEPTH_0/1/2` 及其 64 位变体、`RANGE` |
| GB 表面 | `DEFINE_GB_SURFACE`（V2/V3/V4：数组大小、多重采样、bufferByteStride、minLOD）、`DESTROY`、`BIND`、`COND_BIND`、`UPDATE_GB_IMAGE/SURFACE`、`READBACK_GB_IMAGE/SURFACE`（含 partial）、`INVALIDATE_*`、`BIND_GB_SURFACE_WITH_PITCH`、`INTRA_SURFACE_COPY`、`WHOLE_SURFACE_COPY`、`WRITE_ZERO_SURFACE`、`UPDATE_ZERO_SURFACE` | 表面的权威副本在"宿主机"和"MOB"之间切换：UPDATE 从 MOB 读入，READBACK 写回 MOB，INVALIDATE 丢弃 |
| GB 上下文 | `DEFINE/DESTROY/BIND/READBACK/INVALIDATE_GB_CONTEXT` | 上下文 MOB 用我们自己的格式保存 VGPU9 状态影子，存档也用它（4.7） |
| GB 着色器 | `DEFINE/DESTROY/BIND_GB_SHADER`、`SET_GB_SHADERCONSTS_INLINE` | 字节码在 MOB 里 |
| Screen Target | `DEFINE/DESTROY/BIND/UPDATE_GB_SCREENTARGET`（含 `_V2`、`_MOVE`） | GB 表面直接作为 GPU 扫描输出 |
| 查询和 fence | `BEGIN/END/WAIT_FOR_GB_QUERY`、`GB_MOB_FENCE`、`DX_MOB_FENCE_64` | 结果和 fence 值写进 MOB |
| 新式 VGPU9 绘制 | `SET_VERTEX_STREAMS`、`SET_VERTEX_DECLS`、`SET_VERTEX_DIVISORS`、`DRAW`、`DRAW_INDEXED` | 仍然翻译到 D9WG |
| 光标 MOB | `CAP2_CURSOR_MOB`：`CURSOR_MOBID` 等寄存器 | 送到光标平面 |
| GART | `ENABLE/DISABLE_GART`、`MAP_MOB_INTO_GART`、`UNMAP_GART_RANGE` | A0 确认现行驱动是否还会发这几条命令；不会发就回 `COMMAND_ERROR` |

### 5.10 DX（VGPU10 / SM4.1 / SM5）

| 组 | 命令 | 后端 |
| --- | --- | --- |
| 上下文和 COTable | `DX_DEFINE/DESTROY/BIND/READBACK/INVALIDATE_CONTEXT`、`DX_SET_COTABLE`、`DX_READBACK_COTABLE`、`DX_GROW_COTABLE`、`DX_COPY_COTABLE_INTO_MOB` | COTable 类型：RTV、DSV、SRV、元素布局、blend、depth-stencil、rasterizer、sampler、streamout、query、shader、UAV。对象定义以客户机内存里的 COTable 为准 |
| 视图和状态对象 | `DX_DEFINE/DESTROY_*_VIEW`（含 `DEPTHSTENCIL_VIEW_V2`、`UA_VIEW`）、`DX_DEFINE/DESTROY_*_STATE`（含 `RASTERIZER_STATE_V2`）、`DX_DEFINE/DESTROY_ELEMENTLAYOUT` | GX |
| 着色器 | `DX_DEFINE/DESTROY/BIND_SHADER`、`DX_BIND_ALL_SHADER`、`DX_COND_BIND_ALL_SHADER`、`DX_SET_SHADER`、`DX_SET_SHADER_IFACE`、`DX_BIND_SHADER_IFACE` | VGPU10 token → IR → WGSL。SM5 的类链接（interface）在编译期展开成 switch |
| 流输出 | `DX_DEFINE/DESTROY_STREAMOUTPUT(_WITH_MOB)`、`DX_SET/BIND_STREAMOUTPUT`、`DX_SET_SOTARGETS` | GX 模拟（G-02） |
| 绑定 | `DX_SET_SINGLE_CONSTANT_BUFFER`、`DX_SET_*_CONSTANT_BUFFER_OFFSET`、`DX_SET_SHADER_RESOURCES`、`DX_SET_SAMPLERS`、`DX_SET_INPUT_LAYOUT`、`DX_SET_VERTEX_BUFFERS`（含 V2、OFFSET_AND_SIZE）、`DX_SET_INDEX_BUFFER`（同上）、`DX_SET_TOPOLOGY`、`DX_SET_RENDERTARGETS`、`DX_SET_*_STATE`、`DX_SET_VIEWPORTS`、`DX_SET_SCISSORRECTS`、`DX_SET_UA_VIEWS`、`DX_SET_CS_UA_VIEWS`、`DX_SET_MIN_LOD` | GX |
| 绘制和计算 | `DX_DRAW`、`_INDEXED`、`_INSTANCED`、`_INDEXED_INSTANCED`、`_AUTO`、`_INSTANCED_INDIRECT`、`_INDEXED_INSTANCED_INDIRECT`、`DX_DISPATCH(_INDIRECT)` | GX |
| 清除和拷贝 | `DX_CLEAR_RENDERTARGET/DEPTHSTENCIL_VIEW`、`DX_CLEAR_UA_VIEW_UINT/FLOAT`、`DX_PRED_COPY(_REGION)`、`DX_BUFFER_COPY`、`DX_TRANSFER_FROM/TO_BUFFER`、`DX_PRED_TRANSFER_FROM_BUFFER`、`DX_SURFACE_COPY_AND_READBACK`、`DX_RESOLVE_COPY`、`DX_PRED_RESOLVE_COPY`、`DX_PRED_CONVERT(_REGION)`、各种 `STAGING_*` 拷贝和转换、`DX_BUFFER_UPDATE`、`DX_UPDATE/READBACK/INVALIDATE_SUBRESOURCE`、`DX_GENMIPS`、`DX_PRESENTBLT`、`SCREEN_COPY`、`SURFACE_STRETCHBLT_NON_MS_TO_MS` | GX；格式转换用计算着色器 |
| 查询和条件渲染 | `DX_DEFINE/DESTROY/BIND_QUERY`、`DX_SET_QUERY_OFFSET`、`DX_BEGIN/END_QUERY`、`DX_READBACK_QUERY`、`DX_MOVE_QUERY`、`DX_BIND_ALL_QUERY`、`DX_READBACK_ALL_QUERY`、`DX_SET_PREDICATION` | GX（G-13、G-14） |
| UAV 计数 | `DX_COPY_STRUCTURE_COUNT`、`DX_SET_STRUCTURE_COUNT` | 存储缓冲旁边附带一个计数器缓冲 |
| GDI 加速 | `LOGICOPS_BITBLT`、`TRANSBLT`、`STRETCHBLT`、`COLORFILL`、`ALPHABLEND`、`CLEARTYPEBLEND` | 用计算着色器实现 ROP3 和混合（G-05）。WDDM 的 GDI 硬件加速用这组命令 |
| 杂项 | `DX_HINT` | 忽略 |

着色器前端要覆盖 SM4/SM4.1/SM5 的全部操作码，包括：

- 可索引临时寄存器、相对寻址、整数和位运算；
- coarse/fine 导数；
- `gather4` 系列（带可编程偏移的版本需要模拟，因为 WGSL 的偏移只能是常量）；
- `ld2dms`、`resinfo`、`bufinfo`、`sample_*` 全系列；
- `eval_*`（近似，G-18）；
- UAV 的 load/store/原子操作，`sync`；
- GS 的 `emit`/`cut`（含 stream 版本）；
- HS 的 phase 结构；
- SV 语义的映射。

### 5.11 DevCap 和格式

- **DevCap**：A0 根据驱动的需求，给每个等级填好 0–261 的全部条目（附录 A）。DX 等级的 `DXFMT_*` 每个格式都按 `SUPPORTED`、`SHADER_SAMPLE`、`COLOR_RENDERTARGET`、`DEPTH_RENDERTARGET`、`BLENDABLE`、`MIPS`、`ARRAY`、`VOLUME`、`DX_VERTEX_BUFFER`、`MULTISAMPLE` 逐位核对 GX 是否真有实现。
- **格式映射**（`svga_formats.js`，VGPU9 和 DX 共用）：
  - `SVGA3dSurfaceFormat` 一一对应 WebGPU 格式。
  - WebGPU 没有的格式在上传和回读时转换：16 位紧缩格式（565/1555/4444）、L8/A8L8/ALPHA8（另加着色器 swizzle）、X8 系列、视频格式 YUY2/UYVY/NV12/YV12。
  - BC1–7 需要 `texture-compression-bc`，这是 DX 等级的硬性要求。

### 5.12 Escape 和 backdoor

- `SVGA_CMD_ESCAPE` 里的视频叠加（`SVGA_ESCAPE_VMWARE_VIDEO_*`、`SVGA_FIFO_CAP_VIDEO`）在 S8 实现：YUV 转换后叠加到扫描输出上。
- backdoor：v86 已经有 GETVERSION。A0 的静态分析如果发现驱动依赖其他 backdoor 命令（比如 GETHWVERSION 或 RPCI），就补最小子集。自动调整分辨率（宿主机通过 GuestRPC 发 `Resolution_Set`）属于 Tools 服务，不是驱动的功能，放到 S8 评估。

## 6. virtio-gpu 设计

### 6.1 PCI：virtio-vga 布局，以及 virtio.js 的改造

| BAR | 内容 |
| --- | --- |
| BAR0 | 内存，prefetchable：VRAM。这是 VGA 核心的 LFB，也是 viogpudo 的帧缓冲段（第 2 节已核实它读 BAR0） |
| BAR1 | I/O：common、notify、ISR、device 四个 capability 共用这一个 BAR，按偏移区分 |
| BAR2 | 内存：host-visible 共享内存区（`SHARED_MEMORY_CFG`，shmid 1）。只有开了 blob 的 HOST3D 才有（V5） |

- 设备整体是 class `0300` 的 VGA 设备，所以 Windows 把它当成开机显示设备，viogpudo 会接管 Basic Display，不会多出第二块显卡。
- 如果做成独立的非 VGA 功能，Windows 会把它当成第二台显示器。

`virtio.js` 要做的改造：

- 每个 capability 可以指定 BAR 号和偏移，也可以几个共用一个 BAR；
- class code 和 revision 可配置；
- BAR0 可以由宿主设备（VGA 核心）占用；
- 新增共享内存 capability（cap64 格式的偏移和长度）；
- 现有设备的端口布局保持不变（`virtio_net` 等仍用旧的默认值），保证旧存档能恢复。

### 6.2 2D

| 命令 | 实现 |
| --- | --- |
| `GET_DISPLAY_INFO`、`GET_EDID` | 根据配置和宿主窗口大小生成 EDID：首选模式加标准时序，带校验和 |
| `RESOURCE_CREATE_2D`、`RESOURCE_UNREF`、`RESOURCE_ATTACH_BACKING`、`RESOURCE_DETACH_BACKING` | CPU 侧维护资源表和 backing 页表 |
| `TRANSFER_TO_HOST_2D`、`RESOURCE_FLUSH`、`SET_SCANOUT` | 从 backing 拷到资源，flush 时送到扫描输出（`put_pixels`） |
| `RESOURCE_ASSIGN_UUID` | 分配 UUID 并记住 |
| `RESOURCE_CREATE_BLOB`（`BLOB_MEM_GUEST`）、`SET_SCANOUT_BLOB` | V2 |
| 光标队列：`UPDATE_CURSOR`、`MOVE_CURSOR` | 光标平面 |
| `VIRTIO_GPU_EVENT_DISPLAY` | 浏览器窗口改变大小时通知客户机，客户机重新读显示信息。viogpudo 和 Linux 都支持，这是 virtio-gpu 相对 SVGA 的一个优点 |

多屏最多支持 `scanouts` 个（默认 1，上限 16），按 4.5 节拼接。

### 6.3 3D：virgl

- **capset**：`VIRGL`（1）和 `VIRGL2`（2）。能力结构 `virgl_caps_v2` 逐位填写：每个 bset 位、每个 `capability_bits(_v2)` 位、格式位图、各种上限，都对照 `virgl_hw.h` 注明"实现 / 模拟（G-xx）/ 不声明"。GL 版本跟着这些能力一起往上走。
- **命令**：`CTX_CREATE/DESTROY`、`CTX_ATTACH/DETACH_RESOURCE`、`RESOURCE_CREATE_3D`、`TRANSFER_TO_HOST_3D`、`TRANSFER_FROM_HOST_3D`、`SUBMIT_3D`。
- **virgl 命令流**（`virgl_protocol.h`）覆盖：
  - 创建、绑定、销毁对象：blend、rasterizer、DSA、shader（TGSI 文本）、vertex elements、sampler view、sampler state、surface、query、streamout target、MSAA surface；
  - framebuffer、viewport、scissor、clip、stipple、sample mask、min samples、blend color、stencil ref；
  - 常量缓冲、UBO、SSBO、image、atomic buffer、sampler view；
  - 顶点缓冲、索引缓冲；
  - `DRAW_VBO`，含 indirect、多重间接、count-from-SO；
  - clear、`CLEAR_TEXTURE`、blit、`RESOURCE_COPY_REGION`；
  - 查询及 `GET_QUERY_RESULT(_QBO)`、`SET_RENDER_CONDITION`；
  - streamout、sub context、细分状态、`LAUNCH_GRID`、memory/texture barrier；
  - 带内传输：`TRANSFER3D`、`COPY_TRANSFER3D`、`END_TRANSFERS`；
  - debug flags 和 string marker。
- 后端是 GX，前端是 `tgsi_frontend.js`。GL 和 D3D 的差别在 GX 的变换遍里处理：provoking vertex（G-17）、深度范围、窗口原点（`fragment_coord_conventions`）、clip half-z。

### 6.4 blob 和共享内存

- **`BLOB_MEM_GUEST`**（V2）：资源的存储就是客户机内存，不需要 BAR。
- **`BLOB_MEM_HOST3D`**（V5）：`RESOURCE_MAP_BLOB` 把宿主机资源映射进 BAR2。BAR2 是 mmio_ram 里一块普通内存。
  - 一致性的做法：每次 submit 之前，把脏页位图里标记的页上传到对应的 GPU 缓冲；GPU 写过的范围在 fence 完成后下载回来。
  - 位图本来就在 mmio_ram 里，客户机写入不需要拦截。
  - 这样能满足 `ARB_buffer_storage` 的 persistent/coherent 映射。以后如果做 Venus，它要求的 host-visible 内存语义（coherent 内存在 submit 时可见）也能满足。
- **`BLOB_MEM_HOST3D_GUEST`**：同上，额外保留客户机副本。

### 6.5 Venus（暂缓，D6）

本节只保留可行性分析，不在本轮排期里。

- Venus 把 Vulkan 调用序列化（`venus-protocol`），宿主机必须有一个 Vulkan 实现。这里等于要在 WebGPU 上用 JS 写一个 Vulkan 驱动。
- 可行的原因是 Vulkan 允许驱动声明不支持某些特性（`geometryShader`、`tessellationShader` 等都可以报 false），而 Vulkan 1.0 的核心特性大多能对上 WebGPU。
- 需要的东西：
  - SPIR-V 前端；
  - push constant 模拟；
  - 子通道拆成多个 render pass；
  - 描述符集映射成 bind group；
  - 二级命令缓冲录制后回放；
  - HOST3D 内存（6.4）。
- 规模是整个计划里最大的单项（量级 20k 行以上）。以后重新考虑时，建议先在 GX 和 virgl 完成之后做 `vulkaninfo`、`vkcube` 的原型，再决定是否继续。

### 6.6 Windows 8.1 上的 virtio-gpu

- **2D**：用 viogpudo（来自 U3 确定的 virtio-win 版本），客户机侧不用写代码。用到的功能：EDID、光标、自定义分辨率（Escape 加 viogpuap/viogpusrv）、宿主机触发的分辨率变化事件。
- **3D 暂缓（D1）。** 以后重新考虑时有两条路，记录如下：
  - **走 v86gl 图形代理**（原 V6）：
    - 把 `v86gl.sys` 移植到 x64。它是 WDM 驱动，mingw 能编译。IOCTL 结构需要做 WOW64 转换（`IoIs32bitProcess`）。
    - 现有的 32 位 `d3d9.dll`/`d3d8.dll`/`ddraw.dll`/`opengl32.dll` 在 WOW64 下继续使用。3DMark06 是 32 位程序，正好适用。
    - 驱动需要测试签名：客户机里执行 `bcdedit /set testsigning on`，宿主机要装 `osslsigncode`。
    - 量级：2k 行 C，外加测试签名流程。
  - **自己写原生 WDDM 3D 驱动**（原 V8）：完整的 WDDM 1.3 内核驱动，外加 D3D9/D3D10/11 的用户态驱动，命令用 virgl 或 D9WG。成本：
    - 本机 mingw 没有 WDDM 头文件，要么手写这些声明，要么在 Windows 上用 WDK/MSVC 构建；
    - 全功能 WDDM 驱动的 VidMm、分页和抢占都非常难调试。

  在这之前，Windows 上需要 3D 就用 SVGA II。

  所以 Windows 的完整 3D 建议用 SVGA II。

## 7. WebGPU 映射与偏差登记

| 编号 | 主题 | 处理 |
| --- | --- | --- |
| G-01 | 几何着色器 | 计算着色器模拟；输出顶点数按 `maxvertexcount` 预留空间，溢出的部分丢弃并记日志 |
| G-02 | 流输出、`DrawAuto` | 复用 G-01 的捕获缓冲，配合计数器 |
| G-03 | 曲面细分（HS/DS） | 计算着色器模拟，算法用微软参考细分器（Mesa 里的 MIT 副本） |
| G-04 | MSAA 采样数 | WebGPU 只有 1 和 4。不声明 2x（避免悄悄换成 4x）；8x 不声明，影响见 U5 |
| G-05 | 逻辑运算（LOGICOPS 命令、GL logic op） | 拷贝目标后用计算或片段着色器实现，速度慢 |
| G-06 | 线框/点填充，线宽或点大小大于 1 | 转成线/点列表，或展开成四边形 |
| G-07 | border/mirror-once 寻址 | 着色器里模拟寻址 |
| G-08 | 深度格式 | D24 不能逐位拷贝或回读，改用着色器读出深度；DF16/DF24/INTZ 一类映射成可采样的深度纹理 |
| G-09 | 16 位紧缩格式 | 上传和回读时转换；作为 RT 时内部用 rgba8 |
| G-10 | 分层渲染（`SV_RenderTargetArrayIndex`/`ViewportArrayIndex`） | GS 模拟的输出按层分组，逐层绘制 |
| G-11 | 纹理 UAV 的 typed load 和原子操作 | 只开放 WGSL 读写存储纹理支持的格式；原子操作改用缓冲 |
| G-12 | f64 | 不声明 |
| G-13 | pipeline statistics 查询 | CPU 能算出的项（顶点数、图元数）照实返回，其余返回近似值 |
| G-14 | 条件渲染、predication | 在 GPU 上清零间接绘制参数 |
| G-15 | 顶点输入超出 WebGPU 上限，或格式不支持（3 分量 8/16 位等） | 顶点拉取 |
| G-16 | 每个阶段的资源数（D3D10 要求 128 个 SRV） | 只绑定着色器实际用到的；超过适配器上限时报错并记录 |
| G-17 | provoking vertex（GL 默认用最后一个顶点） | 重排索引或顶点拉取 |
| G-18 | `eval_*`、sample shading | 近似 |
| G-19 | stencil export | 不声明 |
| G-20 | D3D9 的像素中心和半像素偏移 | D9WG 已经处理 |
| G-21 | 视频格式 | 计算着色器转换 |
| G-22 | 回读延迟（`mapAsync`） | 异步完成加 fence；频繁回读的小表面在 CPU 侧留影子副本 |
| G-23 | 纹理分量 swizzle | 每个绑定附带 swizzle 常量，在着色器里做 |
| G-24 | 关闭无缝立方体贴图 | WebGPU 总是无缝的，有轻微差异 |
| G-25 | sampler 的 LOD bias | 片段着色器用 `textureSampleBias`，其他阶段用显式 LOD |
| G-26 | 图元重启不可配置，triangle fan 和 quad | 改写索引；fan 转成三角形列表；quad 不在 virgl 的 `prim_mask` 里声明 |

D9WG 已有的偏差（点精灵、裁剪平面、BORDER 等）继续以 `d3d8proxy/README.md`、`d3d9proxy/README.md` 为准，本表不重复列出。

## 8. 里程碑

### 8.1 总览

| 编号 | 内容 | 依赖 | 规模量级（仅估计） |
| --- | --- | --- | --- |
| A0 | 准备和探测 | — | 工具和报告 |
| A1 | 公共基础设施，包括显示适配器插件化和 `bochs_vga` 迁出核心 | A0 | 5–6k 行，另有约 225 个文件的机械修改 |
| A2 | trace 抓取和重放 | A1 | 1–2k 行 |
| S1 | SVGA 基本 2D | A1 | 3k 行 |
| S2 | SVGA 完整 2D | S1 | 3k 行 |
| S3 | VGPU9 3D，接 D9WG；**第一次 3DMark06 验收** | S2 | 4k 行 |
| V1 | virtio-gpu 2D（Linux、Win 8.1 viogpudo） | A1 | 2k 行 |
| S4 | GB 对象、Screen Target、检查点 | S3 | 4k 行 |
| S5 | DX10：GX、VGPU10 前端、GS/SO 模拟 | S4 | 20k 行以上 |
| V3 | virgl：GL 2.1 → 3.3，GLES 2/3.0 | S5 的 GX | 8k 行 |
| S6 | DX10.1 / SM4.1 | S5 | 3k 行 |
| V4 | virgl：GL 4.3，GLES 3.1/3.2 | V3、S7 | 3k 行 |
| S7 | DX11 / SM5：计算、UAV、曲面细分 | S6 | 8k 行 |
| V2 | blob（GUEST）、`SET_SCANOUT_BLOB`、`CONTEXT_INIT` | V1 | 1k 行 |
| V5 | HOST3D blob 和共享内存 BAR | V3 | 2k 行 |
| S8 | 收尾：性能、视频叠加、多屏界面、可选的 XP | S7 | — |

推荐顺序：A0 → A1 → A2 → S1 → S2 → **S3（3DMark06）** → V1 → S4 → S5 → V3 → S6 → S7 → V4 → V2 → V5 → S8。

V1 和 S3 可以并行。S5 是最大的一项，GX 定型后 V3 才能开始。

暂缓、不在本轮排期里的：原 V6（Windows virtio-gpu 3D，走代理）、原 V7（Venus）、原 V8（Windows 原生 WDDM 3D 驱动）。见 D1、D6，以及 6.5、6.6 节。

### 8.2 各里程碑的内容和完成标准

**A0 准备和探测**

内容：

- 把头文件放进 `third_party/`，写常量生成器。
- 获取 VMware Tools：13.1.5 x64，外加一个旧版本（比如 10.3.x）用于 VGPU9 等级的对照。解出 `vm3d.inf` 和驱动文件（例如 `vm3dmp*.sys`、`vm3dum*.dll`，以实际包内文件为准），然后做静态分析：
  - 用 objdump 看导入表和字符串；
  - 找 `SVGA_REG_CAPABILITIES`/`DEV_CAP` 相关的比较；
  - 找 backdoor 魔数 `0x564D5868`；
  - 读 INF 里的硬件 ID。
  据此回答 U1，并推出每个等级的最小能力集合。
- 找到带 `viogpudo\w8.1` 的 virtio-win 版本（U3）。
- 准备 Alpine GPU 测试盘：`mesa-dri-gallium`、`mesa-utils`、`mesa-demos`、`kmscube`、`glmark2`、`weston`。
- 准备 Windows 镜像：用 APFS 克隆出可写副本（原镜像保持只读），检查 KB2919355（U4），写好 TDR 注册表项，把驱动包预装进驱动库（第 10 节）。

完成标准：

- 本文附录 A 填好各等级的能力表；
- U1–U4 都有结论；
- 两个测试盘可用。

**A1 公共基础设施**

内容：

- `pci.js`：prefetchable 位，多个内存 BAR，大 BAR。
- `mmio_ram`：非像素区域，原子读写辅助函数。
- `virtio.js`：按 6.1 节改造。
- 显示适配器插件化（4.8 节），排在 S1 之前，这样 SVGA 和 virtio-gpu 一开始就按插件写：
  - `src/graphics_adapter.js`：注册表、加载器、`machine` 接口和 externs；
  - 把 `vga.js` 拆成 `vga_core.js` 和 `bochs_vga.js`，移出核心，构建成 `build/v86-bochs-vga.js`；
  - `cpu.js` 改为通过插件创建适配器；`state[52]` 加适配器名字，兼容旧存档；`devices.vga` 保留为别名；
  - CPU worker 和并行模式下的插件加载；
  - Makefile 增加三个插件的构建目标。
- `graphics_adapter` 改为必填，`vga_memory_size` 改名为 `vram_size`：用同一个脚本给约 225 个构造 `V86` 的文件补上 `graphics_adapter: "bochs_vga"`，并把 41 个文件里的 `vga_memory_size` 改名；界面下拉框和 `main.js` 预设默认选 `bochs_vga`。
- retro-gaming-site 本轮不改（2026-10-01 决定）。它自带一份旧版 `vendor/v86`，现在不受影响。等它升级到新的 v86 时，再一起补 `graphics_adapter`、把 `vga_memory_size` 改名为 `vram_size`、带上插件文件和 BIOS 变体，和图形代理插件化的第 4 阶段一起做。
- 自动选择等级和特性位，把结果写进存档；测试专用的内部选项可以固定等级。
- VGA BIOS 的 PCI ID 改写（`patch_vga_bios_ids`），代替单独构建 `vgabios-vmware.bin`、`vgabios-virtio.bin`。
- DisplayHub/合成器：GPU 扫描输出、光标平面、多屏。
- `gpu_channel.js`，在主线程、CPU worker 和并行三种模式下都能工作。
- 检查点框架（`prepare_save`/`after_restore`）。

完成标准：

- `bochs_vga` 作为插件加载后，现有测试全部通过，覆盖主线程、CPU worker 和并行三种模式：`make display-browser-tests`、`tests/devices/display.js`、`mmio_ram.js`、`frame_buffer.mjs`、`tests/api/state.js`、Win 8.1 和 Win 9x 的启动测试、virtio-net/9p 的旧存档恢复；
- 插件化之前抓的旧存档（包括 `~/Downloads/3dmark06.bin`）能恢复，并且画面正确；
- 不写 `graphics_adapter` 时报错，写了不认识的值也报错，错误信息列出可用的值；
- 插件文件缺失时报出明确的错误（写明缺哪个文件、在哪里找过）；
- 新增的通道测试在 worker 模式下通过。

**A2 trace 抓取和重放**

- CPU 侧可以选择把每个批次，连同它引用的客户机数据，写进 trace 文件。
- 重放器在浏览器测试框架里把 trace 直接喂给渲染器，逐帧截图，同时收集 WGSL。
- 有了它，修宿主机渲染器时不用每次都启动 Windows（Win 8.1 首次启动要 4 分钟左右）。

**S1 SVGA 基本 2D（等级 `2d`）**

内容：

- PCI 和 VGA 兼容，ID 协商，模式寄存器；
- FIFO：`UPDATE`、`RECT_COPY`、`FENCE`、`DEFINE_(ALPHA_)CURSOR`、`NOP`，`ESCAPE` 先留空；
- FIFO 能力位，`TRACES`，8 位调色板，`PITCHLOCK`，基本中断；
- 寄存器访问日志，用于动态核对 A0 的结论。

完成标准：

- **Linux**：vmwgfx 加载，fbcon 能切到 1024×768 和 1280×1024，`modetest` 能设置模式，weston（pixman）能显示，光标正确。
- **Win 8.1**：设备管理器里 "VMware SVGA 3D" 正常工作（没有 Code 10/43），能列出并切换分辨率，桌面绘制正确。如果驱动没有 GMR 或命令缓冲区就拒绝加载，Windows 的这一项挪到 S2 验收。
- 存档能来回恢复。

**S2 SVGA 完整 2D（等级 `2d-full`）**

内容：GMR/GMR2，Screen Object 1/2，多屏和拓扑，命令缓冲区（CB、CB2、设备上下文、prepend、高优先级队列），完整中断，CURSOR4，`SCREENDMA`，脏跟踪，`FENCE_GOAL`。

完成标准：

- Linux 在 Screen Object 模式下运行 weston，两块虚拟屏幕；
- Win 8.1 桌面、多屏、alpha 光标正常；
- 测量桌面空闲时的 CPU 占用，作为相对 Bochs VGA 的基线。

**S3 VGPU9（等级 `vgpu9`）**

内容：5.8 节全部内容，devcap 达到 SM3.0，格式表，`PRESENT` 的几条路径，查询，存档（旧式表面由宿主机回读）。

完成标准：

- **Linux**：Mesa svga 报告 GL 2.1（`glxinfo` 的渲染器是 SVGA3D），glxgears 和 glmark2 默认场景能跑完；和客户机里 llvmpipe 的截图对比，差异在阈值以内。
- **Win 8.1**：
  - `glbridge/sample/d3d9_*_test.c` 用系统自带的 d3d9.dll 原生运行（不放代理）；
  - dxdiag 显示 DirectDraw、Direct3D 和 AGP 纹理加速均已启用，功能级别符合预期（Vista 以后的 dxdiag 已经没有渲染测试按钮）；
  - DWM 由 GPU 合成；
  - **3DMark06 完整跑完**：所有测试都完成，截图和参考图在阈值以内，没有 `ERROR` 中断，没有 WebGPU 验证错误，测试中途存档再恢复能继续跑；
  - 记录 fps 和总分，和 XP 加代理的基线对比。
- **冻结设备 ABI**（PCI 身份、BAR 大小、`vgpu9` 能力表），在第 13 节标注。用户之后才能抓 3DMark06 状态。

**V1 virtio-gpu 2D**

内容：virtio-vga，控制队列和光标队列，6.2 节全部命令，EDID，UUID，显示事件，多 scanout。

完成标准：

- Linux：virtio_gpu 的 KMS 下 fbcon 和 weston 正常，拖动浏览器窗口能实时改变分辨率；
- Win 8.1：viogpudo 加载，分辨率来自 EDID，光标正常，自定义分辨率可用；
- 存档能来回恢复。

**S4 GB 对象（等级 `gb9`）**

内容：5.9 节全部内容，检查点改为 MOB 写回。

完成标准：

- Linux 的 vmwgfx 使用 Screen Target 和 GB 对象；
- Win 驱动进入 GB 模式后，3DMark06 再跑一遍；
- 测量存档的大小和耗时。

**S5 DX10（等级 `dx10`）**

内容：

- GX 核心，着色器 IR，WGSL 生成器，VGPU10 前端（SM4.0）；
- GS 和 SO 模拟，MSAA 4x，查询和条件渲染；
- 5.10 节里除 SM5 专用以外的全部命令，`DXFMT` 能力表。

完成标准：

- Linux 上 Mesa svga 报告 GL 3.3，glmark2 全部场景能跑完；
- Win 8.1 上自己写的 D3D10 FL10_0 示例（mingw 构建，着色器在客户机里用 `d3dcompiler_47` 编译）通过，并和客户机里 WARP 的输出对比；
- U2 在这里得到结论：3DMark06 在 `dx10` 等级下也必须能跑完，不管它走 D9WG 还是 GX。

**S6 DX10.1（等级 `dx10.1`）**

内容：SM4.1、`SM41` devcap、立方体数组、per-RT blend、`gather4`、4x MSAA 的完整要求。

完成标准：Linux 上 vmwgfx 建立 SM4_1 上下文，Mesa 提供 SM4.1 对应的 GL 扩展并开启 MSAA；Win 8.1 上 FL10_1 示例通过。

（原来写的"Linux 上 GL 4.1"不对：Mesa 的 svga 驱动要 SM5 才报告 GL 4.x，SM4.1 下仍是 GL 3.3，只多出 `ARB_texture_cube_map_array`、`ARB_texture_gather`、`ARB_draw_buffers_blend`、`ARB_sample_shading`、`ARB_texture_query_lod`，而且 Mesa 只在 SM4.1 下才开 MSAA。GL 4.1 归到 S7。）

**S7 DX11（等级 `dx11`）**

内容：SM5，`SM5` devcap，`DX3` 等 CAP2；计算着色器，UAV，结构化/原始缓冲，追加/消耗缓冲，原子操作，间接绘制和调度，曲面细分模拟，GS 实例化和多 stream，LOGICOPS。

完成标准：

- Linux 上 GL 4.3；
- Win 8.1 上 FL11_0 示例通过（U5 决定 8x MSAA 的处理）；
- 扩展目标：Unigine Heaven（DX11）或 3DMark 11。

**V3 / V4 virgl**

- V3 完成标准：Linux 的 `glxinfo` 显示 virgl 渲染器，报告 GL 3.3 和 GLES 3.0；glmark2、kmscube、es2gears 能跑；和 llvmpipe 的截图对比在阈值以内。
- V4 完成标准：GL 4.3、GLES 3.2；计算着色器和 SSBO 的测试通过。

**V2 / V5 blob**

- V2：`BLOB_MEM_GUEST`、`SET_SCANOUT_BLOB`、`CONTEXT_INIT`（按 ring 排序的 fence）。
- V5：`BLOB_MEM_HOST3D` 加共享内存 BAR。完成标准：`ARB_buffer_storage` 的 coherent 映射测试通过；测量性能。

**S8 收尾**

内容：

- 性能：pipeline 缓存预热，减少回读，合并批次；
- 视频叠加；
- 多屏界面；
- backdoor 的分辨率自动调整（看评估结果）；
- 可选的 XP 驱动验收；
- 文档：本文浓缩成英文的设计文档 `docs/gpu-devices.md`，偏差表单独放。

## 9. 测试与验收

| 层次 | 内容 | 位置 |
| --- | --- | --- |
| 设备单元测试 | 寄存器语义；FIFO 回绕和 `RESERVE`；GMR 描述符链；MOB 页表各种深度，包括 4 GiB 以上；CB 的状态和错误偏移；中断电平；virtio 队列；EDID 校验和；显示事件 | `tests/devices/vmware_svga.js`、`virtio_gpu.js`（node） |
| 着色器 | DXBC/VGPU10 和 TGSI 语料库，从 Linux 和 Windows 实际运行中抓取。全部经过 naga 验证；整数、位运算、控制流用计算着色器执行对比，检查数值结果 | `tests/gpu/shaders/` |
| trace 重放 | A2 的 trace 在浏览器测试框架里重放，逐帧和基准截图比较 | `tests/gpu/traces/`；大文件不进仓库，记录下载位置 |
| Linux 客户机 | `tests/x64/linux_gpu.mjs`，参数选择 SVGA 或 virtio。跑 `glxinfo`、kmscube N 帧、glmark2 子集；参考图来自同一客户机里的 llvmpipe（`LIBGL_ALWAYS_SOFTWARE=1`） | `make linux-gpu-tests` |
| Windows 客户机 | `tests/x64/windows_gpu.mjs`，从用户提供的状态启动，执行脚本化程序，截图，检查 SVGA 错误计数和 WebGPU 验证错误 | `make windows-gpu-tests`（需要本地镜像） |
| 性能 | 3DMark06 各项 fps 和总分；桌面空闲 CPU；DWM 帧时间；对照组是 Bochs VGA 加代理 | 记录到 `docs/cpu-benchmarks.md` 的同类表格 |

参考图来源：

- Linux：客户机里的 llvmpipe。
- D3D10/11 示例：客户机里的 WARP（`D3D_DRIVER_TYPE_WARP`）。
- 3DMark06：同一状态先在 XP 加 D9WG 代理的路径上截一次作为基准，此后基准冻结。Advanced 和 Pro 版有逐帧的 Image Quality 工具，如果用户的版本有，就用它取固定帧。

## 10. 3DMark06 测试状态准备

### 10.1 现在就可以做（只改磁盘内容，和设备无关）

1. 用 APFS 克隆一份可写镜像，例如 `cp -c windows8.img windows8-gpu.img`。原镜像保持只读，`windows_boot.mjs` 会检查它的 mtime。
2. 在 QEMU 或 v86 里启动这份副本，然后：
   - 确认装了 KB2919355（`winver` 显示 9600.17031 及以上）；
   - 安装 DirectX 9.0c 运行时（June 2010 redist），3DMark06 需要 d3dx9；
   - 安装 3DMark06，记下版本号（Basic/Advanced/Pro）。
3. 设置注册表 `HKLM\System\CurrentControlSet\Control\GraphicsDrivers`：`TdrDelay=60`、`TdrDdiDelay=60`（DWORD）。
4. 设置自动登录，免得每次都要自动输入密码。
5. 关掉 Windows Update、Defender 的计划扫描、Search 索引，以及 SPP 的补跑任务。这几项是空闲桌面 100% CPU 的来源，见 2026-10-01 的分析。
6. 预装驱动包（只放进驱动库）：
   - VMware Tools 13.1.5 的 SVGA 驱动：`pnputil -a vm3d.inf`；
   - virtio-win 的 viogpudo（w8.1）：`pnputil -a viogpudo.inf`。

   在 QEMU 里用 `-vga vmware` 或 `-device virtio-vga` 可以让 Windows 当场装上驱动。QEMU 的 vmware-svga 只有 2D，VMware 驱动在它上面可能报错，这没有关系，驱动包已经进了驱动库。到了 v86 里，设备实例路径不同，Windows 会重新识别设备，自动从驱动库安装。

### 10.2 S3 冻结 ABI 之后再抓

用 `graphics_adapter: "vmware_svga"` 启动 v86，`vram_size` 用 S1 定下的默认值。S3 时最高的已实现等级就是 `vgpu9`，会被自动选中，并写进存档。内存和核数自定（建议 3 GiB、1–2 核，写进文件名）。等 "VMware SVGA 3D" 工作正常，并且 DWM 已经由 GPU 合成后，抓以下状态：

| 文件 | 内容 |
| --- | --- |
| `win81_svga-vgpu9_desktop.bin` | 驱动生效后的空闲桌面，1280×1024 |
| `win81_svga-vgpu9_3dm06-menu.bin` | 3DMark06 已启动，停在主界面，还没点 Run |
| 可选 | GT1、HDR1、CPU 测试、特性测试各自开始前的状态 |

每个状态旁边放一个同名的 `.json`，记录：设备、等级、VRAM、内存、核数、驱动版本、桌面分辨率、3DMark06 版本。

### 10.3 以后还要重新抓

驱动只在启动时读一次能力位，所以每升一个等级都要重新抓：`gb9`（S4）、`dx10`（S5）、`dx11`（S7）。

virtio-gpu 在 Windows 上只有 2D（D1 暂缓），所以没有 virtio 的 3DMark06 状态。V1 之后可以抓一个 `win81_virtio_desktop.bin`（装好 viogpudo 的桌面），用于 2D 回归测试。

现有的 XP 状态 `~/Downloads/3dmark06.bin` 继续作为代理路径的参考（截图和分数），不需要改。

## 11. 风险

| 编号 | 风险 | 对策 |
| --- | --- | --- |
| R1 | VMware 的 Windows 驱动对设备的要求未知（U1/U2），而且驱动闭源 | A0 静态分析，S1 记录寄存器访问；先用开源的 Linux 驱动把设备做对 |
| R2 | 客户机驱动栈的开销（用户态驱动翻译、dxgkrnl 调度、内核驱动）都在模拟 CPU 上执行，3DMark06 的 fps 可能低于 XP 加轻量代理 | S3 起就测量；这是真实驱动栈的固有成本，主要靠宿主机侧和 CPU 模拟的效率来弥补 |
| R3 | TDR | 4.4 节的对策 |
| R4 | WebGPU 缺功能，可能达不到某个功能级别 | 第 7 节逐项登记偏差；某等级做不到就不开放这个等级，也不谎报 |
| R5 | 回读延迟导致客户机卡顿（GDI、staging） | 影子副本；尽量把读写都留在 GPU 上 |
| R6 | 存档大小和耗时（GPU 内存要写回） | 只写回脏表面；S4 测量 |
| R7 | 跨线程流量控制和死锁（客户机等 fence，渲染器在等回写） | `gpu_channel` 规定回写优先；worker 模式压力测试 |
| R8 | 许可 | 头文件选 MIT 条款；VMware Tools 和 virtio-win 的二进制不进仓库，由用户下载 |
| R9 | 多个会话同时在改 `d3d9_executor.js` 等文件 | 动手前先查 `git status` 和 mtime；先提交基线 |
| R10 | 不同浏览器、不同 GPU 的 WebGPU 能力不一样 | 等级要求的最低 WebGPU feature 写在附录 A；能力不够就拒绝这个等级 |
| R11 | `graphics_adapter` 改成必填，所有现有配置都要改，外部使用者升级后会立即报错 | 用脚本一次改完仓库里约 225 个文件；retro-gaming-site 升级 v86 时再改；错误信息直接告诉用户该写什么 |
| R12 | 插件文件在部署时漏带（retro-gaming-site 自带一份 `vendor/v86`，升级时要一起带上） | 加载失败时报出缺的文件名和查找路径（A1 已实现并有测试）；插件随每个 libv86 包一起构建，`package.json` 的 `files` 已包含 `build/v86-*.js` |
| R13 | 把 VGA 移出核心，与上游的差异变大 | 插件接口保持通用，核心仍能静态编进 `bochs_vga`（4.8 节） |

## 12. 决策

| 编号 | 问题 | 状态 | 内容 |
| --- | --- | --- | --- |
| D1 | Windows 上 virtio-gpu 的 3D | **已定：暂缓**（2026-10-01） | 代理路线和原生驱动都不在本轮排期里，记录见 6.6 节。Windows 上的 3D 用 SVGA II |
| D2 | 3DMark06 第一次验收时，SVGA 设备向驱动声明到哪一级 3D 能力 | **已定：`vgpu9`**（2026-10-01） | 见下文；A0 验证前提，不成立时 S3 与 S4 合并，改用 `gb9` |
| D3 | DXBC 和 TGSI 着色器翻译 | **已定**（2026-10-01） | 自己写 JS 的 IR 和 WGSL 生成器，和现有的 D3D9/GL 翻译器保持一致；不把 DXVK、vkd3d 加 naga 编译成 wasm 引进来 |
| D4 | 代码放在哪里 | **已定：插件**（2026-10-01） | 三种显示适配器都是插件，按 `graphics_adapter` 加载；3D 渲染在 `libv86-webgpu.js`（4.8 节） |
| D5 | 存档方式 | **已定**（2026-10-01） | 设备级检查点（4.7 节），不用日志重放 |
| D6 | Venus | **已定：暂缓**（2026-10-01） | 可行性分析保留在 6.5 节 |
| D7 | 配置细节 | **已定**（2026-10-01） | `graphics_adapter` 必填，界面和预设默认 `bochs_vga`；增加 `"none"`（无显示设备，只用串口）；插件路径选项叫 `graphics_adapter_path`，和 `wasm_path` 一致。对用户只公开 `graphics_adapter` 和 `vram_size`（取代 `vga_memory_size`）；等级和特性位自动选择并写进存档，另有测试专用的内部选项可以固定等级（4.8 节） |
| D8 | 3DMark06 的参考图 | 待确认 | XP 加代理路径截一次后冻结；有 Image Quality 工具就用固定帧 |

**D2 说明。** VMware 显卡的 3D 有几代命令集。设备声明哪一代，Windows 驱动就用哪一代：

| 等级 | 命令集 | 宿主机后端 | 离能跑 3DMark06 还差多少 |
| --- | --- | --- | --- |
| `vgpu9` | 旧式 3D：表面、上下文、渲染状态、D3D9 着色器，基本就是 D3D9 换了个编码 | 现有的 D9WG 执行器，它已经能完整跑 3DMark06 | 最近：S1–S3 |
| `gb9` | 同一套绘制命令，但对象（表面、着色器、上下文）存放在客户机内存里 | 仍然是 D9WG | 再加 S4 |
| `dx10` 及以上 | D3D10/11 风格的状态对象和 SM4/5 着色器 | 新写的 GX 和着色器翻译器（20k 行以上） | 最远：还要 S4、S5 |

已定（2026-10-01）：第一次 3DMark06 验收只声明到 `vgpu9`。理由是复用最多现成代码，最早能看到结果；之后再升 `gb9`、`dx10`、`dx11`，每升一级用 3DMark06 回归一次。有一个前提要在 A0 验证：VMware 的 Win 8.1 驱动在只有 `vgpu9` 能力时仍然开放 D3D9 3D。如果它要求必须有 GB 对象，就把 S3 和 S4 合并，第一次验收改用 `gb9`，后端仍然是 D9WG。

**前提不成立（2026-10-01 实测）**：Win 8.1 上 VMware 的驱动在没有 DX 能力的设备上开不了 D3D11，DWM 因此起不来，画面全黑，3DMark06 也就无从谈起。所以 Win 8.1 的第一次 3DMark06 验收改在 `dx10`（S5 之后）。实测经过：

- Tools 13.1.5 和 11.3.5 的 vm3d 在 `vgpu9` 和 `gb9` 下都以完整 WDDM 驱动加载（日志 "SVGA WDDM Full Display driver"、"WDDM 3D is on"，`gb9` 下还有 "Guest backed surface is on"），但 `D3DKMTQueryAdapterInfo(DRIVERVERSION)` 是 WDDM 1.0。
- DWM 每隔几秒以 0x8898008d 退出；`D3D11CreateDevice(HARDWARE)` 在所有特性等级上都返回 `DXGI_ERROR_UNSUPPORTED`；设备上一个 3D 上下文都没有建过。
- 用户态驱动本身没问题：按 D3D9 运行时的方式直接调 `vm3dum64_loader.dll` 的 `OpenAdapter`，成功，D3D9 能力是 VS/PS 3.0、41 种格式。但它的 D3D10/11 入口 `OpenAdapter10_2` 也成功，却报告 0 个支持的 DDI 版本、3D 管线等级为空。D3D11 运行时因此判定不支持，而不会退回到基于 D3D9 DDI 的 10level9。
- 诊断工具：`tools/windows/d3dprobe.c`（DXGI、D3DKMT、直接打开用户态驱动）、`runs1.c`（在控制台会话里启动程序；目前在 DWM 失败的会话里起不来，0xC0000142）、日志代理的 `EXTRA.CMD`（DWM/DXGI/D3D11 的诊断通道从 .etl 读，事件没有描述文字，用处不大）。

## 13. 实施进度

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| A0 准备和探测 | 基本完成 | 见附录 B；剩 Windows 镜像的可写副本和驱动预装，放到 S1 的 Windows 验证时做；U4（KB2919355）同时确认 |
| A1 公共基础设施 | 进行中 | 已完成（2026-10-01）：显示适配器插件框架（`src/graphics_adapter.js`、`src/graphics_adapters/`）、`bochs_vga` 迁出核心（`build/v86-bochs-vga.js`）、`graphics_adapter` 必填和 `"none"`、`vram_size` 取代 `vga_memory_size`、VGA BIOS 的 PCI ID 改写、旧存档兼容；测试 `tests/devices/graphics_adapter.js`。设备和渲染器之间的通道（2026-10-01，主线程模式）：页面有 `libv86-webgpu.js` 和 WebGPU 时，`starter.js` 用本地通道把 `vmware_svga` 接到 `V86SVGARenderer`，消息为 submit/reset 和 write/done/lost（见 `svga_renderer.js` 开头）。CPU worker 模式下的渲染器通道（2026-10-01）：设备在 worker 里，渲染器留在页面上（WebGPU 在页面上），用 worker 的设备通道 `graphics_adapter_renderer` 连接，测试 `tests/glbridge/cpu_worker_svga_browser_test.html`（客户机程序提交命令缓冲区，回读穿过 worker 落到客户机内存，存档和恢复之后仍然正确）。未完成：并行模式下的渲染器通道、`pci.js` 的 prefetchable 和多个内存 BAR、`mmio_ram` 非像素区域、`virtio.js` 改造、合成器直接显示 GPU 纹理和光标平面（暂由回读代替，见 5.8 节）、检查点框架 |
| A2 trace 抓取和重放 | 完成（2026-10-01） | `tests/x64/gpu_trace.mjs` 记录设备送给渲染器的批次（批次自带数据，trace 就是批次序列），Linux 测试在 `GPU_LEVEL=vgpu9` 时写 `trace.bin`；`tests/glbridge/svga_trace_replay_browser_test.html` 在真 GPU 上重放，按回读的纹理存 PNG。另有 `tests/x64/gpu_remote_renderer.mjs`：node 里的客户机用无头 Chrome 里的渲染器作真 GPU（`GPU_RENDERER=chrome`、`WIN_GPU_RENDERER=chrome`），测试脚本的自动化照旧 |
| S1 SVGA 基本 2D | Linux 已验收，Windows 进行中 | 设备在 `src/graphics_adapters/vmware_svga/`，测试 `tests/devices/vmware_svga.js`。Linux（Alpine 3.24，`tests/x64/linux_gpu.mjs`）：vmwgfx 用传统显示单元，1280×800，kmscube 约 9 fps。Win 8.1 在设备的 VGA 核心上（VBE）启动到桌面；vm3d 驱动安装和接管的验证在进行中 |
| S2 SVGA 完整 2D | Linux 已验收，Windows 待验证 | GMR1/GMR2（`svga_gmr.js`）、Screen Object（`svga_screens.js`）、硬件光标（`svga_cursor.js`）、命令缓冲区和设备上下文、显示拓扑；存档版本 2。Linux 的 vmwgfx 在等级 `2d-full` 下用 Screen Object 显示单元和命令缓冲区，kmscube 画面正确。Alpine 3.24 内核的 vmwgfx 对没有 MOB 的设备不画光标（日志 "Unknown Cursor Type!"），所以 Linux 的光标验收挪到 S4 |
| S3 VGPU9 + 3DMark06 | 进行中 | 已完成（2026-10-01）：等级 `vgpu9`（`SVGA_CAP_3D`、硬件版本 WS8_B1、SM3.0 devcap 记录），旧式 SVGA3D 命令全部翻译成 D9WG（5.8 节的做法），渲染器 `svga_renderer.js`；测试 `tests/devices/vmware_svga_3d.js`、`tests/glbridge/svga_renderer_browser_test.html`。**Linux 已通过**：Alpine 3.24 的 vmwgfx 开启 3D，kmscube 用 Mesa svga（"SVGA3D; build: RELEASE; LLVM;"），真 GPU 下约 43 fps，画面与 llvmpipe 一致。未完成：Windows 8.1 的 vm3d 3D、3DMark06、`vgpu9` 的存档（GPU 上的表面和上下文还不进存档，恢复后 3D 从空开始）。ABI 已冻结（2026-10-01，提交见 git log，设备状态版本 5）：存档里保存等级和当时声明的全部能力（caps、FIFO caps、CAP2、devcap 表），恢复时按存档声明，不管当前版本会选哪个等级、表里现在是什么值；所以新能力只能放进新等级，旧等级声明过的东西必须一直能用。没有固定等级时默认选已实现的最高等级（现在是 `dx10`，没有渲染器时 `2d-full`）。测试 `tests/devices/vmware_svga_gb.js` 的 "a restore declares the snapshot's level and capabilities"。现在可以按第 10.2 节抓 3DMark06 的状态，文件名用 `dx10` |
| V1 virtio-gpu 2D | 未开始 | |
| S4 GB 对象 | Linux 已验收，Windows 待 S5 | 已完成（2026-10-01）：等级 `gb9`（`SVGA_CAP_GBOBJECTS`、CAP2：GROW_OTABLE、OTABLE_PTDEPTH_2、GB_MEMSIZE_2、CURSOR_MOB、SCREENDMA_REG）。`svga_gb.js`：MOB 和全部页表格式、对象表（设备写表项，`SET_OTABLE_BASE` 带有效项时重新载入对象）；`svga3d.js`：GB 表面（UPDATE 从 MOB 上传、READBACK 回写 MOB，`host_newer` 记录 GPU 是否有更新的内容）、GB 上下文和着色器、内联常量、查询和 MOB fence、Screen Target（GPU 没有更新内容时直接从 MOB 读）、光标 MOB、MOB 里的命令缓冲区、`SVGA_REG_DEV_CAP`、存档（状态版本 4）、GART 命令只记账。测试 `tests/devices/vmware_svga_gb.js`。**Linux 已通过**：vmwgfx 用 Screen Target 显示单元和 GB 对象，fbcon 和 kmscube 正确，约 43 fps。Windows：vm3d 开启 GB 表面和光标 MOB，但见 12 节 D2：没有 DX 就没有 DWM。存档大小和耗时的测量还没做 |
| S5 DX10 + GX | 基本完成 | 已完成（2026-10-01）：等级 `dx10`（`SVGA_CAP_DX`、DXCONTEXT、SM4.0、每种格式的 DXFMT 能力，来自统一的格式表 `svga_dx_formats.js`）。设备侧 `svga3d_dx.js`：DX 上下文以 `SVGADXContextMobFormat` 保存，COTable 直写客户机内存并可从中重新载入，着色器从 MOB 读取，查询和 64 位 MOB fence，GX 批次（与 D9WG 同序的第二条流）；GB 表面在 DX 等级下按首次使用决定放在 D9WG 还是 GX，从 MOB 填充。渲染侧 `gx/gx_executor.js`：表面、视图、状态对象、按状态缓存管线、按接口翻译 VGPU10 着色器（`shader_ir/dxbc_frontend.js` + `wgsl_emitter.js`，naga 验证）、跨绘制保持 render pass、编码器内有序的上传和拷贝、回读、occlusion 查询、清除、blit、mip 生成；WebGPU 缺的格式（RGB32、UNORM16/SNORM16、SNORM8 渲染目标、A8、L8、565/1555/4444 等）加宽存放并转换。**Linux**：vmwgfx 报告 SM4，kmscube 走 Mesa 的 DX 路径，约 56 fps，画面正确。**Windows 8.1**：VMware 的 DX10 用户态驱动按特性等级检查 devcap（从驱动里读出的表，见附录 B 补充），满足 FL10_0 后 D3D11 可用，DWM 画出登录界面和桌面。D3D9 应用可用：d3d9.dll 会检查驱动的格式表，任何一条规则不满足就整张丢弃，导致没有 HAL（GetDeviceCaps 返回 D3DERR_NOTAVAILABLE）。规则有四条：3DACCELERATION 只能用于不带 alpha 的显示模式；R5G6B5 和 X1R5G5B5 不能都是显示模式；MEMBEROFGROUP_ARGB 只能用于 8 位/16 位 RGB、A2R10G10B10、A16B16G16R16 及其浮点版本；深度格式不能成对出现。devcap 已按这些规则修正。D3D9 应用用旧式命令（D9WG）作画，DWM 用 DX（GX）合成，两者共享表面：一个表面可以同时在两个执行器里，`home` 记录最新内容在哪一边；另一边要用时，由 GX 在 GPU 上拷贝（`SURFACE_IMPORT`/`SURFACE_EXPORT`，格式不同时用绘制拷贝，X 格式的 alpha 取 1）；拷贝目标、上传和绘制目标会把另一份标为过期。测试 `tests/glbridge/svga_share_browser_test.html`。D3D9 示例（三角形、清屏、纹理、深度纹理）在 Win 8.1 上画面正确；着色器示例手写的 ps_2_0 给 t/v 寄存器的 dcl 带了用法，VMware 的驱动不接受（真机上也一样，不是模拟的问题）。还修了两个 D9WG 的问题：带 POSITIONT 的声明即使绑定了顶点着色器也按预变换处理（与 wined3d 一致）；声明没有提供的顶点着色器输入读 (0,0,0,1)，不再生成无效管线、连带整帧作废。3DMark06（Professional，`-nosysteminfo`，从 `D:\` 启动）进入主界面，GT1 的加载画面正确；Windows 测试改用客户机里的启动器 `tools/windows/launch.c`（往运行对话框打字会丢键），`WIN_NO_PROBE=1` 防止测试脚本抢走全屏程序的焦点。之后（2026-10-01/02）：几何着色器和流输出用计算着色器模拟（顶点着色器作为计算着色器自己取顶点，几何着色器在计算着色器里按图元写固定槽位，再由直通的顶点着色器画出；流输出是按声明顺序写的计算着色器，带 GPU 计数器，DrawAuto 用间接参数）；WebGPU 取不了的顶点格式、步进率和偏移改为在着色器里取（`drawPulled`）；CPU worker 模式下渲染器留在页面上；ABI 冻结（存档状态版本 5）。**3DMark06 在 `dx10` 下完整跑完**（GT1–GT4、HDR 两个测试和 CPU 测试，渲染器无错误；Basic 版只能在线看分数），见 `build/x64-windows-3dm/run24-*.png`。`tools/windows/d3d11cmp.c` 在客户机里用 `d3dcompiler_47` 编译 HLSL，把硬件（GX）和 WARP 的画面对比：FL10_0 的三角形、纹理和 mip、深度和混合、实例化、GS、流输出都与 WARP 一致。未完成：glmark2（Alpine 3.24 没有，要另外下载）、管线统计和流输出统计查询、条件渲染（现在总是绘制） |
| V3 virgl GL 3.3 | 未开始 | |
| S6 DX10.1 | 完成（2026-10-02） | 等级 `dx10.1`：在 `dx10` 之上加 `SVGA_CAP2_DX2`（Linux 的 vmwgfx 要它和 `SM41` devcap 才建 SM4.1 上下文）、`SM41`，以及 VMware 用户态驱动给 FL10_1 开的条件。那张表要按 {列表指针, 条数, 等级} 读，FL10_1 的列表在 `vm3dum64_10.dll` 的 0x180060a20（先前读错了位置）。条件是：几乎所有渲染目标格式都要 4x MSAA，包括 WebGPU 不能多重采样的 RGBA32/RG32 浮点和整数格式，以及 GX 用 32 位浮点存放的 16 位 UNORM/SNORM；D3D11.1 起还要 NV12、YUY2、R10G10B10_XR_BIAS 表面和 B8G8R8X8 顶点。另外内核驱动要 `CAP2_DX2` 才给用户态驱动 FL10_1 的开关（`svga.wddm.enable10_1FeatureLevel` 默认开）。VMware 的驱动在 FL10_0 下根本不提供 MSAA。`dx10` 的 devcap 一个都没变（`AFTER_DX10`）。为此 GX 的多重采样改成超采样：4x 表面存成宽高各两倍的单采样纹理，每个样本是 2x2 块里的一个纹素；绘制时视口和裁剪乘 2，管线只有一个样本，解析取每块的平均值。所以任何格式都能多重采样，一个 pass 里也不会出现不同的采样数。着色器从片元位置得出样本号，SV_Position 还原成像素中心（逐样本着色时是样本位置）；采样掩码、oMask、alpha-to-coverage 用 discard 模拟（override 常量 `gx_ss`、`gx_sample_mask`、`gx_a2c`）；`ld_ms` 读 2*xy+(s&1, s>>1)。样本落在网格上，不是 D3D 的标准图样，所以边缘的覆盖率略有不同。着色器：`lod` 用导数计算；光栅器的 `sample_info`/`sample_pos` 读管线常量；`sincos`/`imul` 的目标和源是同一寄存器时，先读源再写。GX：深度上传（WebGPU 只能把数据拷进 depth16unorm 和模板面，depth32float 和 24 位深度改用写 frag_depth 的绘制；原来的整面拷贝让整个命令缓冲区作废）；立方体数组视图按立方体个数取层。设备侧：`UPDATE_ZERO_SURFACE`/`WRITE_ZERO_SURFACE`。**Win 8.1**：D3D11 拿到 FL10_1 和 4x MSAA，`tools/windows/d3d11cmp.c` 的 11 个用例（立方体数组、gather 和 LOD、每个渲染目标单独混合、MSAA、sample info 和 FL10_0 的用例）都与 WARP 一致；桌面正常。**Linux**：vmwgfx 报告 "shader model: SM4_1"，Mesa 报告 GL 3.3 和上面五个扩展，kmscube 开 4x MSAA 时约 40 fps，边缘平滑。`dx10.1` 现在是默认 3D 等级。测试：`svga_msaa_browser_test`、`svga_cube_array_browser_test`、`svga_depth_upload_browser_test`、`dxbc_wgsl_test`（SM4.1，naga）、`vmware_svga_gb.js`（`dx10.1` 只在 `dx10` 上加位）、`linux_gpu.mjs` 的 `sm41` 场景；诊断工具 `tools/windows/kmtinfo.c`（内核驱动交给用户态驱动的标志、caps 和 devcap） |
| S7 DX11 | 未开始 | |
| V4 virgl GL 4.3 | 未开始 | |
| V2 blob（GUEST） | 未开始 | |
| V5 HOST3D blob | 未开始 | |
| S8 收尾 | 未开始 | |
| （原 V6/V7/V8） | 暂缓 | D1、D6 |

## 附录 B：A0 的结论（2026-10-01）

**驱动包和来源**（放在 `~/Downloads/v86-gpu/`，不进仓库）：

- VMware Tools 13.1.5（`VMware-tools-13.1.5-25544008-x64.exe`，140 MB）。SVGA 驱动在内嵌 MSI 的 `VmVideo.cab` 里，Win 8 版本文件名带 `_Win8.<GUID>` 后缀，已整理到 `vm3d-win8-13.1.5/`，驱动版本 9.17.09.0007。
- VMware Tools 11.3.5（`VMware-tools-11.3.5-18557794-x86_64.exe`，99 MB），留作对照。
- virtio-win 0.1.240（628 MB）：带 `viogpudo\w8.1\amd64`（与 `2k12R2` 硬链接同一份文件），驱动版本 63.93.104.24000，Red Hat 签名。**U3 已解决。**

**PCI 身份必须精确匹配 INF：**

- SVGA II：`vm3d.inf` 的 `NTamd64.6.3`（Win 8.1）只匹配 `PCI\VEN_15AD&DEV_0405&SUBSYS_040515AD&REV_00`。
- virtio-gpu：`viogpudo.inf` 只匹配 `PCI\VEN_1AF4&DEV_1050&SUBSYS_11001AF4&REV_01`。

**Win 8.1 驱动开启 3D 的条件**（反汇编 `vm3dmp.sys` 的能力检查函数得出；**U1 大部分已解决**）：

- 驱动内部标志位：`CAP_GMR`、FIFO 的 `SCREEN_OBJECT`/`SCREEN_OBJECT_2`、`CAP_GMR2`、"`COMMAND_BUFFERS` 和 `CMD_BUFFERS_2` 同时具备"；GB 模式要求后者加上 `CAP_GBOBJECTS`。
- **旧式（非 GB）3D 路径仍然存在**，D2 的前提成立。它要求：
  - `SVGA_CAP_3D`、`CAP_GMR2`、`CAP_EXTENDED_FIFO`；
  - FIFO 寄存器区大于 `0x480` 字节，并且 FIFO 里有 `SVGA3DCAPS_RECORD_DEVCAPS`（类型 `0x100`）的能力记录；
  - FIFO `3D_HWVERSION`（有 `FIFO_CAP_3D_HWVERSION_REVISED` 时读 `_REVISED`）不低于 `SVGA3D_HWVERSION_WS8_B1`（`0x20001`）；
  - devcap `3D` 非 0，`VERTEX_SHADER_VERSION` 不低于 5（VS 2.0），`FRAGMENT_SHADER_VERSION` 不低于 11（PS 2.0）。3DMark06 需要 VS=7、PS=13（3.0）；
  - `SVGA_REG_MEMORY_SIZE` 足够大，阈值和屏幕数有关，最多需要 64 MB；不满足时日志会写"host memory size"。
- GB 模式下 devcap 通过 `SVGA_REG_DEV_CAP` 逐项读取（0–261），否则从 FIFO 能力记录读取。
- DX 相关开关：`SVGA_CAP_DX`（第 28 位）、`CAP2_DX2`、`CAP2_DX3`，以及 SM5/FL11_0 的判断。
- 驱动通过 backdoor 的 RPCI 读 `guestinfo.svga.wddm.*` 配置（如 `enableGBObjects`、`enableDX10`）；没有 RPCI 时用默认值，不影响加载。
- U2（设备声明 DX 能力时 D3D9 走哪种命令）留到 S5 实测。

**Linux 测试盘**：`tools/alpine_gpu_repo.mjs` 按依赖闭包下载 Alpine 3.24 的 122 个包（115 MiB，保留官方签名的 APKINDEX），打成 `build/x64-linux/gpu-repo.tar`。`tests/x64/linux_gpu.mjs` 启动官方 virt ISO，离线安装 Mesa、kmscube、modetest，加载适配器的 DRM 驱动并截图。基线：bochs_vga 加 llvmpipe，27 秒登录，kmscube 约 15.6 fps。Alpine 3.24 没有 glmark2。

**常量**：`tools/gen_svga_constants.js` 从 `third_party/vmware-svga` 生成 `src/graphics_adapters/vmware_svga/svga_constants.js`（2616 个；带预处理器、BigInt 求值）。

## 附录 A：各等级的能力表（A0 起填写）

每个等级一张表，内容包括：

- `SVGA_CAP_*`、`SVGA_CAP2_*`、`SVGA_FIFO_CAP_*`；
- 关键 devcap：着色器版本、MRT 数、纹理数、各种 `SURFACEFMT_*`、`DXCONTEXT`、`SM41`、`SM5`、`MULTISAMPLE_*`；
- 要求的最低 WebGPU feature 和 limit。

每一项注明由哪段代码实现，或者引用哪条偏差 `G-xx`。

| 等级 | 新增能力（概要） | 最低 WebGPU 要求（初稿） |
| --- | --- | --- |
| `2d` | `CURSOR`、`CURSOR_BYPASS(_2)`、`ALPHA_CURSOR`、`8BIT_EMULATION`、`PITCHLOCK`、`IRQMASK`、`EXTENDED_FIFO`、`TRACES`、`RECT_COPY` | 无（Canvas2D 也行） |
| `2d-full` | `GMR`、`GMR2`、`MULTIMON`、`DISPLAY_TOPOLOGY`、`SCREEN_OBJECT_2`、`COMMAND_BUFFERS`、`CMD_BUFFERS_2`、`HP_CMD_QUEUE`、`CAP2_REGISTER` | 无 |
| `vgpu9` | `3D`、FIFO 3D 能力记录（SM3.0） | `float32-filterable`（视格式而定），以及 D9WG 现有的要求 |
| `gb9` | `GBOBJECTS`、Screen Target、`CAP2_GROW_OTABLE`、`CAP2_CURSOR_MOB` 等 | 同上 |
| `dx10` | `DX`、`DXCONTEXT`、`DXFMT_*` | `texture-compression-bc`、`depth32float-stencil8`、`depth-clip-control` |
| `dx10.1` | `SM41`、`MULTISAMPLE_4X`、`CAP2_DX2` | 同上 |
| `dx11` | `SM5`、`CAP2_DX3` 等 | 同上，外加 `dual-source-blending`、`indirect-first-instance`、`timestamp-query`（可选） |
