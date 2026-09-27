# v86：完整 ACPI、x86-64 与单路多核心实施计划

> 状态：A1 已实施（见 §5 A1 的实施记录），其余阶段待实施。
> 基线：2026-09-27，`8af0560e`（PR #55 合并后，工作区干净）。原稿基线 `dfd8ac23 + 未提交修改` 已过时。
> §2 的事实均经源码审计，标注“探针”的条目另经客户机运行确认（buildroot Linux 6.8，`acpi: true`）。
> 目标仓库是 `v86`，本文路径均相对此仓库。

建议顺序为：**固定平台契约和测试基线 → 单核 ACPI 正确 → 32 位单路多核（轮转） → 单核 x86-64 → x64×多核集成 → 宿主并行与整体验收**。x86-64 与 32 位多核两条线在 P2a 之后可并行推进；两者都通过后才进入 XC 集成，不能通过跳过 x86-64 验收来结束项目。

这是一项跨 CPU、MMU、JIT、设备、固件和快照格式的架构改造。每个阶段应拆成可单独回归的提交，不能作为一个“大 PR”实施。

## 0. 审阅修订摘要（2026-09-27）

本版对原计划做了以下修订，依据见 §2：

1. **ctx_ptr ABI 重构移出关键路径。** 原 P2（XL）同时阻塞 X1 与 C1。轮转式多核在单个 Wasm 实例内串行执行，可以在安全点整块换入/换出固定地址的 CPU 状态区（`global_pointers.rs` 中 64..1353 约 1.3 KiB，另加 LAPIC、TLB 指针等少量 Rust 静态状态），已编译代码读固定地址，因此对所有核有效。只有宿主并行（W1）才要求每线程独立的状态基址，所以 ctx_ptr ABI 改为 W0，放在 W1 之前。P2 只保留“布局单一来源”和“每核状态边界审计”（P2a）。
2. **多核不再等待 x86-64。** 原 C2 依赖 X4、X5，把价值高、风险较低的 32 位 SMP 排在最难的长模式之后。修订后 C1–C3 依赖 A1、P2a、C0，用 32 位 Linux SMP 验收；x64 与多核的组合由新的 XC 阶段负责。
3. **超过 4 GiB 的内存容量降为可选的 X6。** 客户机 RAM 与 Rust 堆目前共用一个 wasm32 memory；4 GiB 以上容量需要 Memory64 或多 memory，并让所有 JIT 访存走新路径。目标 OS 在 ≤3 GiB 下即可验收。36 位物理地址语义（MAXPHYADDR、保留位、高位 MMIO）仍是 X2/X5 的必做项。
4. **分级发布。** `R-ACPI`（S0/S5/电源按钮/SCI）→ `R-SMP32` → `R-x64-UP` → `R-x64-SMP` → `R-parallel`。每级有独立门槛，可以单独交付；“完整支持”仍指全部等级通过（X6 除外，见 §1.2）。
5. **ACPI 的现成缺陷前移到 A1。** 当前固件默认公布未实现的 S3（客户机进入后会永久等待 WAK_STS），S4 的 SLP_TYP 与 S5 相同；guest 写 S5 后 VM 继续运行；GPE 状态不是 W1C；SCI 每个定时器周期都被拉低。其中隐藏 S3/S4 只需提供 fw_cfg 文件 `etc/system-states`，不必等 A2 的表生成器。
6. **虚拟时钟收窄。** A1 只需要可注入、单调、跨快照连续的 PM timer（与 TSC 的 `set_tsc` 恢复策略一致）。按指令推进的确定性机器时钟是多核可复现调度测试的前提，单列为 C0。
7. **S3/S4 机制写实。** 在 PIIX4/SeaBIOS 模型中，OS 主导的 S4 对硬件只是一次带标记的 soft-off，工作主要在磁盘持久化和 OS 验证；S3 才需要保留 RAM、复位 CPU 后经 CMOS 关机状态 `0xFE` 走 SeaBIOS resume 路径跳到 FACS waking vector。
8. 每阶段增加实施状态；A1 已按本版实施并通过 §5 A1 中列出的测试。

## 1. “完整支持”的验收边界

### 1.1 明确目标，不以能够启动代替完成

| 方向 | 本计划必须交付的结果 | 不能作为完成证据的现象 |
|---|---|---|
| ACPI | 固定虚拟 PC 平台的表、AML、PM 寄存器、SCI、IRQ 路由、电源按钮、S5、复位、S3 恢复、OS 主导 S4、快照一致性；32/64 位目标 OS 正常使用 ACPI | 只移除 experimental、只有表可解析、仍必须选 Standard PC 或加 `acpi=off` |
| x86-64 | 客户机长模式和兼容模式、完整目标 CPU profile、64 位地址/寄存器/异常、四级分页和 NX、解释器和现有 IR 各执行路径、36 位物理地址语义（高位 MMIO/保留位/可重映射到 4 GiB 以上的 RAM）；超过 4 GiB 的 RAM **容量**是可选 X6 | Wasm 使用 i64、能执行几条 64 位算术指令、只进入 long mode、只能使用低地址 |
| 单路多核心 | **1 socket × N cores × 1 thread/core**；每核独立架构状态、LAPIC、启动/中断/调度、共享内存一致性，OS 在所有核上执行负载 | N 个 socket、N 台独立 VM、只让 CPUID/MADT 显示 N、只把 VM 移入 Worker |
| 宿主并行 | 在支持的环境中，多个 vCPU Worker 确实同时执行；正确性和适用负载的加速有证据 | 多核数量增加但依旧串行，却宣称使用宿主多核加速 |

客户机多核的硬件/OS 实现仍属于 SMP：单个封装内的各核同样需要 BSP/AP、IPI 和同步机制。“单处理器”在本文指一个物理封装/socket，不指只有一个执行上下文。拓扑枚举以 [Intel 官方拓扑说明及示例](https://github.com/intel/SDM-Processor-Topology-Enumeration) 为依据。

分两个明确的多核里程碑：`MC-functional` 是有界轮转执行的正确客户机多核（C0–C3、XC，发布级 `R-SMP32`/`R-x64-SMP`）；`MC-parallel` 是宿主真正并行（W0–W2，`R-parallel`）。前者是后者的参考实现，并长期保留为兼容/调试路径；本文把两者都列入最终交付，不能把轮转的正确性结果写成性能扩展结果。

### 1.2 建议冻结的首个产品 profile

以下是本计划的**工程范围决策**，不是现有能力，也不是对所有 x86/ACPI 可选扩展的承诺。P0 阶段将其写入机器可读清单，后续修改范围需在阶段记录中说明。

- 平台沿用当前传统 BIOS、PCI/PIIX 风格设备；SeaBIOS 启动 64 位 OS，不把 UEFI 迁移作为先决条件。
- 新增版本化 `v86-x64-v1` 虚拟 CPU profile：Intel 风格语义，48 位线性地址、36 位物理地址，4 KiB/2 MiB 页，PAE、NX、SYSCALL/SYSRET、SSE2，以及逐项审计后保留的现有 SSE3 能力。纳入 CX16、长模式 LAHF/SAHF，支持所选兼容模式系统调用约定；每个已公布能力必须有实现和测试。
- 不宣称 64 位 CPU 有 64 位可用物理地址。36 位物理地址是第一版公开上限；超范围页表项/地址应按架构或总线契约处理，不能截断回低地址。RAM 总容量第一版受 wasm32 限制（约 3 GiB 可用），超过 4 GiB 的容量属于可选 X6，未完成时配置层明确拒绝。
- 新 profile 支持 `N=1..8`，强制 `sockets=1`、`threads_per_core=1`。日常验收用 1/2/4/8 核，另用 3 核检查非 2 的幂拓扑。8 核以上另行扩展。
- ACPI 使用传统 fixed-hardware 模型；初期只公布已通过的 S0/S5，后续启用 S3 和 OS 主导的 S4。最终必须完成后两者；暂时隐藏不等于任务完成。C0/C1 足够作为本版 CPU 空闲状态。
- 无对应硬件的电池、EC、温控、CPU/内存热插拔、NUMA、S0ix、C2/C3/P-state 不凭空添加。HPET、PCIe ECAM/MCFG、x2APIC、1 GiB 页、LA57、PCID、XSAVE/AVX、VMX/SVM、UEFI 属于后续能力，默认不公布；若目标 OS 确实依赖某项，先扩大契约再实现，不能伪造支持。
- ACPI 规范涵盖多类平台；本版“完整”指该虚拟硬件公开契约闭环。规范参考使用 [ACPI 6.6](https://uefi.org/specs/ACPI/6.6/)，具体表 revision、长度、flags 按实际内容设置，不把“参考 6.6”写成“实现全部 6.6 可选设施”。

### 1.3 目标系统与兼容承诺

P0 固定镜像版本、内核配置、磁盘/固件 SHA-256、启动参数和测试程序；先使用可重建的 Linux/i386、Linux/x86-64 小镜像作自动化基线。最终必须补充一个独立 OS 家族：本项目建议 Windows XP/2000 的 ACPI HAL 回归，以及 Windows 7 SP1 x64 的 ACPI/多核/兼容模式安装和运行验收。这些是验收目标，**不是当前兼容性结论**。

商业镜像由实施环境提供，测试报告记录来源标识和校验值；缺少镜像时必须标注未验收，不能用 Linux 成功替代 Windows 结果。FreeBSD/其他 BSD 可作为额外独立验证。任意最新 Windows、依赖 x86-64-v2/v3 的发行版不自动包含在此 profile 中。

## 2. 已确认的代码现状

| 模块 | 当前证据 | 对实施的影响 |
|---|---|---|
| 开关 | [`v86.d.ts`](../v86.d.ts) 的 `acpi` 标注 experimental；`acpi_enabled` 同时门控 LAPIC/IOAPIC 的 MMIO、`handle_irqs` 的 APIC 路径和 `device_raise_irq` 的 IOAPIC 分支（`apic.rs`、`ioapic.rs`、`cpu.rs`） | `acpi:false` 意味着没有 LAPIC；多核必须拆开“平台有 APIC”和“公布 ACPI”两个开关，并保留旧配置兼容 |
| 固件表来源 | 未提供 `etc/table-loader`，SeaBIOS 1.16.2 走 `acpi_setup()` 回退：RSDP v0 → 仅 RSDT（无 XSDT）、FADT rev1（无 RESET_REG/X_ 字段）、FACS、内置 DSDT、SSDT（`ssdt-misc` + 每 CPU Processor + PCI 热插拔）、MADT（按探测到的 CPU 生成） | 64 位 Windows 等需要 XSDT/FADT rev3+ 的目标必须换表路径（A2）；32 位 SMP 的 MADT 可暂用回退表（C1） |
| FADT 契约（回退表） | SCI=9，SMI_CMD=0xB2，ACPI_ENABLE/DISABLE=0xF1/0xF0，PM1a_EVT=0xB000(4)，PM1a_CNT=0xB004(2)，PM_TMR=0xB008（24 位），GPE0=0xAFE0(4，16 个 GPE)；flags=WBINVD\|PROC_C1\|SLP_BUTTON\|RTC_S4\|USE_PLATFORM_CLOCK | PWR_BUTTON=0 即公布**固定电源按钮**；FIX_RTC=0 即公布 RTC_STS/RTC_EN；A1 必须实现这些位 |
| 睡眠状态 | 回退 SSDT 从 fw_cfg `etc/system-states` 取值；v86 未提供时默认 `{128,0,0,129,128,128}`：`_S3_`=1，`_S4_`=0，`_S5_`=0（三者都在 SSDT 的 `ssdt-misc` 中，隐藏时首字符改为 X，即 `XS3_`/`XS4_`） | 原实现公布 S3 却未实现（客户机进入后永久等待 WAK_STS）；S4 与 S5 同值 |
| ACPI 设备（原实现） | [`src/acpi.js`](../src/acpi.js) 硬编码 PM1 `0xB000..`、PM timer `0xB008`、GPE `0xAFE0..`；只注册部分访问宽度；PM1_CNT 写入仅保存值；GPE 是裸字节 | 探针：`poweroff` 后 PM1_CNT=`0x2000`（S5 请求）而 VM 继续运行；OS 向 GPE0_STS 写 1 清除后读回 `0xFF` |
| SCI | 原 `timer()` 仅在 enable 时锁存 TMR_STS，否则每轮调用 `device_lower_irq(9)` | SCI 不是按 pending 条件保持的电平；也会清掉共用 IRQ9 的其他源 |
| 中断线共享 | [`src/pci.js`](../src/pci.js) 的 `lower_irq` 在降线时重新计算 PIRQ 路由并直接清整条线 | 共享线上清一个源会清掉其他源；OS 在线路有效时改 PIRQ 路由会降错线 |
| SMM | SeaBIOS `CONFIG_USE_SMM` 的重定位写 0xB2 后轮询 0xB3，v86 的 0xB3 读固定返回 0，所以 SMI 处理程序从未运行；`GLBCTL`（0xB028）未实现 | SMI_CMD 的 ACPI_ENABLE/DISABLE 必须由设备直接处理，不能依赖 SMM |
| 时间/恢复 | 所有设备计时都用 `v86.microtick()`；TSC 通过 `set_tsc` 在恢复后连续；原 PM timer 每次读取最多额外前进 1 ms，快照不保存相位 | A1 只需让 PM timer 与 TSC 同策略；确定性时钟属于 C0。SeaBIOS 用 PM timer 作自身计时源（`pmtimer_setup`），改动会影响 POST |
| 固件构建 | [`bios/fetch-and-build-seabios.sh`](../bios/fetch-and-build-seabios.sh) 固定 `rel-1.16.2`；`git clone ... \|\| true` 会在已有目录上继续；config 打开 ACPI/DSDT/MPTABLE/S3_RESUME/SMM/TCGBIOS | 必须审计实际生成表和固件路径，config 开启不代表 emulator 已实现 |
| 核数输入 | `src/cpu.js` 的 `FW_CFG_NB_CPUS/MAX_CPUS` 均为 1，`CMOS_BIOS_SMP_COUNT` 为 0 | fw_cfg、CMOS、MADT、CPUID 必须共用拓扑来源 |
| CPU 状态 | [`global_pointers.rs`](../src/rust/cpu/global_pointers.rs) 把架构状态放在固定地址 64..1353，`ir_tlb_base`（2048）已是生成代码读取 TLB 基址的间接槽；`src/cpu.js` 建立相同偏移的 TypedArray；GPR/XMM 仅 8 个；LAPIC/IOAPIC/PIC 是 `static Mutex`，TLB 是 4 MiB 的 `static mut tlb_data` | 轮转多核可整块换入换出状态区并按核切换 LAPIC/TLB（C1）；宿主并行才需要 ctx_ptr ABI（W0）；扩宽寄存器会改变布局（X1） |
| 长模式 | [`cpu.rs`](../src/rust/cpu/cpu.rs)、[`instructions_0f.rs`](../src/rust/cpu/instructions_0f.rs)、[`paging.rs`](../src/rust/paging.rs) 仍围绕 32 位；PAE 不接受高物理位/NX 的关键路径 | 需状态机、指令语义、异常和 MMU 整体扩展 |
| IR/JIT | [`ir-design.md`](ir-design.md) 与源码显示 **IR 是唯一 JIT**，Tier-0 默认启用；`GuestEip/LinearAddress/PhysicalAddress` 为 u32，StateMap 的 GPR 为 8 项 | Tier-0、区域后端及解释器全部要适配 |
| 页快照 | [`ir/runtime/snapshot.rs`](../src/rust/ir/runtime/snapshot.rs) 有独立的页表读取逻辑 | 只改执行时 MMU，编译时仍可能读取错页或错误拒绝高地址 |
| 中断控制器 | [`apic.rs`](../src/rust/cpu/apic.rs)、[`ioapic.rs`](../src/rust/cpu/ioapic.rs) 为部分实现，存在单例、目的路由/INIT/NMI 等缺口 | AP 启动、IPI 和设备中断路由需完整状态机 |
| Worker | [`cpu_worker.js`](../src/browser/cpu_worker.js) 和 [`cpu_worker_runtime.js`](../src/browser/cpu_worker_runtime.js) 将整台 VM 放入一个 Worker，并转发全部 bus 事件 | 当前 `cpu_worker` 不等于 vCPU worker pool |
| 快照 | [`src/state.js`](../src/state.js) 当前 `STATE_VERSION=6`，CPU/device state 由位置数组构成 | 要设计版本迁移与拓扑校验，不能静默误读旧 state |
| 测试 | `make kvm-unit-test` 只构建运行 realmode/taskswitch/taskswitch2；build.sh 使用 i386；`run.mjs` 未显式开启 ACPI；`tests/devices/virtio_console.js` 等已用 `acpi: true` 启动 buildroot | 仓库内有 APIC/SMP/x64 测试源码，不表示现有 CI 覆盖它们 |
| 本地镜像 | `images/` 有 buildroot-bzimage68（Linux 6.8，内核无 suspend/hibernate：探针显示 `supports S0 S5`）、TinyCore-11、linux.iso、linux4.iso、DOS/Win1 镜像；`retro-gaming-site` 的 Windows XP 以 `acpi:false` 运行 | 本地只有 Linux 能作 ACPI 客户机验收；Windows ACPI HAL 与 x64 目标需另备镜像 |

特别注意：`tests/api/clean-shutdown.js` 检查 `destroy()` 清理，不是客户机 ACPI 关机；`tests/api/parallel.js` 的独立 VM 并行也不能替代单 VM 多核测试。旧文档中出现的 `jshint`、`tests/kvm-unit-tests/run.js` 等入口应以当前 Makefile 和 `run.mjs` 为准。

## 3. 统一架构决策

### 3.1 Machine 与 CpuContext 分离

```text
V86 / Machine
  ├─ PlatformProfile / FirmwareConfig / GuestPhysicalMemory
  ├─ Shared devices: PCI, PIC, IOAPIC, ACPI, PIT, RTC, disk, network, DMA
  ├─ VirtualClock / EventQueue / InterruptRouter / Scheduler
  ├─ Code-page generations / snapshot coordinator
  └─ CpuContext[0..N)
       ├─ GPR[16], RIP, flags, segments, CR/DR, MSRs, FPU/XMM[16]
       ├─ LAPIC, BSP/AP startup state, pending IRQ/NMI, halt state
       ├─ TLB / paging context / fault and REP continuation
       └─ JIT runtime, active frames, local table handles and statistics
```

上图是逻辑归属，不规定实现方式。实现分两步，第二步只为宿主并行服务：

**第一步（C1，轮转执行）：状态块换入换出。** 同一 Wasm 实例内任意时刻只有一个核在执行，因此：

- 活动核的架构状态留在现有固定地址；每核在 Machine 中有一个保存区。只在安全点（主循环两次 `do_many_cycles` 之间、无活动 JIT/helper 帧、REP/fault continuation 已落地）切换：`fpu_sync_all()` 刷出 x87 影子，复制状态区到当前核保存区，再复制下一核的保存区进来。
- 状态区的范围由 P2a 的布局描述给出，并有断言：凡新增字段都必须声明“每核/每 Machine/缓存（切换时丢弃）”。
- LAPIC 从单个 `static Mutex<Apic>` 改为按核数组，`get_apic()` 取当前核；IOAPIC/PIC 仍属 Machine。
- TLB：首版切换时整表失效（`valid_tlb_entries` 让清除代价与已用项成正比）；需要时再改为每核 TLB 数组，通过改写 `ir_tlb_base` 槽和 Rust 的 TLB 指针切换。
- 已编译代码只读固定地址，对所有核有效；入口处已有的状态 guard（state flags、平面段特化）继续保护模式差异。代码物理页 generation 属于 Machine。
- 切换代价是约 1.3 KiB 复制加一次 TLB 失效，量子取 10^4–10^5 条指令时可以忽略；以 C2 的诊断计数实测。

**第二步（W0，宿主并行前）：显式上下文 ABI。** 多个 Worker 共享一个 memory 时固定地址会冲突，此时才把 CPU 访问迁到 `ctx_ptr + field_offset`：

- Wasm JIT ABI 使用 `ctx_ptr + field_offset`，helper 明确当前核；共享的客户机内存通过独立 machine/memory 句柄访问。
- 布局沿用 P2a 的权威描述生成 Rust offset/JS accessor/JIT 常量，带 ABI version 和启动断言。
- 所有 `static mut`、固定槽位、TLS、SoftFloat 状态、x87 shadow、JIT active/cache、性能统计逐项归属：每核、每 Machine、纯只读、宿主线程私有。审计还覆盖多个 V86 实例的隔离。
- 第一步中的“当前核”全局只在单线程里成立，不能带进并行实现；禁止 JS I/O 回调重入另一个 vCPU 后仍复用旧指针。
- 第一版为每核分开 JIT 运行时和产物，避免未经证明的跨核复用；以后共享只读编译产物时仍必须检查模式、地址空间、上下文 ABI 和内存布局。

### 3.2 分清四类地址

| 类型 | 表示与规则 |
|---|---|
| 客户机 RIP/EIP | u64 存储，按模式实施 16/32/64 位语义；当前 `instruction_pointer` 具有线性地址含义，迁移时不能只改类型 |
| 客户机线性地址 | u64；先执行分段/地址尺寸规则，再检查 canonical，再分页 |
| 客户机物理地址 | u64；受 profile 的 MAXPHYADDR 约束；进入 RAM/MMIO 总线查找 |
| Wasm 内存偏移 | wasm32 的 u32，仅指已经验证的驻留后备内存范围，不能拿客户机地址直接转换 |

Wasm 有 i64 数值类型；采用 wasm32 不妨碍实现客户机 64 位寄存器。因此本计划先保留 wasm32，避免把客户机 ISA 改造绑定到宿主 Memory64 迁移。[Wasm 数值类型定义](https://webassembly.github.io/spec/core/syntax/types.html)

低地址 RAM 保留经守卫的快速访问。高物理 RAM 使用分块后备存储和慢路径，块可由多个 ArrayBuffer/SharedArrayBuffer 或独立 memory 承载；跨块读写走总线 helper。P0 先做原型结论；X5 只要求 36 位物理地址语义和 4 GiB 以上的重映射窗口，实际超过 4 GiB 的容量属于可选 X6。**只在 >4 GiB 地址映射一小块内存不算超过 4 GiB 容量验收。** 不要求单个 wasm32 memory 装下所有客户机 RAM。

JS 接口的 u64 使用 BigInt 或明确的 `{lo, hi}`，日志采用十六进制文本；不得经 `Number`、`|0`、`>>>0` 隐式截断。热循环留在 Wasm；JS 的 BigInt 不作为逐条指令的数据通道。

### 3.3 固件表和硬件来自同一个 profile

新增机器可读平台描述，统一产生 CPU/APIC ID、PCI 资源、SCI/GSI、内存图、睡眠状态和 fw_cfg 输入。建议新增 `src/platform.js`、`src/firmware/`、`bios/acpi/`，具体拆分可调整，但所有表必须有可审阅源文件和可重复生成流程。

首选 **v86 生成 ACPI 表/AML + fw_cfg 文件目录 + SeaBIOS table-loader 安装**。当前 `option_roms` 已复用 fw_cfg 文件目录，可演进为普通文件 registry。先做单核原型验证分配、重定位、校验和、RSDP 安装，再替换 fallback 生成路径。固定 SeaBIOS tag 的 [ACPI 生成代码](https://raw.githubusercontent.com/coreboot/seabios/rel-1.16.2/src/fw/acpi.c) 已提示新功能使用另一条表加载路径；[fw_cfg 协议](https://www.qemu.org/docs/master/specs/fw_cfg.html) 是实现参考。

不要启动后扫描客户机内存并补丁修改 ACPI 表。不要同时让 SeaBIOS fallback 和 v86 安装两套冲突的表。若 table-loader 原型受阻，只能以记录明确原因的、固定版本小补丁作过渡，不能改为不可追溯的 ROM 二进制修改。

RSDT/XSDT 为同一组表提供兼容入口；优先把固件表放在低 4 GiB 供老 OS 使用。FACS 对齐、保留内存、FADT 的 legacy/extended 地址和 GAS 必须一致。基本表及字段依据 [ACPI 软件模型](https://uefi.org/specs/ACPI/6.6/05_ACPI_Software_Programming_Model.html) 核对。AML 由客户机 OS 解释，v86 提供表和 OpRegion 对应硬件；不需要给 emulator 编写通用 AML 解释器。

### 3.4 时间、调度和安全点

- 现状：PM timer/PIT/RTC/LAPIC/TSC 已由同一 `v86.microtick()` 派生，但不是虚拟时钟。A1 的要求只是：设备读取时间的入口可注入；PM timer 单调、不因读取前进，并像 TSC 一样在快照恢复后从保存值连续计数；暂停期间与 TSC 同样随宿主时间前进（与现状一致）。
- C0 引入 Machine 级虚拟时钟：PM timer/PIT/RTC/LAPIC/TSC 由同一时间源派生；RTC 墙钟基准单独保存。多运行一个核心不能让时间多走一倍。可重现测试使用固定事件队列和种子；正常运行可与宿主单调时间同步，但必须规定暂停、后台节流、S3、保存/恢复时的时钟推进策略。
- 第一版多核按已提交指令/REP 元素预算轮转，JIT 回边、链接循环、helper 和长 REP 必须有安全点；不能等一个核主动 HLT 才运行其他核。
- 单个核 HLT 只阻塞该核；全核 HLT 时等待最近设备事件，不能忙转，也不能停止唤醒时钟。
- 核切换发生在架构允许的可中断边界；LOCK/隐式锁定 XCHG 不可拆开。进入回调前物化当前核状态，离开时按 helper 契约重载。

### 3.5 公开配置与快照

建议新增配置（名称在 P0 固定，以下不是可直接使用的现有 API）：

```javascript
{
    cpu_profile: "v86-x64-v1",
    cpu_cores: 4,                    // 固定 1 socket，1 thread/core
    cpu_execution: "cooperative",   // 之后增加 "parallel" / "auto"
    acpi: true,
    memory_size: 1024 * 1024 * 1024
}
```

沿用 `cpu_worker` 表示“VM 宿主放置方式”，不将其悄悄改为核心数。非法组合在启动前报错，例如多核却关闭必需的平台中断能力、未知 profile、超测试上限的核心数；`auto` 因环境限制回退时提供实际执行模式查询，显式 `parallel` 不静默变成串行。

新快照保存 profile、拓扑、内存图/分块索引、所有 CPU 架构状态、LAPIC/IOAPIC、队列、时间和设备状态。暂停所有核并确认无活动 JIT/helper 帧后采集；恢复后丢弃 TLB/JIT/宿主句柄并重建。

升级 state version；为明确支持的旧 v6 单核快照提供到 legacy profile 的导入器，其他版本/不兼容拓扑在修改 VM 前拒绝。不能把旧 8×32 位数组直接解释为新 16×64 位状态，也不能把保存时的 4 核状态恢复到 2 核后丢掉 AP。

## 4. 阶段与依赖

| 阶段 | 前置条件 | 交付/退出条件 | 规模 | 发布级 | 状态 |
|---|---|---|---|---|---|
| P0 基线和契约 | 无 | 可复建测试环境、profile、能力矩阵、基线报告 | M | — | 部分（本次记录基线） |
| A1 ACPI fixed hardware | P0 | PM/SCI/GPE/SMI_CMD/按钮/S5 设备测试与 Linux 客户机测试通过；S3/S4 隐藏 | M | R-ACPI | **已实施** |
| P1 平台描述/测试入口 | P0 | 共用平台描述、带超时和结构化结果的 runner、诊断导出 | L | — | 待实施 |
| A2 固件表/路由闭环 | A1、P1 | table-loader 安装的表（含 XSDT、FADT rev3+ RESET_REG）、AML 与设备资源一致 | L | R-ACPI | 待实施 |
| P2a 布局单一来源 | P0 | 生成的 offset/accessor、状态区归属表与断言；单核行为不变 | L | — | 待实施 |
| C0 确定性机器时钟 | P1 | 可注入/可按指令推进的时钟；PIT/RTC/LAPIC/PM/TSC 同源；固定输入得到相同 IRQ 序列 | M | — | 待实施 |
| C1 每核 LAPIC/AP 启动 | A1、P2a、C0 | 状态块换入换出、按核 LAPIC、INIT/SIPI/IPI；32 位 trampoline 与 SeaBIOS 在 2/4/8 核启动 | XL | — | 待实施 |
| C2 单路拓扑/轮转 | C1、A2 | 32 位 Linux 识别 1×N×1，各核执行任务（解释器） | L | — | 待实施 |
| C3 跨核一致性/JIT | C2 | 原子、TLB shootdown、SMC、快照；Tier-0/区域后端在多核下通过 | XL | R-SMP32 | 待实施 |
| X1 64 位状态/解码 | P2a | 模式矩阵、REX/寄存器/地址尺寸单测通过 | L | — | 待实施 |
| X2 MMU/异常/系统状态 | X1 | 长模式切换、分页/NX/异常帧测试通过 | XL | — | 待实施 |
| X3 64 位解释器闭环 | X2、A2 | 单核 x64 OS + 32 位进程，无 JIT 正确运行 | XL | — | 待实施 |
| X4 IR 各层 x64 | X3 | 解释器/Tier-0/区域管线差分和 OS 回归通过 | XL | — | 待实施 |
| X5 36 位物理地址/设备 | X3；最终合并 X4 | 高位 MMIO、4 GiB 以上的 RAM 重映射（总量 ≤ wasm32 可用）、DMA 地址宽度、快照 | L | R-x64-UP | 待实施 |
| XC x64 × 多核集成 | X4、X5、C3 | C2/C3 的矩阵在 x64 OS 上通过 | L | R-x64-SMP | 待实施 |
| A3 睡眠/休眠 | A2；S4 另需磁盘持久化策略；多核 S3 需 C3 | S4（OS 主导 soft-off + 恢复）与 S3 在单核/多核下闭环 | L | R-ACPI 完整 | 待实施 |
| W0 显式上下文 ABI | XC | ctx_ptr ABI、静态状态逐项归属；单线程行为与性能不回退 | XL | — | 待实施 |
| W1 宿主并行正确性 | W0、A3 | Worker/共享内存/同步内存模型通过验证 | XL | — | 待实施 |
| W2 并行性能/发布 | W1 | 真实并发和吞吐证据，兼容回退可用 | L | R-parallel | 待实施 |
| X6 超过 4 GiB 的 RAM 容量（可选） | X5 | Memory64/多 memory 后备、6–8 GiB 配置 | XL | — | 可选 |
| R1 总体验收 | 除 X6 外全部 | 各发布级的清单全绿 | L | 全部 | 待实施 |

规模表示相对复杂度，不是工期承诺。X2–X4、C1、C3、W0、W1 需要多个子阶段；先完成一个状态块切换切片和一个长模式微内核切片，再依据实测吞吐估算排期。不能以 agent 并发数线性折算交付时间。

推荐提交顺序：P0 → A1 → P1 → A2 → P2a → C0 → C1 → C2 → C3（`R-SMP32`），同时 X1 → X2 → X3 → X4 → X5（`R-x64-UP`）→ XC → A3 → W0 → W1 → W2 → R1。两条线的合并 owner 见 §7。新核数只有在 AP 启动完成后才向固件公布。

## 5. 各阶段实施任务与验收

### P0：冻结契约和可复现基线

**修改范围**：`docs/`、测试 manifest、CI/容器环境和工具脚本；不先改变 CPU 特性位。

- [ ] 记录 commit + 工作区 diff 摘要、Rust/LLVM/Node/浏览器/工具链版本、ROM/镜像 hash，保留当前改动。
- [ ] 建立能力矩阵：每项列出是否公布、模式、解释器/Tier-0/区域后端状态、规范出处、测试名、已知缺陷。
- [ ] 固定虚拟 CPU 身份与 CPUID/MSR 契约。保留 legacy profile 的已知兼容策略，新 profile 不沿用互相矛盾的 CPUID 签名/特性组合。
- [ ] 将验证程序独立于测试对象：指令用 QEMU TCG/参考模型核对，分页/异常用规范断言，ACPI 用表解析器及 ACPICA 工具，多核用结果校验和同步协议。不能仅让解释器与 JIT 互相认错。
- [ ] 建立 32 位功能、启动时间、固定工作量吞吐和内存占用基线；未通过的旧测试明确记录原因，不能在后续伪装成新功能通过。
- [ ] 定义关键风险原型：fw_cfg table-loader、可寻址 CpuContext、wasm32 高 RAM 分块、并行原子内存慢路径。每个原型形成结论和固定接口。

**退出条件**：另一 agent 从文档和 manifest 能复现至少一个 32 位 OS、一个 CPU fixture 和一个基准；每个后续阶段有指定测试入口及责任人。

### P1：平台数据、时间和测试设施

**修改范围**：`src/cpu.js`、`src/main.js`、`src/acpi.js`、PIT/RTC 接口、`tests/kvm-unit-tests/run.mjs`、Makefile；建议新增 `src/platform.js`、测试时钟。

- [ ] 从硬编码常量提取平台内存图、PM/SCI/GPE/PCI 资源，校验 I/O/MMIO 区间冲突；为未来 topology 保留唯一数据源，当前仍报告 1 核。
- [ ] 设备读时间统一经可注入入口（A1 已为 ACPI 做到）；完整的确定性机器时钟见 C0。
- [ ] runner 增加 ACPI、profile、cores、执行后端、ROM、超时参数；串口结构化 PASS/FAIL、预期用例数、非零失败退出码。没有运行到断言不能算通过。
- [ ] i386/x86_64 fixture 分开构建目录，避免同一个 kvm-unit-tests 配置相互覆盖；未支持的用例保留有原因的 skip。
- [ ] 新增物理内存导出/诊断接口，支持提取 RSDP/表、每核 RIP/CR3/APIC 状态和最后事件，方便处理启动超时。

**退出条件**：runner 能正确区分通过、失败、崩溃、超时和缺镜像；平台描述驱动的资源冲突检查通过。

### A1：ACPI fixed hardware 与电源事件

**修改范围**：`src/acpi.js`、I/O 注册、PCI PM 配置、VM 生命周期及公开 API。

- [x] 用具名寄存器定义 PM1_STS/EN/CNT、PM_TMR、GPE_STS/EN。按支持位处理 W1C/只读/保留位，覆盖声明宽度内的 byte/word/dword 访问及组合访问。
- [ ] →A2：PCI PM base（PMBA 0x40）、I/O decode enable（PMREGMISC 0x80）的读写与实际端口解码一致；固件改变基址时迁移映射并撤销旧映射。A1 仍固定解码 0xB000/0xAFE0，与 SeaBIOS 写入的值一致。
- [x] fixed event 状态和 enable 分离；任何状态、enable、SCI_EN 更新后重新计算 SCI。SCI 由有效 pending 条件保持电平，直到所有源清除/屏蔽。
- [x] 共享电平源：`CPU.set_shared_irq_level(irq, source, level)` 为 SCI 和每个 PCI INTx 保留独立 source ID，以 OR 聚合；PCI 记住自己拉高的线，客户机中途改 PIRQ 路由也降对的线；复位时像 PCIRST# 一样撤销全部源。独占线路的 ISA 设备仍直接调用 `device_raise_irq/device_lower_irq`。
- [x] PM timer 固定 3,579,545 Hz、24 位；bit 23 翻转锁存 TMR_STS（与 TMR_EN 无关）；单调，不随读取前进；快照恢复后从保存值继续计数。暂停期间随宿主时间前进（与 TSC 相同，C0 再统一）。
- [x] SMI_CMD（0xB2）的 ACPI_ENABLE/DISABLE 直接切换 SCI_EN；OSPM 对 PM1_CNT 的写入保留 SCI_EN。上电为 legacy 模式（SCI_EN=0），不再预置为 1。SeaBIOS 的 SMM 路径审计结论见 §2；改 SeaBIOS 配置留给 A2 的固件重建。
- [x] `SLP_TYP/SLP_EN` 按平台表解码：S5（0）与 S4（2，带 S4 标记）进入 soft-off；未实现的类型（S3 等）不关机，立即置 WAK_STS 使客户机不挂起。FADT RESET_REG 留给 A2（rev1 FADT 无此字段；0xCF9 复位已存在）。
- [x] fw_cfg `etc/system-states` 只公布 S5（S3/S4 在 SSDT 中被改名为 `XS3_`/`XS4_`）。
- [x] 电源按钮与 VM 状态：`power_button()` 对运行中的机器产生固定电源按钮事件；guest S5 发出 `acpi-power-off` 并停止模拟器；关机后 `power_button()` 或 `run()` 重新上电（等同 `restart()` 的复位路径，RAM 不清零）。`stop()`、`destroy()`、guest S5 语义分开。
- [x] 直接内核启动（`bzimage`）在每次复位时重新放置内核，否则 reboot/重新上电会跳进已被覆盖的内存（此前 `reboot-buildroot.js` 因此被禁用）。
- [ ] S5/复位前处理磁盘待写入和设备取消：未做。内存盘同步写入不受影响；异步/分块盘的写回策略随 A3 的 S4 一起处理。
- [x] 快照：ACPI state format 2 保存全部寄存器、timer 相位、SMI_CMD、GLBCTL 与 soft-off；CPU state[93] 保存共享线路的源集合；恢复在最后重新推导 SCI。旧格式（4 项）可导入：丢弃 SLP_EN 与失效的 GPE 状态字节。

固定寄存器、SCI、电源事件的语义按 [ACPI 硬件模型](https://uefi.org/specs/ACPI/6.6/04_ACPI_Hardware_Specification.html) 逐字段审阅，不把当前代码的行为当成规范。

**退出条件**：未 enable 时事件仍按规定锁存；先 pending 后 enable 能收到 SCI；两个同时 pending 的事件清掉一个后 IRQ 仍保持；SCI 和 PCI INTx 共用 IRQ9 时，按两种顺序清源，剩余源始终有效且 EOI 后能重触发；W1C/屏蔽/SCI_EN 切换无中断风暴；guest 发出 S5/reset 后宿主收到准确事件；计时/事件快照往返一致。

**实施记录（2026-09-27）**

- `make acpi-device-tests`（`tests/devices/acpi_device.js`，16 项，不运行客户机，注入时钟直接访问端口）：上面的退出条件逐项对应一个用例；共享 IRQ9 用例同时检查从 PIC 的 IRR（ELCR 置为电平）。“EOI 后重触发”只验证到“剩余源保持 IRR”，未由运行中的 CPU 实际应答。debug 与 release（`TEST_RELEASE_BUILD=1`）构建均通过。用五个变异（SCI 非电平、PM1_STS 普通写、读取推进 timer、SCI_EN 可写、恢复不连续）确认用例会失败。
- `make acpi-guest-tests`（`tests/devices/acpi_guest.js`，buildroot Linux 6.8）：在宿主侧从客户机内存解析 RSDP/RSDT/FADT/FACS/DSDT/SSDT/MADT（校验和、FADT 字段与仿真硬件一致、只公布 S5）；电源按钮恰好 1 个事件与 1 个 SCI；以 `acpi_pm` 为 clocksource 时客户机 3.03 s 对宿主 3.07 s；客户机 `reboot` 后重新启用 ACPI；`poweroff` → `acpi-power-off "S5"` → 模拟器停止 → `power_button()` 重新上电启动。`POWER_CYCLES=20` 连续 20 次关机/上电通过。
- 回归：`tests/api/{clean-shutdown,state,reset,reboot,pic}.js`、`tests/devices/virtio_console.js`（`acpi: true`）通过；Closure 的 `build/libv86.mjs`（SIMPLE）与 `build/v86_all.js`（ADVANCED）0 error、0 warning。
- 未覆盖：Windows ACPI HAL（本地无镜像）；IOAPIC 模式下的 SCI（该 Linux 使用 PIC 路由）；A2 的表生成、PMBA 解码、RESET_REG。

### A2：固件表、AML 与中断路由

**修改范围**：`bios/acpi/`、表生成工具、fw_cfg registry、SeaBIOS 构建脚本、`src/pci.js`、PIC/IOAPIC/LAPIC 单核路径。

- [ ] 固定工具链/SeaBIOS commit/config，产出 ROM hash；修正构建脚本对 clone/checkout 失败的处理，不使用未知本地源码继续构建。
- [ ] 实现并测试 fw_cfg 文件目录与 `etc/table-loader` 相关加载数据；所有字段显式处理字节序、长度和 selector，不能依赖宿主 TypedArray 字节序或错误缓冲区长度。
- [ ] 生成 RSDP、RSDT、XSDT、FADT、FACS、DSDT、必要 SSDT、MADT。对普通 SDT 和 RSDP分别检查校验和；FACS 单独验证签名/长度/对齐，不误套 SDT checksum 规则。
- [ ] ASL 中设备 `_HID/_ADR/_UID/_STA/_CRS` 对应真实硬件；PCI `_PRT`/链接设备与实际 PIRQ 路由一致，`_PIC` 若存在必须影响正确的路由模型。
- [ ] APIC 模式下 PIIX 的 PIRQA–D 到 IOAPIC 16–19 的直连未建模（A1 只保证 PIRQ 路由寄存器 bit 7 置位时不再误投到 ISA IRQ）；新表的 `_PRT` 与这里的实现必须一致。
- [ ] MADT LAPIC/IOAPIC/GSI/override/NMI 与仿真一致；PIC 与 APIC 模式切换不重复投递中断；补齐 SCI 使用的 level-trigger/EOI/remote-IRR 语义。
- [ ] 新表只公布平台描述中标为已实现的睡眠状态（A1 已通过 `etc/system-states` 在回退表上隐藏 S3/S4，A2 的表必须保持同一来源）；去掉未实现的 PCI/CPU 热插拔对象（回退 DSDT 的 `_E01`/`_E02` 访问 0xAE00/0xAF00 等未实现端口）。ACPI 模式切换、FACS global lock、FADT flags 均给出真实策略；不使用宿主 AML 解释器替代硬件。
- [ ] 过渡路径（可选）：回退构建器会加载 fw_cfg 的 `acpi/*` 文件并可替换 DSDT（`fill_dsdt`），可先用它验证 v86 生成的 AML；但 FADT 仍是 rev1、只有 RSDT，不能作为 A2 的完成形态。
- [ ] FADT rev3+ 公布 RESET_REG（0xCF9，值 0x06，已有实现）并置 RESET_REG_SUP；PM 基址跟随 PIIX4 PMBA（0x40）/PMREGMISC（0x80）解码，固件改基址时迁移端口。
- [ ] ACPICA `iasl` 编译/反编译，使用 `acpiexec` 检查适合离线求值的控制方法；涉及硬件 OpRegion 的行为由设备测试及 guest 运行验证。
- [ ] 在 guest 用 `acpidump` 保存表，核对固件分配的地址与 E820 reserved/ACPI reclaim/NVS，验证默认 ACPI 启动和 PCI 设备中断。

**退出条件**：单核 Linux/i386 和 Windows ACPI HAL 目标无需 ACPI 禁用绕路；无未解释的 AML 错误/SCI storm；电源按钮→OS 关机→S5、ACPI reboot 各循环至少 20 次。此时只标记 `ACPI-core`，A3 未通过前不宣布电源管理全部完成。

### P2a：布局单一来源与状态归属

**修改范围**：`global_pointers.rs`、`src/cpu.js`、`js_api.rs`、`wasm_builder.rs`、IR runtime/Tier-0/backend 中硬编码偏移的位置、`state.js`、测试中的偏移常量。

拆成四个顺序子任务，每个保持单核可运行：

1. [ ] 建立布局描述和生成器，产出 Rust 常量、JS accessor 与 JIT 常量，先替换 magic number，不同时改语义；包括测试中硬编码的寄存器、计数器偏移。
2. [ ] 状态归属表：`global_pointers.rs` 每个字段和 §2 列出的 Rust 静态变量（LAPIC、TLB、TSC 辅助量、x87 影子、JIT 状态等）标为“每核 / 每 Machine / 缓存（切换时丢弃）/ 只读”，生成器据此给出每核状态区的边界，并断言无字段遗漏。
3. [ ] 引入 GuestIP/Linear/Physical/HostOffset 类型，低 RAM 与 MMIO 从同一物理总线入口分派；DMA、固件、调试读写不能绕过代码页失效接口。（X1 的前提）
4. [ ] 提供新 snapshot schema、v6 导入器和版本校验；明确哪些是架构状态，哪些只是应丢弃的缓存。

**退出条件**：布局一致性检查通过；解释器、Tier-0、区域后端及至少两台独立 VM 回归；在测试钩子里创建两个上下文，用状态区换入换出交替执行，寄存器、FPU、TLB、异常、JIT 缓存无串扰。此阶段保持单核公开配置，不提前声称 SMP。原 P2 中的 ctx_ptr ABI 移到 W0。

### X1：64 位状态与解码

**修改范围**：CPU 寄存器/模式、`gen/x86_table.js`、解释器生成器、共享 decode/modrm/prefix、IR 前端类型和覆盖目录。

- [ ] 增加 16×u64 GPR、16×XMM、RIP、64 位 FS/GS base、GDTR/IDTR base、CR/DR/MSR；x87 指针及 FXSAVE 格式同步审计。
- [ ] 建立明确 `Real/VM86/Protected16/Protected32/Compatibility16/Compatibility32/Long64` 模式；将 operand/address/stack size 与 CPL、EFER、CS.L/CS.D 分开。
- [ ] 实现 REX 顺序规则和 8 位寄存器选择、R8–R15、RIP-relative、SIB、moffs64、imm64/imm32 sign-extend、默认操作数尺寸及 0x66/0x67；保留 15-byte 指令限制。
- [ ] 在 64-bit 子模式中，写 EAX 清零 RAX 高位，写 AX/AL 保留其他位；legacy/compat 模式及切换时的上半部行为另按规范测试，不能无条件复用清高位 accessor。REX 与 AH/BH/CH/DH 的规则覆盖到所有指令族。长模式无效编码精确 #UD，不能误执行 legacy opcode。
- [ ] 多页取指失败与错误优先级测试；编译解码和运行时解码使用同一模式规则，编译不能触发 MMIO/guest 异常。

**退出条件**：模式×前缀×地址形式 corpus 和独立 decoder 交叉检查；含全 1、高 32 位非零、canonical 边界的操作数不被截断。此时还不能将 LM 位公布给普通 OS。

### X2：长模式状态机、分页和异常

**修改范围**：`paging.rs`、`cpu/memory.rs`、系统/控制寄存器指令、描述符/异常交付、`ir/runtime/snapshot.rs`。

- [ ] 先实现微内核需要的最小 64 位解释器切片：寄存器/内存 MOV、基础算术、跳转、栈和控制寄存器操作，并配独立参考测试。X2 的系统验收依赖这个切片；X3 再补齐全部指令，不能等待 X3 完成后才具备运行 X2 fixture 的能力。
- [ ] 实现 EFER.LME/LMA/NXE/SCE、CR0.PE/PG、CR4.PAE、CR3、CS.L/CS.D 的合法迁移和 #GP；退出长模式、compat 模式和 legacy 模式均有往返测试。
- [ ] 实现四级 walker、4 KiB/2 MiB 页，明确拒绝未公布的页尺寸；累积 R/W、U/S、NX、A/D、CR0.WP 和 reserved-bit 检查。PAE/NX/物理高位共用一致规则。
- [ ] 替换 32 位线性页直接索引 TLB：使用有界 tag/set 或稀疏缓存，tag 含完整线性页、访问权限和地址空间 epoch；禁止按 48 位页号分配全量数组。
- [ ] canonical 检查、CR2、PF error code（包括 instruction fetch/NX）、页表项高位、跨页读写/栈/取指的异常和部分提交语义分别测试。#SS/#GP/#PF 的区分按实际操作规范处理。
- [ ] 长模式 IDT gate、64 位 TSS/RSPn/IST、IRETQ、特权级转换、NMI 阻塞/解阻塞、double fault/triple fault；不能沿用 32 位 task switch 作为 long-mode 中断机制。
- [ ] CR8/TPR、FS/GS/KERNEL_GS_BASE、STAR/LSTAR/SFMASK、APIC_BASE、TSC/MSR 策略同步实现；CSTAR 的读写/保留行为按选定 Intel profile 冻结，不套用 AMD 的 compat SYSCALL 入口。未知或保留位写入按选定 profile 故障，debug/release 行为一致。
- [ ] 运行时 walker 和编译代码快照共享无副作用的页表判定规则；编译快照不设置 A/D 位、不代替执行交付异常，并保留完整高物理页依赖。

**退出条件**：独立微内核能够进入/退出 long mode，触发并验证页故障/IST/NMI/CPL 转换，QEMU 对比的故障 RIP/向量/错误码/CR2/可见写入一致。x86 语义按 [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) 对应指令及系统章节逐项建立测试依据。

### X3：64 位解释器与 OS 闭环

**修改范围**：整数/分支/栈/string/bit/muldiv/atomic、FPU/SIMD、系统指令、CPUID、加载器与调试输出。

- [ ] 按覆盖矩阵补齐 profile 的所有长模式有效编码：64 位 FLAGS、shift/rotate、128 位乘除中间值、near/far 控制流、64 位栈、REP、LOCK、CMPXCHG16B 等。
- [ ] 实现 SYSCALL/SYSRET/SWAPGS，处理 non-canonical 目标、flags mask、用户/内核 GS、compat 返回；Intel profile 下 compat 中执行 SYSCALL 应 #UD，SYSRET 从 long64 返回 compat 的路径单独测试。旧 SYSENTER/SYSEXIT 及 INT 路径在新模式中的行为明确且有测试。
- [ ] XMM8–15、FXSAVE64/FXRSTOR64、MXCSR、对齐异常、x87/SSE 异常屏蔽语义可保存恢复。审计遗留 #DB/#TF/FPU 异常缺口；凡新 profile 依赖或公开的语义都必须补齐，不能用 `Readme` 的旧缺陷条目豁免。
- [ ] CPUID 0x80000000/01/08、地址位数、LM/NX/SYSCALL/CX16/LAHF 等与实现一致；调试/反汇编/trace 使用完整 RIP，unsupported MSR 不以 host panic 代替 guest fault。
- [ ] 优先走 BIOS 磁盘/ISO 引导，不要求 direct bzimage/ELF loader 先支持 x64；旧 direct loader 明确拒绝不支持的输入。后续若公布 x64 direct boot，另加协议测试。
- [ ] 在 `disable_jit: true` 下运行 x64 Linux：启动到自动测试脚本，运行 64 位程序、32 位兼容程序、系统调用、线程、mmap/mprotect、signals、文件/网络 I/O、重启/关机。兼容程序镜像必须包含对应内核选项和用户库。

**退出条件**：目标 profile 的解释器矩阵无未说明缺口，单核 Linux/x64 测试完成；独立 Windows x64 目标进入安装/运行验收。仅进入 shell 不能替代指令矩阵。

### X4：Tier-0 与区域 IR 全链路适配

**修改范围**：`ir/{hir,state,types,lowering,mir}.rs`、frontend/backend、tier0、helper registry、runtime 的 entry/cache/pages/snapshot/continuation 等。

- [ ] GPR16、XMM16、RIP64、FLAGS64 所需语义贯通 HIR、MIR、StateMap、materialization、helper ABI、Wasm locals；寄存器别名和 fault exit 高位全部保留。
- [ ] 先允许新指令用正确解释器 helper 执行，未支持的编译路径显式拒绝；再实现 Tier-0 原生模板及区域 lowering。helper 回退属于可接受执行路径，但每种编码必须有明确归属。
- [ ] mode key 不再只有 `default_32`：包含所有影响解码/执行的模式，或由 guard/epoch 显式保护；缓存入口、page key、物理 witness、RIP/线性地址不得用低 32 位碰撞。
- [ ] 更新 i64 FLAGS 折叠、移位边界、有符号/无符号比较、扩展/截断、phi copies、CSE/LICM/RAM forwarding 的证明；i64 DIV 的 Wasm trap 不能泄漏为 guest #DE 之外的 host 崩溃。
- [ ] 准入、链接、批量实例化、热度、SMC、restore、reset 和异步编译取消全部带新 ABI/模式/页 generation；旧模式产物不能在切换长模式后误进入。
- [ ] 同一 fixture 运行解释器、Tier-0、区域 Tier-1/2：比较提交点的完整架构状态、内存副作用、异常和 MMIO 顺序；再与独立参考核对。

**退出条件**：x64 高地址及兼容模式切换差分通过；32 位原有 IR suite 无新增回归；真实 OS 分别在默认 Tier-0 与 `ir_tier0:false` 下通过。不得只运行区域后端就宣布默认 JIT 支持 x64。

### X5：36 位物理地址与设备地址宽度

**修改范围**：GuestPhysicalMemory、TLB/JIT 快路径、fw_cfg/E820、DMA/IDE/virtio/PCI/调试 API、快照分块。

- [ ] 将容量、物理地址、后备块偏移分开。实现低 RAM、PCI hole、4 GiB 以上 RAM 的明确布局；把总容量和 fw_cfg/E820 高位写正确。
- [ ] RAM 重映射后，不存在的物理页、跨窗口操作有一致行为；低 RAM 快路径必须检查映射 generation，不能缓存过期宿主 view。
- [ ] 逐项审计设备地址宽度：32 位 DMA 设备保留其真实限制，64 位 virtio descriptor 地址必须正确处理高位；不能把设备全部强制扩为 64 位，亦不能忽略高位。
- [ ] RAM 的 CPU/DMA/debug/import 写入走相同代码页失效通知。高 RAM 的页表、代码、数据、MMIO、跨 4 GiB 边界各有 fixture。
- [ ] 快照、读取内存 API 和镜像导出支持分块，不构造单个超大 JS TypedArray/JSON 数组；所有大小计算审计 signed bitwise 操作。

**退出条件**：小内存 fixture 验证 >4 GiB 物理地址（高位 MMIO、重映射到 4 GiB 以上的 RAM 窗口、跨 4 GiB 边界），由 guest 写入校验、执行高地址代码、做 I/O 和快照恢复；配置总量超过 wasm32 可用范围时在启动前明确拒绝。

### X6（可选）：超过 4 GiB 的 RAM 容量

**修改范围**：GuestPhysicalMemory 后备（Memory64 或多 memory）、JIT 访存快/慢路径、快照分块、配置校验。

- [ ] 评估 Memory64 与多 memory 在目标浏览器/Node 的可用性和性能；记录结论后再选方案。
- [ ] 高 RAM 访问走新后备，低 RAM 快路径不退化；跨块访问、懒分配、宿主内存不足有一致行为。

**退出条件**：资源足够的 runner 上实际配置 6–8 GiB，由 guest 跨低/高 RAM 写入校验、执行高地址代码、做 I/O 和快照恢复。受限浏览器明确拒绝超资源配置，不把不能分配解释为架构不支持。

### C0：确定性机器时钟

**修改范围**：`src/main.js` 主循环、PIT/RTC/ACPI/LAPIC 定时器、TSC（`cpu.rs` 的 `read_tsc`/`tsc_offset`）、测试钩子。

- [ ] Machine 级时钟：正常模式跟随宿主单调时间；测试模式按已提交指令数推进，可注入。所有设备与 TSC 从它读时间，不再各自调用 `microtick()`。
- [ ] 规定暂停、后台节流、S3、快照恢复时的推进策略；宿主长暂停后的补发有上限并记录。
- [ ] 时钟只推进一次/每 Machine：多核轮转时 AP 的执行不重复驱动设备计时。

**退出条件**：同一镜像、同一输入和种子在测试模式下两次运行得到相同的 IRQ 序列、PM timer 读数和串口输出；正常模式下单核启动时间与 P0 基线无显著差异。

### C1：每核 LAPIC、AP 启动和中断路由

**修改范围**：`apic.rs`、`ioapic.rs`、`pic.rs`、CPU reset/HLT/interrupt、`src/main.js`/CPU slice 执行入口、Machine Scheduler/InterruptRouter、固件初始化。

本阶段在 32 位下完成，使用 SeaBIOS 回退表（MADT/SSDT 按探测到的 CPU 生成），不等待 A2 的 table-loader。

- [ ] **先落地最小解释器调度器**：`run_cpu_slice(core_id, budget)`、runnable/wait-for-SIPI/HLT 状态、轮转、统一 timer/event 服务。预算在完整指令或合法 REP 元素边界兑现，LOCK/隐式 XCHG 不可分割。C1 全程关闭 JIT；不能只创建 AP 状态而没有使 AP 获得执行时间的 runner。SeaBIOS 启动的忙等和 LOCK BTS 也在此 gate 内。
- [ ] 按 §3.1 第一步实现状态块换入换出（范围来自 P2a），切换点只在主循环安全点；先以测试钩子验证两核交替执行无串扰，再接入调度器。
- [ ] 每核独立 LAPIC/IRR/ISR/TMR/TPR/PPR/LVT/timer/APIC_BASE/MSR 状态（LAPIC 改为按核数组）；IOAPIC/PIC/外设属于 Machine。
- [ ] 明确 BSP reset、AP wait-for-SIPI、INIT assert/deassert、SIPI vector 和重复 SIPI 的规则；AP 从正确实模式入口运行，不通过宿主直接跳进内核函数。
- [ ] 实现 ICR destination/shorthand、physical/logical destination、fixed/lowest-priority/NMI/INIT/SIPI 和所需 ExtINT；不支持的保留编码遵循选定模型。
- [ ] 实现 EOI、remote-IRR、电平重触发、mask/unmask、优先级和每核 LAPIC timer；设备 IRQ 通过路由选择目标，不无条件交给 BSP。
- [ ] 32 位最小 trampoline 逐核写签名、发送回执 IPI，验证定向、广播、all-excluding-self、HLT 后唤醒、AP 重初始化。
- [ ] AP 能响应后才修改 fw_cfg 核数并运行真正 SeaBIOS 启动。其 [SMP 初始化](https://raw.githubusercontent.com/coreboot/seabios/rel-1.16.2/src/fw/smp.c) 会发送 INIT/SIPI 并等待核到达；单改数量可能使 BIOS 等待不结束。

**退出条件**：2/4/8 核 trampoline 均由客户机启动；每核 ID/寄存器/栈独立；IPI 延迟受预算约束；固件启动不靠减少其 expected CPU count 逃避失败。

### C2：单 socket 拓扑和有界轮转执行

**修改范围**：CPUID、平台描述、固件 MADT/SSDT/可选 SMBIOS、CMOS、main run loop、JIT budget。

本阶段用 32 位 OS、`disable_jit:true` 验收；多核配置在 C3 通过前不允许启用 JIT。x64 OS 上的同一矩阵由 XC 负责。

- [ ] 全部来源使用同一 `Topology { sockets:1, cores:N, threads_per_core:1 }`。CPU/APIC ID 稳定映射到 core ID；BSP 标志唯一。
- [ ] CPUID leaf 1 的 logical count/HTT、leaf 4 cache/core 信息、0xB/0x1F topology 与 profile 最大 leaf 一致；没有 SMT 不代表可以随意清除用于历史枚举的 HTT 位。逐个 subleaf 写预期输出测试。
- [ ] SMT 层 count=1，core/package 层报告 N；package ID 始终为 0。3 核用合适 ID 位宽，不能用 N 直接当 shift。所有核的 CPUID 只在该不同处不同。
- [ ] MADT 和 AML 各核对象 ID 与 CPUID 对齐；若生成 SMBIOS，Type 4 应反映一个处理器封装、N 核，不生成 N 个 socket。旧 MP table 只提供其能表达的信息，不能推翻 CPUID 拓扑。
- [ ] 扩展 C1 的调度器，在预算/事件边界轮转，处理忙等、长 REP 和 HLT；定义 JIT 自循环/跨页链接的预算接口，C3 完成一致性后才开启。设备计时每台 Machine 推进一次，AP 运行不重复调用全局设备 timer。
- [ ] 为所有核设置合理预算上限，并提供每核提交指令、运行时间、IPI 和 halt 计数诊断。

**退出条件**：Linux `lscpu` 显示 `Socket(s)=1`、`Core(s) per socket=N`、`Thread(s) per core=1`；`/sys/devices/system/cpu/*/topology` 一致；Windows 拓扑 API/系统工具同样确认。核绑定程序在所有核执行并得到独立进度，不能只检查 `/proc/cpuinfo` 条目数。

### C3：原子性、跨核 JIT 失效和全机恢复

**修改范围**：共享内存总线、atomic/fence 指令、IR 内存优化和安全点、页 generation、快照/复位协调。

- [ ] 将 C1 的解释器原子事务保证推广到所有 JIT 路径：LOCK、隐式锁定 XCHG、CMPXCHG8B/16B 不可分割；跨页/未对齐/MMIO 的故障和部分提交按指令契约处理。不得仅把 LOCK 当可忽略前缀。
- [ ] 明确 x86 内存顺序要求。轮转执行可采用更强的顺序作为正确性起点；IR 不能把跨核可能改变的 RAM load 在安全点前后永久复用，优化需要有效失效 guard。
- [ ] TLB 每核独立：本核 INVLPG/CR3 操作按规范生效，其他核通过客户机 IPI shootdown 刷新。不要让“任一页表写自动 flush 所有核”掩盖 shootdown 缺陷。
- [ ] 代码写入更新 Machine 级物理页 generation，通知所有相关 JIT。活动帧必须在保证的观察边界退出；待发布的旧快照编译结果被拒绝，table slot 只在安全回收后复用。
- [ ] **先通过多核 JIT 最小安全门槛再运行 OS**：每核状态隔离、LOCK 事务、所有核代码页失效、load 优化边界和异步发布校验的微测试全绿；之后开启 C2 预留的 JIT 预算/链接路径，并重跑 C2 的完整 OS/拓扑矩阵。
- [ ] 测试核 A 修改核 B 将执行的代码，按架构规定完成同步/序列化后 B 必须执行新代码；包含物理别名、DMA、自修改、恢复后异步编译回调，不要求未同步 SMC 有超出硬件的语义。
- [ ] stop/save/reset/S3/S5 协调全部核，清空或保留事件按类型区分。三重故障和 AP INIT 不混成同一个无条件全机重启操作，按平台策略测试。

**退出条件**：锁保护计数器、无锁队列/发布、TLB shootdown、跨核 SMC、信号/线程迁移、磁盘/网络压力运行通过；保存于 pending IPI/REP/HLT 状态后恢复结果一致。至少 10 个固定调度种子、多档 quantum 均通过；执行后端覆盖解释器、Tier-0、区域管线。

### XC：x64 × 多核集成

**修改范围**：状态区布局（X1 扩宽后的 16×u64 GPR、16×XMM 等）、C1 的换入换出、每核 MSR（FS/GS/KERNEL_GS_BASE、STAR/LSTAR/SFMASK、TSC_AUX）、固件表中的 x2APIC 前置检查。

- [ ] X1 扩宽后的状态区重新生成，换入换出覆盖新增字段；每核 MSR 与 SWAPGS 状态独立。
- [ ] AP 从实模式经保护模式进入长模式的全过程在每核独立完成；长模式下的 IPI、TLB shootdown、NMI 按 C1/C3 的测试重跑。
- [ ] Tier-0/区域后端在 x64 多核下的 SMC 与代码失效沿用 C3 的协议，并加入长模式地址的用例。

**退出条件**：C2/C3 的 OS 与一致性矩阵在 x64 Linux（含 32 位兼容进程）上通过；Windows x64 目标在有镜像时进入验收。

### A3：S3、S4 和 ACPI 最终闭环

**修改范围**：机器电源状态机、RTC/wake source、设备 quiesce/resume、FACS/AML、磁盘持久化、快照协调。

- [ ] S4 先行：在 PIIX4/SeaBIOS 模型中，OS 写入休眠映像后以 `_S4` 的 SLP_TYP 进入 soft-off（A1 已把该值当作带 `S4` 标记的关机处理），下次冷启动由 OS 自行恢复。emulator 侧工作是：关机后磁盘内容保留（含浏览器内存盘与 async/分块盘的写回策略）、冷启动路径正确、公开状态查询；验证后再在平台描述中公布 `_S4`。
- [ ] S3 按真实固件/OS 唤醒流程实现：进入时停所有核、保留 RAM；唤醒时 CPU 复位，SeaBIOS（`CONFIG_S3_RESUME`）读到 CMOS 0x0F=0xFE 后跳 FACS waking vector；设置 WAK_STS；保存/重建各类设备状态，BSP 恢复与 AP 再启动；分别验证 32 位和 64 位 OS 的实际唤醒入口形式。
- [ ] 全核停机屏障、RTC/电源按钮等公开 wake source、wake enable、WAK_STS 与 pending SCI 一致；S3 不使用“对所有核设置 HLT”代替。
- [ ] OS 主导 S4 完成 guest hibernate→磁盘写入/flush→power off→冷启动→OS 从磁盘恢复。不要用宿主 save_state/restore_state 模拟 S4；不支持 S4BIOS 就不公布对应能力。
- [ ] PM timer/TSC/RTC 在运行、暂停、S3、S4、snapshot restore 时采用 P1 已定义的策略；设备恢复不重复 IRQ、不丢完成事件、不触发时间回退。
- [ ] S3/S4 未通过时表中保持隐藏；通过后从同一 profile 打开，重跑 ACPI table/AML 验证，不仅修改 UI 标签。

**退出条件**：单核和多核、32/64 位目标 OS 的 S3 和 S4 各至少 20 次循环；恢复后用户程序内存校验、所有核在线、磁盘/网络/时钟/关机正确。此阶段通过后才具备本计划的完整 ACPI 电源契约。

### W0：显式上下文 ABI（宿主并行的前提）

**修改范围**：`global_pointers.rs` 的使用者、`cpu.rs`、`js_api.rs`、`wasm_builder.rs`、IR runtime/Tier-0/backend、helper import 签名、`call_indirect` 签名。

- [ ] 按 §3.1 第二步，把 CPU 状态访问从固定地址迁到 `ctx_ptr + field_offset`；生成代码、import、`call_indirect` 签名同步更新。
- [ ] P2a 归属表中所有“每核”静态变量迁入上下文；“每 Machine”的进入共享区并定义并发访问规则（W1 细化）。
- [ ] 单线程下的性能门槛：固定工作量基准（`make bench-quick`、XP 启动）相对 W0 前退化不超过 P0 约定阈值；超出时先剖析。

**退出条件**：C1–C3、XC 的全部测试在新 ABI 上通过；同一 Wasm 模块可以在两个独立状态基址上交替运行而无串扰。

### W1：宿主 Worker 并行的正确性

**修改范围**：专用 parallel Wasm 构建、Worker 启动与通信、共享 RAM、CPU runtime/allocator/SoftFloat、JIT imports、设备协调器。

这是独立的大阶段，不能以在 C2 上加 `SharedArrayBuffer` 视为完成。Wasm 的共享 memory 与原子操作有单独约束，需按照 [WebAssembly threads 设计](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md) 实现和测试。

- [ ] 先完成无 JIT 的 2 核原型：每 Worker 私有栈/allocator/runtime/SoftFloat 状态，共享客户机 RAM 与消息队列；禁止把完整 Rust 单核 memory 实例化 N 次后无差别共享其 heap/global。
- [ ] 定义共享内存访问 ABI。首版可用更强的顺序一致 atomics 保证标量访问；未对齐、跨页、16 字节 CAS、SIMD、MMIO 等采用受协调的慢路径。普通访问同样必须参与相关排他协议，单独锁住 LOCK 指令而其他核裸读写不能提供原子性。
- [ ] 审计 Rust 对共享 RAM 的所有访问，不能在别的 Worker 并发修改时通过普通引用/切片制造数据竞争；Wasm/JS 原子 helper、宿主消息边界和安全封装必须明确。guest 页表 A/D 更新也要并发安全。
- [ ] 原型通过后逐类开放 JIT 内存快路径，每次通过内存序 litmus、随机调度和独立结果验证；审计 LICM/CSE/forwarding 对并发观察的假设，不能照搬单核的 RAM 不变证明。
- [ ] 设备由一个协调器拥有。PIO/MMIO、DMA、IRQ、时钟和磁盘请求携带 vCPU ID/序号，通过有界队列同步/异步处理；不能在浏览器主线程阻塞等待，也不能形成“持全局锁等待设备，设备等待停核”的死锁。
- [ ] 每 Worker 实例化自己的 Wasm.Table/函数引用和 JIT runtime。只共享可传递的代码/元数据；发布核对全机 generation、模式和 topology，不能把一个 Worker 的函数索引当作另一个 Worker 的有效入口。
- [ ] SMC、reset、restore、S3、S5、debug pause 建立 stop-the-world rendezvous 与超时故障诊断；所有核确认退出活动帧后才能复用内存、回收代码和采集快照。
- [ ] 检测 secure context、cross-origin isolation、shared Wasm memory/Atomics 支持；记录 COOP/COEP 对资源加载的要求。环境不满足时 `auto` 返回轮转模式并可查询原因。浏览器要求参考 [SharedArrayBuffer 文档](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)。

**退出条件**：C3/A3 的同一套验收在真实并发下通过；另加入 fence/store-buffering、原子对齐/跨边界、A/D race、丢唤醒、SMC 发布竞争、设备队列溢出、Worker 异常退出/取消等测试。长期压力期间无死锁、丢 IRQ、撕裂的受保证原子值或 host panic。没有证明的快路径继续走正确慢路径。

### W2：性能与对外能力说明

- [ ] 以固定 guest 总工作量比较 1/2/4/8 核的 cooperative/parallel，覆盖计算、锁竞争、内存、I/O 四类；检查结果校验和，避免将增加工作量或不同算法当加速。
- [ ] 记录宿主物理核心数、浏览器/Node、冷/热 JIT、wall time、guest work、编译时间、CPU/内存占用和同步等待比例；trace 证明至少两个核执行区间重叠。
- [ ] 在预先固定且有至少 4 个可用宿主核心的 runner 上，以可并行 CPU workload 的 2/4 核吞吐显著高于单核为发布条件；P0 先约定噪声范围/阈值。不得要求所有负载随核心数线性加速，也不得无测量承诺加速倍数。
- [ ] 若全局内存锁或协调器成为瓶颈，按测量优化而不是放松原子语义。可只对经过证明的地址/指令开放快路径。
- [ ] API/类型/示例/UI/worker options/state version 更新一致；保留 legacy 默认和可观测回退。`acpi` 去 experimental 需 A3/R1 通过，新 x64/多核模式稳定需各自 gate 通过。

**退出条件**：有可重跑正确性和性能报告；客户机拓扑、宿主执行模式、限制和已验证 OS 都能从文档与 API 明确得知。

## 6. 测试矩阵、命令与发布门槛

### 6.1 测试矩阵

| 维度 | 必测集合 |
|---|---|
| CPU 模式 | real/VM86、protected 16/32、compat 16/32、long64；合法与非法模式切换 |
| 执行后端 | 解释器、默认 Tier-0、区域 Tier-1/2；编译拒绝/回退/恢复 |
| 拓扑 | 1/2/3/4/8 核，始终 1 socket、无 SMT；非法配置拒绝 |
| 内存 | 低 RAM、高虚拟地址、NX、页边界、MMIO、>4 GiB 物理页；6–8 GiB 容量与分块边界仅在选定 X6 时 |
| 中断 | PIC、IOAPIC、电平/边沿、LAPIC timer、IPI、NMI、INIT/SIPI、HLT 唤醒 |
| 生命周期 | cold boot、warm reset、S5、S3/S4、stop/run、save/restore、destroy、Worker 出错 |
| 并发 | cooperative 多种 quantum/种子、parallel 真并发、多个独立 VM 隔离 |
| 宿主 | Node 自动化；受支持 Chrome/Firefox/Safari 至少各一版本记录实际能力；不支持 parallel 的环境验证明确回退 |

每次小改动运行受影响测试和最小 32 位回归；阶段合并时扩大矩阵；发布时执行交叉组合。不能用全矩阵爆炸阻塞每个提交，也不能永久只测对角线。异常、模式切换、共享内存和恢复必须覆盖关键交叉项。

### 6.2 当前仓库已有命令

以下入口经 Makefile 静态核实，**本文未运行它们**。在 `v86/` 根目录执行；需按 `Readme.md` 安装 wasm32 Rust、匹配的 clang、Node、Java/Closure 等。nasm/gdb/32 位 libc/QEMU 相关测试宜在固定 Linux 容器运行；当前 macOS 宿主不能默认视为具备全部依赖。

```sh
# 构建与 CPU/IR 常规检查
make all-debug
make all
make rustfmt eslint ir-generated-check
make rust-test ir-tests ir-tier0-tests

# 有对应工具链/镜像后的阶段回归
make nasmtests nasmtests-force-jit jitpagingtests qemutests kvm-unit-test
make api-tests tests tests-release

# 现有固定工作量性能套件
make bench-quick
```

注意 `ir-tests` 不等于所有 IR 专项；按改动追加 `tests/Readme.md` 中的 memory/control-regs/FP/state/continuation 等目标。`devices-test` 当前被 `all-tests` 标注可能挂起，应先隔离加超时再纳入新 gate。`kvm-unit-test` 的旧集合也不能用来证明 APIC 或 x64 支持。

### 6.3 必须新增的验收入口

除标注“已实现”的两项外，以下名称是**待实现 Makefile targets**，不能在实施报告中写成现有测试：

| 建议目标 | 用途 | 首个责任阶段 |
|---|---|---|
| `platform-contract-tests` | 配置、布局、资源、CPUID/profile、固件一致性 | P0/P1/P2a |
| `acpi-device-tests` | 注入时钟、PM/SCI/GPE、按钮/复位（**已实现**，`tests/devices/acpi_device.js`） | A1 |
| `acpi-table-tests` | table-loader、RSDP/表校验、ASL、guest dump 对照 | A2 |
| `acpi-guest-tests` | ACPI OS 启动、表校验、电源按钮、S5/上电循环（**已实现**，`tests/devices/acpi_guest.js`，含 `DISABLE_JIT=1`）；S3/S4 循环待 A3 | A1/A3 |
| `x64-decode-tests` | REX/模式/取指边界/独立 decoder | X1 |
| `x64-system-tests` | long mode、MMU、异常、MSR、CPL/IST | X2 |
| `x64-differential-tests` | 指令参考结果、解释器与各 JIT 后端 | X3/X4 |
| `x64-guest-tests` | BIOS x64 启动、64/32 位程序和系统调用 | X3/X4 |
| `highmem-tests` | 高物理地址、4 GiB 以上重映射窗口、DMA、快照；容量属 X6 | X5/X6 |
| `multicore-boot-tests` | INIT/SIPI、IPI、真实 AP、固件拓扑 | C1/C2 |
| `multicore-coherence-tests` | 原子、TLB shootdown、SMC、量子/种子 | C3 |
| `multicore-state-tests` | 全核暂停/恢复/reset/睡眠、旧 state 导入 | C3/A3 |
| `multicore-parallel-tests` | shared memory、内存序、rendezvous、Worker 生命周期 | W1 |
| `platform-release-gate` | 聚合矩阵/基线差异/性能与兼容报告 | R1 |

复用现有 `tests/kvm-unit-tests/x86/{apic,ioapic,smptest,pae,syscall,msr}.c` 时，应先审计该旧版测试的断言、构建模式和平台假设；按 profile 选择或移植最小用例。QEMU TCG 是交叉参考，不把其所有实现细节视为规范；不同 CPU vendor 的特定行为要与选定 profile 对齐。

### 6.4 R1 发布验收清单

- [ ] 所有公开 feature 在能力矩阵中有实现路径、规范依据和通过的测试，无“暂时返回成功”占位。
- [ ] ACPI 固件/硬件/OS 三层闭环；无要求用户关闭 ACPI 的新 profile 安装流程。
- [ ] x64 OS、compat 用户态、异常、高地址（36 位物理地址）、所有默认执行路径闭环；超过 4 GiB 的容量仅在选定 X6 时验收。
- [ ] OS 确认 **一个封装、N 个物理核心、每核一个线程**；每核确实执行任务，核间同步正确。
- [ ] cooperative 和 parallel 的能力分别验收；后者有真实并发和可重复性能证据。
- [ ] S3/S4、快照、复位、设备 I/O 在多核 x64 下通过；旧快照兼容范围明确。
- [ ] DOS/Windows 9x/现有 Windows NT 系列/32 位 Linux 的关键回归与基线对比，无未解释的新增失败。
- [ ] 单核性能回归超过 P0 固定阈值时有剖析和处理；建议以固定工作量中位数退化 >10% 触发调查，正确性错误为零容忍。
- [ ] 测试报告含工具链、ROM/镜像 hash、命令、种子、日志、耗时和 skips；缺环境/镜像的项目标记未验收，不能勾选完成。

## 7. 多 agent 的实施规则与交接格式

可以并行的分工：平台/ACPI agent 负责 P1/A1/A2/A3，CPU/内存 agent 负责 P2a/X1–X3/X5，编译器 agent 在布局冻结后负责 X4，SMP agent 负责 C0–C3，XC 由 CPU 与 SMP 两条线的 owner 共同合并。W0/W1 集成时再拆上下文 ABI/Worker/原子内存/设备协调器。测试 agent 可提前独立制作 guest fixture 和参考结果。

以下文件是高冲突区域：`src/cpu.js`、`cpu.rs`、`global_pointers.rs`、`paging.rs`、`state.js`、`ir/state.rs`、`ir/runtime/cache.rs`、Makefile。每阶段指定一个合并 owner；其他 agent 用冻结接口或独立文件提交，不能同时各自重定义上下文布局。

每次只领取一个阶段或其中一个有明确 gate 的子任务。接手 agent 必须先复核当前源码，本文的基线不是允许覆盖后续改动的理由。每次提交/交接包含：

```text
阶段/子任务：
基线 commit 与相关工作区变更：
前置 gate 的证据：
本次契约/接口改动：
修改文件与关键设计：
实际运行的命令、环境、fixture hash/seed：
通过/失败/跳过（及原因）：
32 位/单核兼容性与性能影响：
尚未公开的能力、阻塞项、下一步：
回退方式与 state/ABI 兼容范围：
```

阶段产物建议保存在 `docs/validation/platform/<阶段>/`；大型镜像/trace 放构建产物存储，仅提交 manifest 和校验值。每阶段都要同时更新能力矩阵；不能仅更新“进度 100%”而没有验收证据。

实施时优先保护五个不变量：**公布的能力真实存在；地址高位不丢失；CPU 状态按核隔离；共享内存和代码失效有完整协议；恢复点保留精确架构状态。** 任何阶段破坏这些不变量，都应停止扩大 feature 开关并先修复。

## 8. 规范与代码阅读索引

- [当前 IR 架构](ir-design.md)、[现有测试说明](../tests/Readme.md)、[现有 CPU 基准说明](cpu-benchmarks.md)：以当前 fork 的实现为准。
- [ACPI 6.6 硬件模型](https://uefi.org/specs/ACPI/6.6/04_ACPI_Hardware_Specification.html)、[软件模型和表](https://uefi.org/specs/ACPI/6.6/05_ACPI_Software_Programming_Model.html)：寄存器、事件、固件契约。
- [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)：指令、模式、分页、中断、APIC、内存排序；P0 保存采用的具体文档修订号。
- [AMD64 APM Vol.2](https://docs.amd.com/v/u/en-US/24593_3.44_APM_Vol2)：长模式系统行为的交叉阅读；不能将 vendor 差异混用进同一 profile。
- [Intel 拓扑枚举示例](https://github.com/intel/SDM-Processor-Topology-Enumeration)：socket/core/thread 枚举验证。
- [SeaBIOS 1.16.2 biostables](https://raw.githubusercontent.com/coreboot/seabios/rel-1.16.2/src/fw/biostables.c)、[SMP 初始化](https://raw.githubusercontent.com/coreboot/seabios/rel-1.16.2/src/fw/smp.c)、[fw_cfg](https://www.qemu.org/docs/master/specs/fw_cfg.html)：当前固件接入路径。
- [WebAssembly threads](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md)：宿主共享内存和原子执行的实现约束。
