# v86：完整 ACPI、x86-64 与单路多核心实施计划

> 状态（2026-09-29 更新）：**A3 通过**（S3 挂起到内存与 OS 主导的 S4 在 32 位 Linux 1/2/4 核 JIT、1/2 核解释器、宿主并行 4 核，以及 x86_64 Linux 1/2 核各 20+20 次循环）；**W0 通过**（每实例重定位 + 低地址状态槽位的并行构建，轮转套件 11/11 在其上通过，默认构建不变）；**W1 通过**（AP 在 vCPU Worker 中与 BSP 真并发，解释器/Tier-0/区域 IR/x64 页层都可在 Worker 中运行；litmus、生命周期与故障注入、C3 OS 压力 30/30、A3、x86_64 Alpine 2/4 核、无头 Chrome）；**W2 取得性能证据**（4 核 compute/memory/io 为 1 核的 1.6–2.5 倍，默认仍为轮转）；**X6 已实施**（扩展 RAM：宿主存储 + 帧缓存，6 GiB fixture 通过）；**R1 入口**（`make platform-release-gate`、[能力矩阵](validation/platform/capability-matrix.zh-CN.md)）；x64 页层新增 SSE ADD/SUB/MUL/DIV 模板；nasm 测试可在无 gdb 的宿主上以 QEMU 生成参考。未关闭：Windows 的 S3/S4 与宿主并行验收、DOS/Win9x 回归（无镜像）、4 核 poweroff 间歇问题的根因。
> 此前（2026-09-28 晚）：C0/C1 的实现与门槛已通过（C0 性能复测：x64 工作使 32 位启动回退到 1.148，定位并修正解释器取指/内存热路径后为 1.095，通过 10% 门槛，见 [C0 记录](validation/platform/C0/normal-up-final.zh-CN.md)）；C2 每核指标、三后端 Linux 拓扑与 **Windows 8.1 x64 1/2/4 核拓扑/逐核执行**已通过；C3 原子/内存序、debug/release Linux OS 压力矩阵已通过，S3（依赖 A3）与长期 soak 未关闭。X1 解码已对整个长模式 opcode map 做独立对照；X2 系统用例 66 个 QEMU 差分 + 14 个 SDM 断言 + 长模式三重故障，release 构建配对通过；X3 的 opcode 执行矩阵（349,888 个编码）0 不一致，direct loader 明确拒绝 64 位输入；**X4 x64 页层（每 4 KiB 长模式代码页一个 Wasm 函数，含 SSE 模板）使 Alpine x86_64 1/2/4 核启动由解释器的约 16/85/140 min 降到约 1.3/1.9/2.1 min，兼容模式代码经 32 位 IR 编译；x64 区域管线第一版不实施**；X5 高 RAM 上的代码/页表/SMC、v86gl 高地址、IDE 48 位寻址与分块快照流通过。**XC：真实 x86_64 Linux（Alpine 3.24，Linux 6.18）在 1/2/4 核页层与 1/2/4 核解释器下通过 64/32 位探针与 XC 矩阵，virtio-net 收发在 1 核解释器与 1/2/4 核页层下通过，页层下另通过整机快照（含 V7 分块流）与 reboot/poweroff(S5)；Windows 8.1 Pro x64（用户镜像，只读）在 v86 中启动到桌面，1/2/4 核下 64 位与 WOW64 探针均通过**（修正了兼容模式下截断 64 位 GDTR 基址的缺陷），见 [XC 记录](validation/platform/XC/linux64-boot.zh-CN.md)。仍不向普通配置公布 LM。详见各阶段记录。
> 基线：2026-09-27，`8af0560e`（PR #55 合并后，工作区干净）。原稿基线 `dfd8ac23 + 未提交修改` 已过时。
> 本轮 review/推进的实际接手点为 `8edd6d69 + 未提交修改`；验证环境和 fixture 见 [C1 记录](validation/platform/C1/review-and-validation.zh-CN.md)。
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
8. 每阶段增加实施状态；A1、A2 已按本版实施并通过 §5 中列出的测试（Windows 目标因无镜像未验收）。

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
| 固件表来源（A2 之前） | 未提供 `etc/table-loader`，SeaBIOS 1.16.2 走 `acpi_setup()` 回退：RSDP v0 → 仅 RSDT（无 XSDT）、FADT rev1（无 RESET_REG/X_ 字段）、FACS、内置 DSDT、SSDT（`ssdt-misc` + 每 CPU Processor + PCI 热插拔）、MADT（按探测到的 CPU 生成） | 64 位 Windows 等需要 XSDT/FADT rev3+ 的目标必须换表路径（A2）；32 位 SMP 的 MADT 可暂用回退表（C1） |
| FADT 契约（A2 之前的回退表） | SCI=9，SMI_CMD=0xB2，ACPI_ENABLE/DISABLE=0xF1/0xF0，PM1a_EVT=0xB000(4)，PM1a_CNT=0xB004(2)，PM_TMR=0xB008（24 位），GPE0=0xAFE0(4，16 个 GPE)；flags=WBINVD\|PROC_C1\|SLP_BUTTON\|RTC_S4\|USE_PLATFORM_CLOCK | PWR_BUTTON=0 即公布**固定电源按钮**；FIX_RTC=0 即公布 RTC_STS/RTC_EN；A1 必须实现这些位 |
| SeaBIOS 与 table-loader | 存在 `etc/table-loader` 时 SeaBIOS 把 PM 基址从 0xB000 移到 **0x600**（`paravirt.c`），写入 PIIX4 PMBA，并用 0x608 的 PM timer 作自身计时；执行 loader 后解析 DSDT（`CONFIG_ACPI_PARSE`），找不到 `PNP0303` 就不初始化 PS/2 | A2 的 PM 块必须跟随 PMBA 解码，表按固件实际写入的基址生成；DSDT 必须含 SeaBIOS 能识别的键盘设备 |
| 回退表与 v86 硬件不符之处 | 回退 DSDT 按 QEMU 布局写死 PM 在 00:01.3、VGA 在 00:02.0（v86 是 00:07.0、00:12.0）；COM2 的 `_STA` 读不存在的 00:01.3 得 0xFF，未配置 uart1 也报告 COM2 存在；链接设备 `_PRS` 含 IRQ 5，MADT 把 IRQ 5 设为电平，而 v86 的 SB16 在 IRQ 5 用边沿；含 PCI/CPU 热插拔和 16 个空 GPE 方法 | A2 的表只描述 v86 实际存在的设备和路由 |
| 0xCF9 复位 | 原实现把 0xCF9 字节写与 0xCF8 双字配置地址的第 2 字节共用一个处理函数，并用“先 bit1 后 bit1+2”判断复位 | 单次写 0x06（FADT 复位寄存器）不复位；连续两次配置地址访问若第 2 字节恰为 0x02、0x06（function 2 后接 function 6）会误复位 |
| 睡眠状态 | 回退 SSDT 从 fw_cfg `etc/system-states` 取值；v86 未提供时默认 `{128,0,0,129,128,128}`：`_S3_`=1，`_S4_`=0，`_S5_`=0（三者都在 SSDT 的 `ssdt-misc` 中，隐藏时首字符改为 X，即 `XS3_`/`XS4_`） | 原实现公布 S3 却未实现（客户机进入后永久等待 WAK_STS）；S4 与 S5 同值 |
| ACPI 设备（原实现） | [`src/acpi.js`](../src/acpi.js) 硬编码 PM1 `0xB000..`、PM timer `0xB008`、GPE `0xAFE0..`；只注册部分访问宽度；PM1_CNT 写入仅保存值；GPE 是裸字节 | 探针：`poweroff` 后 PM1_CNT=`0x2000`（S5 请求）而 VM 继续运行；OS 向 GPE0_STS 写 1 清除后读回 `0xFF` |
| SCI | 原 `timer()` 仅在 enable 时锁存 TMR_STS，否则每轮调用 `device_lower_irq(9)` | SCI 不是按 pending 条件保持的电平；也会清掉共用 IRQ9 的其他源 |
| 中断线共享 | [`src/pci.js`](../src/pci.js) 的 `lower_irq` 在降线时重新计算 PIRQ 路由并直接清整条线 | 共享线上清一个源会清掉其他源；OS 在线路有效时改 PIRQ 路由会降错线 |
| SMM | SeaBIOS `CONFIG_USE_SMM` 的重定位写 0xB2 后轮询 0xB3，v86 的 0xB3 读固定返回 0，所以 SMI 处理程序从未运行；`GLBCTL`（0xB028）未实现 | SMI_CMD 的 ACPI_ENABLE/DISABLE 必须由设备直接处理，不能依赖 SMM |
| 时间/恢复 | 所有设备计时都用 `v86.microtick()`；TSC 通过 `set_tsc` 在恢复后连续；原 PM timer 每次读取最多额外前进 1 ms，快照不保存相位 | A1 只需让 PM timer 与 TSC 同策略；确定性时钟属于 C0。SeaBIOS 用 PM timer 作自身计时源（`pmtimer_setup`），改动会影响 POST |
| 固件构建 | [`bios/fetch-and-build-seabios.sh`](../bios/fetch-and-build-seabios.sh) 固定 `rel-1.16.2`；`git clone ... \|\| true` 会在已有目录上继续；config 打开 ACPI/DSDT/MPTABLE/S3_RESUME/SMM/TCGBIOS | 必须审计实际生成表和固件路径，config 开启不代表 emulator 已实现 |
| 核数输入 | 原为 `src/cpu.js` 中写死的 `FW_CFG_NB_CPUS/MAX_CPUS`=1、`CMOS_BIOS_SMP_COUNT`=0；P1 起三者与 MADT 都取自 `platform.cores`（仍为 1） | CPUID 尚未接入，C2 完成 |
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

普通用户的 CPU 配置只需要设置核心数。`cpu_profile` 和 `cpu_execution` 不作为新增公开配置；原先列出的两项只是计划草案，尚未进入运行时 API，现在从公开接口设计中移除。

```javascript
{
    cpu_cores: 4,                    // 客户机可使用 4 个核心
    acpi: true,                     // 当前多核实现所需的平台配置
    memory_size: 1024 * 1024 * 1024
}
```

CPU 型号、执行策略和测试控制分别由内部管理：

- **CPU 能力与兼容版本**：内部 profile 固定客户机可见的 CPUID、指令集、MSR 和固件契约，并作为快照兼容元数据保存。新机器使用经过验收的默认能力；恢复快照保留原能力契约，不因宿主变化、核心数变化或升级而悄悄暴露不同指令集。当前单核 legacy 与多核 smp32 的选择由实现负责，用户无需输入版本名。后续 x64 的默认开放仍须通过对应发布门槛。
- **宿主执行策略**：由实现根据已发布能力、宿主支持和资源条件自动选择。当前仅实现有界轮转；W0–W2 并行后端通过验收后，才能纳入内部选择。缺少并行支持时仍向客户机提供请求的 N 个核心，以轮转方式运行，不减少核心数。用户无需选择 cooperative、parallel 或 auto。
- **测试和诊断**：强制某个后端、固定 quantum/种子、确定性时钟等仅用于开发与可复现测试，不进入普通用户的必填配置或设置界面。测试显式要求并行时，环境不满足必须失败或按测试规则报告 SKIP，不能回退后把结果算作并行验收。实际后端和回退原因可从只读诊断中查询，普通界面使用容易理解的状态说明。

沿用 `cpu_worker` 表示既有的 VM 宿主放置方式，不将其改为客户机核心数，也不要求用户为了使用多核而另外配置它。非法组合在启动前报错，例如当前多核却显式关闭必需的平台中断能力、超测试上限的核心数。是否将多核所需的平台能力默认启用，作为单独的兼容性变更评估，不因本节接口简化而改变现有运行行为。

新快照保存内部 profile/能力版本、拓扑、内存图/分块索引、所有 CPU 架构状态、LAPIC/IOAPIC、队列、时间和设备状态。暂停所有核并确认无活动 JIT/helper 帧后采集；保留每核客户机 TLB 翻译语义，恢复时重建宿主指针、JIT 和宿主句柄。宿主执行策略不成为用户需要匹配的客户机配置，跨后端恢复必须先通过状态兼容验证。

升级 state version；为明确支持的旧 v6 单核快照提供到内部 legacy profile 的导入器，其他版本/不兼容拓扑在修改 VM 前拒绝。不能把旧 8×32 位数组直接解释为新 16×64 位状态，也不能把保存时的 4 核状态恢复到 2 核后丢掉 AP。

## 4. 阶段与依赖

| 阶段 | 前置条件 | 交付/退出条件 | 规模 | 发布级 | 状态 |
|---|---|---|---|---|---|
| P0 基线和契约 | 无 | 可复建测试环境、profile、能力矩阵、基线报告 | M | — | 部分（本次记录基线） |
| A1 ACPI fixed hardware | P0 | PM/SCI/GPE/SMI_CMD/按钮/S5 设备测试与 Linux 客户机测试通过；S3/S4 隐藏 | M | R-ACPI | **已实施** |
| P1 平台描述/测试入口 | P0 | 共用平台描述、带超时和结构化结果的 runner、诊断导出 | L | — | **已实施**（确定性时钟归 C0） |
| A2 固件表/路由闭环 | A1、P1 | table-loader 安装的表（含 XSDT、FADT rev3+ RESET_REG）、AML 与设备资源一致 | L | R-ACPI | **已实施**（Windows 未验收） |
| P2a 布局单一来源 | P0 | 生成的 offset/accessor、状态区归属表与断言；单核行为不变 | L | — | **已实施**（子任务 3、4 随 X1） |
| C0 确定性机器时钟 | P1 | 可注入/可按指令推进的时钟；PIT/RTC/LAPIC/PM/TSC 同源；固定输入得到相同 IRQ 序列 | M | — | **已通过**（2026-09-28 release 复测启动比例 1.095 ≤ 1.10；修正了 x64 工作带入 32 位热路径的回退） |
| C1 每核 LAPIC/AP 启动 | A1、P2a、C0 | 状态块换入换出、按核 LAPIC、INIT/SIPI/IPI；32 位 trampoline 与 SeaBIOS 在 2/4/8 核启动 | XL | — | **已实施**（含 ExtINT/APIC enable/NMI/EOI，2/3/4/8 核固件门槛） |
| C2 单路拓扑/轮转 | C1、A2 | 32 位 Linux 识别 1×N×1，各核执行任务（解释器） | L | — | **实现完成，Linux 已验收；Windows 8.1 x64 1/2/4 核报告 1 package × N cores × 1 thread 并逐核执行（见 XC）** |
| C3 跨核一致性/JIT | C2 | 原子、TLB shootdown、SMC、快照；Tier-0/区域后端在多核下通过 | XL | R-SMP32 | **主要门槛已通过**（原子跨页/MMIO 三后端、Linux 三后端负载/恢复/重启/S5、Windows x64 2/4 核 SMP）；S3（A3）与长期 soak 未关闭 |
| X1 64 位状态/解码 | P2a | 模式矩阵、REX/寄存器/地址尺寸单测通过 | L | — | **已通过**（宽状态 bank；33,088 个地址形式 + 349,888 行整个长模式 opcode map 与 iced-x86 独立对照一致） |
| X2 MMU/异常/系统状态 | X1 | 长模式切换、分页/NX/异常帧测试通过 | XL | — | **已通过**（66 个 QEMU 差分 + 14 个 SDM 断言 + 三重故障：离开/重进长模式、异常优先级、#DF 经 IST、NMI 阻塞、CR8/TPR、APIC_BASE、SYSEXIT、高于 4 GiB 的 GDT；debug/release 配对） |
| X3 64 位解释器闭环 | X2、A2 | 单核 x64 OS + 32 位进程，无 JIT 正确运行 | XL | — | **OS 门槛已通过**（Alpine x86_64 1 核解释器：64/32 位探针、XC 矩阵、reboot 与 poweroff 到 S5；1,552 整数 + 958 向量用例（QEMU 差分为主，少数 SDM 断言）；opcode 执行矩阵 0 不一致；virtio-net 原始帧收发）；Windows 8.1 x64 启动到桌面并通过 64 位与 WOW64 探针（页层，见 XC） |
| X4 IR 各层 x64 | X3 | 解释器/Tier-0/区域管线差分和 OS 回归通过 | XL | — | **Tier-0 级已通过**（x64 页层 + SSE 模板：差分模糊、系统/SMC/别名场景、1/2/4 核 Linux、Windows；兼容模式代码经 32 位 IR 编译；32 位 IR suite 无回归）；x64 区域管线第一版不实施（理由见 X4 实施记录） |
| X5 36 位物理地址/设备 | X3；最终合并 X4 | 高位 MMIO、4 GiB 以上的 RAM 重映射（总量 ≤ wasm32 可用）、DMA 地址宽度、快照 | L | R-x64-UP | **主要门槛已通过**（36 位物理总线、VirtIO/IDE/DMA/v86gl、整机快照（V7 分块流）；`high_memory_size` 经 SeaBIOS E820 交给 OS；4 GiB 以上的代码/页表/SMC 在解释器与页层下通过；IDE 48 位寻址修正） |
| XC x64 × 多核集成 | X4、X5、C3 | C2/C3 的矩阵在 x64 OS 上通过 | L | R-x64-SMP | **Linux 矩阵已通过**（1/2/4 核页层与 1/2/4 核解释器：拓扑、迁移、跨核信号/SMC、TLB shootdown、O_DIRECT；网络在 1 核解释器与各核数页层；页层下另有整机快照与 reboot/S5）；**Windows 8.1 x64 1/2/4 核通过**（拓扑 API、逐核亲和、APIC ID、4 GiB 以上分配、WOW64） |
| A3 睡眠/休眠 | A2；S4 另需磁盘持久化策略；多核 S3 需 C3 | S4（OS 主导 soft-off + 恢复）与 S3 在单核/多核下闭环 | L | R-ACPI 完整 | **已通过**（32 位 Linux 1/2/4 核 JIT、1/2 核解释器、宿主并行 4 核，x86_64 Linux 1/2 核页层：各 20 次 S3 + 20 次 S4；`_S3`/`_S4` 经 ACPICA 验证；见 [A3 记录](validation/platform/A3/sleep-hibernate.zh-CN.md)） |
| W0 显式上下文 ABI | XC | ctx_ptr ABI、静态状态逐项归属；单线程行为与性能不回退 | XL | — | **已通过**（以“每实例重定位 + 低地址状态槽位”代替 ctx_ptr 参数：同一模块两个状态基址交替运行无串扰，C1–C3/XC 轮转套件 11/11 在并行构建上通过，默认构建不变；见 [W0 记录](validation/platform/W0/context-abi.zh-CN.md)） |
| W1 宿主并行正确性 | W0、A3 | Worker/共享内存/同步内存模型通过验证 | XL | — | **已通过**（vCPU Worker 真并发，解释器与三种 JIT 层；litmus/IPI 唤醒、生命周期与故障、C3 OS 压力 30/30、A3 20+20 次、x86_64 Linux 2/4 核、Chrome 下 module Worker；见 [W1 记录](validation/platform/W1/parallel-correctness.zh-CN.md)） |
| W2 并行性能/发布 | W1 | 真实并发和吞吐证据，兼容回退可用 | L | R-parallel | **性能证据已取得**（固定工作量 1/2/4/8 核：计算/内存/I/O 4 核 1.8–2.6 倍于 1 核；锁竞争负载不扩展；`"auto"` 策略与回退；默认仍为轮转，见 [W2 记录](validation/platform/W2/performance.zh-CN.md)） |
| X6 超过 4 GiB 的 RAM 容量（可选） | X5 | Memory64/多 memory 后备、6–8 GiB 配置 | XL | — | **已实施**（驻留帧缓存方案，`extended_memory_size`；6 GiB fixture 在 4 MiB 帧池下通过，含快照；Linux 结果见 [X6 记录](validation/platform/X6/extended-memory.zh-CN.md)） |
| R1 总体验收 | 除 X6 外全部 | 各发布级的清单全绿 | L | 全部 | **入口已实现**（`make platform-release-gate` 按发布级运行并出报告；[能力矩阵](validation/platform/capability-matrix.zh-CN.md)）；清单状态见 §6.4 |

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

- [x] [`src/platform.js`](../src/platform.js)：PM/GPE/SMI_CMD/SCI、复位寄存器、LAPIC/IOAPIC、PCI 链接 IRQ、睡眠状态、UART/LPT、PCI 内存窗口与核数的唯一来源；`check_platform` 检查固定 I/O 区间（含固件写入的 PM 基址）无重叠；ACPI 表、fw_cfg 核数、CMOS SMP 计数都从它取值，debug 构建断言描述中的端口都有设备。设备实例化仍在 `cpu.js`（Closure ADVANCED 要求 `devices.uartN` 以固定属性名访问）。
- [ ] （转 C0）设备读时间统一经可注入入口（A1 已为 ACPI 做到）；完整的确定性机器时钟见 C0。
- [x] [`tests/kvm-unit-tests/run.mjs`](../tests/kvm-unit-tests/run.mjs)：`--acpi`、`--memory`、`--timeout`、`--expect-pass N`（exit 0 但 PASS 少于 N 算失败）、`--quiet`，执行后端与构建沿用 `DISABLE_JIT`/`TEST_RELEASE_BUILD`；退出码区分通过 0、失败 1、崩溃 2、超时 3、缺文件 4，最后一行 `RESULT ...` 可机读，超时时附诊断快照。`cores`/`profile` 在 C1/X1 实现时加入。
- [x] [`tests/kvm-unit-tests/build.sh`](../tests/kvm-unit-tests/build.sh) 在 `build/kvm-unit-tests/<arch>/` 树外构建；macOS 上无需安装任何工具：clang 的 `<arch>-linux` 目标、Rust 自带的 `rust-lld`/`rust-objcopy`、带 ELF 符号索引的 GNU 格式 `ar`（`v86/ar.py`）、代替 libgcc 的 64 位除法（`v86/builtins.c`）。为 clang 对上游测试源码做了三处最小修改（两个定义全局汇编标号的函数加 `noinline`，两条歧义指令加后缀，一个 `"=rm"` 约束改 `"=r"`），`realmode.c` 用 `-m16` 构建。
- [x] `CPU.get_diagnostics()`/`V86.get_diagnostics()`（Worker 模式经 RPC）：CPU 模式、CS:EIP、CR0/3/4、EFLAGS、HLT，LAPIC（ID、使能、TPR、IRR/ISR、LVT），PIC，共享 IRQ 源，ACPI 设备寄存器，以及按 OS 的方式从内存定位的 ACPI 表（`locate_acpi_tables`，含校验和）。物理内存读取沿用已有的 `read_memory`。每核条目随 C1 加入。

**退出条件**：runner 能正确区分通过、失败、崩溃、超时和缺镜像；平台描述驱动的资源冲突检查通过。

**实施记录（2026-09-27）**：`make kvm-unit-test`（realmode 127 PASS、taskswitch、taskswitch2 11 PASS）与新增的 `make kvm-unit-test-apic`（`--acpi`：ioapic 19 PASS、smptest 1 PASS）在 macOS 上用新构建方式通过；release 目标同样改用树外路径。`apic.flat` 基线为 8 PASS/3 FAIL/1 SKIP，3 个失败都是 `apic_disable`（经 IA32_APIC_BASE 关闭后 CPUID.1:EDX.APIC 不清零、重新开启后不报告已使能），归入 C1，暂不进门槛。强制超时时 runner 输出诊断快照并以 3 退出；ACPI 客户机测试在两种 Linux 上断言了诊断内容（保护模式+分页、PM 基址、SCI_EN、五张表及校验和、APIC ID）。

### A1：ACPI fixed hardware 与电源事件

**修改范围**：`src/acpi.js`、I/O 注册、PCI PM 配置、VM 生命周期及公开 API。

- [x] 用具名寄存器定义 PM1_STS/EN/CNT、PM_TMR、GPE_STS/EN。按支持位处理 W1C/只读/保留位，覆盖声明宽度内的 byte/word/dword 访问及组合访问。
- [x] （在 A2 完成）PCI PM base（PMBA 0x40）、I/O decode enable（PMREGMISC 0x80）的读写与实际端口解码一致；固件改变基址时迁移映射并撤销旧映射；PCIRST# 恢复默认（不解码）。
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
- 未覆盖：Windows ACPI HAL（本地无镜像）。IOAPIC 模式下的 SCI、表生成、PMBA 解码、RESET_REG 已在 A2 覆盖。

### A2：固件表、AML 与中断路由

**修改范围**：[`src/acpi_tables.js`](../src/acpi_tables.js)（AML 编码器与表生成）、[`src/platform.js`](../src/platform.js)、fw_cfg 文件表、SeaBIOS 构建脚本、`src/pci.js`、`src/acpi.js`、`src/io.js`。

- [x] SeaBIOS 构建脚本：固定 `rel-1.16.2`，已有目录不再 `|| true` 跳过；checkout 失败、tag 不符或工作区有改动时停止；输出 commit 与 ROM SHA-256。本次未重建 ROM（本机无 SeaBIOS 所需的 i386 工具链），当前 ROM：`seabios.bin` 73e3f359102e3a99…、`seabios-debug.bin` 24174391d6612384…、`vgabios.bin` a4bc0d80cc3ca028…。
- [x] fw_cfg 文件目录加入 `etc/table-loader`、`etc/acpi/rsdp`、`etc/acpi/tables`。字段全部显式小端编码；文件内容在 SeaBIOS 读取时按 PMBA 当前值重新生成，大小不随基址变化（断言保证）。
- [x] 生成 RSDP（rev 2）、RSDT、XSDT、FADT（rev 3，244 字节）、FACS、DSDT（rev 1，32 位整数）、MADT；不需要 SSDT。SDT 与 RSDP 的校验和由 loader 在指针修补之后计算；FACS 单独验证签名/长度/64 字节对齐。
- [x] DSDT 只描述 v86 实际存在的硬件，对象路径沿用 SeaBIOS（`\_SB.PCI0`、`PCI0.ISA.KBD` 等）以减少已安装客户机的变动：PCI 根桥（只有 `_HID`；`_CRS` 含总线 0–FF、I/O 两段、VGA 窗口和 [RAM 顶端对齐 256 MiB, 0xFEBFFFFF] 内存窗口，覆盖 v86 不能迁移的 BAR）；RTC、KBD、MOU、FDC、PIC、PIT、DMA、扬声器、FPU、按配置生成的 COM/LPT；PNP0C02 主板资源（PM 块、GPE、SMI_CMD、fw_cfg、0x92）；LNKA–D（`_PRS` 为 10、11）；`_PRT` 按 `PCI.get_irq_line` 的同一交错规则生成 32 槽 × 4 引脚；每核一个 `Processor()`；只有 `\_S5`。没有热插拔、GPE 方法、`_PIC`（PCI INTx 在 PIC 与 APIC 模式下都用同一 ISA IRQ 号，路由模型相同）。
- [ ] APIC 模式下 PIIX 的 PIRQA–D 到 IOAPIC 16–19 的直连仍未建模；表与实现一致地使用 ISA IRQ 10/11（A1 起 PIRQ 路由寄存器 bit 7 置位时不再误投）。
- [x] MADT：每核 LAPIC、IOAPIC（ID 0，0xFEC00000，GSI 0）、SCI 与 IRQ 10/11 的电平/高有效覆盖、LINT1 NMI；IRQ 5 保持边沿给 SB16。Linux 4.16 以 IOAPIC 路由启动，电平 SCI 经 remote-IRR/EOI 正常（1 次电源按钮 = 1 个 SCI）。PIC↔APIC 切换时的重复投递没有专门测试。
- [x] 睡眠状态、SMI_CMD、FADT flags：只公布平台描述中支持的状态；ACPI 模式经 SMI_CMD 切换；flags = WBINVD、PROC_C1、SLP_BUTTON（无睡眠按钮）、FIX_RTC（不实现 RTC_STS）、RESET_REG_SUP、USE_PLATFORM_CLOCK；PWR_BUTTON 与 TMR_VAL_EXT 为 0；C2/C3 延迟标为不支持。FACS 全局锁不被固件使用（无 SMM），保持 0。
- [x] FADT RESET_REG = SystemIO 0xCF9、值 0x06。0xCF9 改为独立的 PIIX 复位控制寄存器：只接受字节访问，RST_CPU 0→1 时复位，复位清零寄存器；0xCF8 的双字配置地址写不再可能误复位。
- [x] PM 块按 PMBA/PMREGMISC 解码，基址移动时注销旧端口（`IO.unregister_range`），与其他设备重叠时记录警告；恢复快照后按恢复的 PCI 配置重新解码（旧快照为 0xB000）。
- [x] ACPICA 校验：`iasl -d` 反汇编全部表无错误，`iasl -oa` 把反汇编重新编译成**逐字节相同**的 AML；唯一保留的警告是 3168（为 Windows 2000/XP 使用 `Processor()`）。`acpiexec` 执行链接设备 `_STA/_CRS/_SRS/_DIS/_PRS`、`\_S5` 与 KBD `_HID`，结果与预期一致。
- [x] 客户机侧：未使用 `acpidump`（buildroot 无此工具），改为宿主侧从客户机内存沿 RSDP→XSDT/RSDT 解析并与仿真硬件对照；Linux 报告的表地址位于 SeaBIOS 高区保留内存。
- [x] 过渡路径不需要：table-loader 路径直接可用。`etc/system-states` 保留，只在 loader 失败而回退到 SeaBIOS 自带表时生效。

**退出条件**：单核 Linux/i386 和 Windows ACPI HAL 目标无需 ACPI 禁用绕路；无未解释的 AML 错误/SCI storm；电源按钮→OS 关机→S5、ACPI reboot 各循环至少 20 次。此时只标记 `ACPI-core`，A3 未通过前不宣布电源管理全部完成。

**实施记录（2026-09-27）**

- `make acpi-table-tests`（`tests/devices/acpi_tables.js`，无客户机）：按 SeaBIOS `romfile_loader.c` 的语义在 JS 中执行 loader，对 256 MiB、32 MiB（全部串口/并口）、2 GiB 三种平台验证 RSDP/RSDT/XSDT/FADT/FACS/MADT/DSDT；表大小与 PM 基址无关；平台描述拒绝重叠 I/O；找到 `iasl`/`acpiexec`（PATH 或 `IASL`/`ACPIEXEC`）时做上面的 ACPICA 校验，找不到时明确输出 SKIP。ACPICA 20260408 在 macOS arm64 上需以 `LDFLAGS=-Wl,-no_fixup_chains` 链接。
- `make acpi-device-tests`：18 项，新增 PMBA/PMREGMISC 解码与复位控制寄存器（含原实现会误复位的双字配置地址序列）。
- `make acpi-guest-tests`：buildroot Linux 6.8（PIC 路由）、同一镜像 `DISABLE_JIT=1`、`GUEST=linux4`（Linux 4.16，IOAPIC 路由）三次运行。宿主侧确认表来自 v86（OEM `V86`）、FADT 字段与 PMBA=0x600 一致；dmesg 无 ACPI Error/Warning/AE_*（仅容忍旧内核对可选 `_OSC` 的 `AE_NOT_FOUND` 提示）；电源按钮 1 事件 1 SCI；`acpi_pm` 计时 3.04 s 对宿主 3.08 s；`reboot`（`reboot=acpi` 或新内核默认）只向 0xCF9 写一次 0x06 并完成重启；关机/上电循环。SeaBIOS debug ROM 日志确认 `Moving pm_base to 0x600`、`Using pmtimer, ioport 0x608`、DSDT 完整解析、`PS2 keyboard initialized`。
- 与回退表 A/B 对比（同一 Linux 6.8）：`Processor Platform Limit event … not handled`、`unable to open an initial console` 两条提示在旧表下同样出现，不是新问题；PnP 设备数相同，旧表多出的一个 COM2 是上表所列的“幻影”串口。Linux 2.6.34（`linux.iso`，内核无 ACPI）照常启动。
- 20 次循环：两种客户机各 `POWER_CYCLES=20` 次 `poweroff`→S5→`power_button()` 上电。ACPI reboot 每次运行 1 次，未做 20 次循环；buildroot 没有处理电源按钮的用户态程序，“按钮→OS 关机”无法在本地客户机上验证，改为验证事件与 SCI 各恰好一次。
- 未验收：Windows ACPI HAL/Windows x64（无镜像）。


### P2a：布局单一来源与状态归属

**修改范围**：`global_pointers.rs`、`src/cpu.js`、`js_api.rs`、`wasm_builder.rs`、IR runtime/Tier-0/backend 中硬编码偏移的位置、`state.js`、测试中的偏移常量。

拆成四个顺序子任务，每个保持单核可运行：

1. [x] [`gen/state_layout.js`](../gen/state_layout.js) 是 58 个字段（偏移、大小、Rust 类型、归属）的唯一来源，生成 `global_pointers.rs` 中 GENERATED 标记之间的常量与 [`src/state_layout.js`](../src/state_layout.js)；`cpu.js` 的 51 个视图改用 `STATE_OFFSETS`（替换脚本逐个断言原数字与布局相等）。生成的常量与原文件逐条相同，release `v86.wasm` 重建后逐字节相同。JIT 通过 Rust 常量取偏移，无需另生成。IR 差分测试中仍有硬编码偏移（如 `words[612>>2]`），布局不变时依然正确，X1 改布局时必须一并改写。
2. [x] 归属分 core / cache / scratch / machine / debug 五类：固定区字段逐个标注并检查无重叠；`src/rust` 中全部 131 个 static 逐个登记，`make state-layout-check` 扫描源码，新增或删除 static 未登记即失败。结论：固定区每核部分为 9 段共 1136 字节（`CORE_STATE_RANGES`）；Rust 中真正每核的只有 `APIC`；TLB（`tlb_data` 等）、`last_virt_eip/eip_phys`、`state_flags`、x87 影子为 cache；`instruction_counter`、TSC 偏移、x87 策略、ACPI/内存大小/SVGA 为 machine；IR 的 `FAST/PAGE_FAST` 等查找缓存为 machine，因为每次命中都按当前 TLB 与 CPL 复核；`ACTIVE/T0_CONTROL/T0_CS/EXIT_KIND`、SoftFloat 全局等只在一次激活或一次运算内有效（scratch）。
3. [ ] （随 X1）引入 GuestIP/Linear/Physical/HostOffset 类型，低 RAM 与 MMIO 从同一物理总线入口分派；DMA、固件、调试读写不能绕过代码页失效接口。
4. [ ] （随 X1/C1）提供新 snapshot schema、v6 导入器和版本校验；架构状态与缓存的划分已由第 2 项给出。
5. [x] 换核原语：`CPU.save_core_state()` 先写回 x87 影子再复制每核区间；`CPU.load_core_state()` 写入后丢弃派生状态（TLB、EIP 翻译缓存、`state_flags`、x87 影子）。已编译代码保留：它从固定地址读状态，入口处复核 TLB 与模式。

**退出条件**：布局一致性检查通过；解释器、Tier-0、区域后端及至少两台独立 VM 回归；在测试钩子里创建两个上下文，用状态区换入换出交替执行，寄存器、FPU、TLB、异常、JIT 缓存无串扰。此阶段保持单核公开配置，不提前声称 SMP。原 P2 中的 ctx_ptr ABI 移到 W0。

**实施记录（2026-09-27）**：`make smp-tests` = 布局检查 + [`tests/smp/core_swap.mjs`](../tests/smp/core_swap.mjs)（JIT 与 `DISABLE_JIT=1`，release 也已跑过）。夹具是 nasm 写的 multiboot 内核（[`tests/smp/core_swap.asm`](../tests/smp/core_swap.asm)）：两个上下文各建页目录，把同一虚拟页映射到不同物理页，开启分页、PSE 与 SSE，双精度 x87 控制字（使 x87 影子缓存在切片边界处于 dirty），循环中混合整数、x87、SSE 与经虚拟页的读写。两者在一台机器上每个主循环切片互换一次（JIT 166+167 片、331 次切换；解释器 84+84 片），最终结果、各自物理页和每核状态与“各自单独运行在新机器上且不经过换核原语”的参照逐字节相同。三种变异都会被检出：不刷 TLB（对照运行，出现跨上下文写入）、不写回 x87 影子（结果不同）、不重算 `state_flags`（直接检查，模拟 AP 实模式与 BSP 保护模式并存）。结论：固定地址的换核原语可保留已编译代码；这不代表多核 JIT 的安全门槛已经通过。C1/C2 多核继续关闭 JIT，C3 验收跨核 SMC、原子性和发布协议后再开放。

### X1：64 位状态与解码

**修改范围**：CPU 寄存器/模式、`gen/x86_table.js`、解释器生成器、共享 decode/modrm/prefix、IR 前端类型和覆盖目录。

- [x] 增加 16×u64 GPR、16×XMM、RIP、64 位 FS/GS base、GDTR/IDTR base、CR/DR/MSR；x87 指针及 FXSAVE 格式同步审计。
- [x] 建立明确 `Real/VM86/Protected16/Protected32/Compatibility16/Compatibility32/Long64` 模式；将 operand/address/stack size 与 CPL、EFER、CS.L/CS.D 分开。
- [x] 实现 REX 顺序规则和 8 位寄存器选择、R8–R15、RIP-relative、SIB、moffs64、imm64/imm32 sign-extend、默认操作数尺寸及 0x66/0x67；保留 15-byte 指令限制。
- [x] 在 64-bit 子模式中，写 EAX 清零 RAX 高位，写 AX/AL 保留其他位；legacy/compat 模式及切换时的上半部行为另按规范测试，不能无条件复用清高位 accessor。REX 与 AH/BH/CH/DH 的规则覆盖到所有指令族。长模式无效编码精确 #UD，不能误执行 legacy opcode。（2026-09-28：长模式无效编码由 X3 opcode 执行矩阵在 349,888 个编码上验证。）
- [x] 多页取指失败与错误优先级测试；编译解码和运行时解码使用同一模式规则，编译不能触发 MMIO/guest 异常。（X4 页层用同一 `decode_with` 解码后备页字节，不经 MMIO、不交付异常。）

**退出条件**：模式×前缀×地址形式 corpus 和独立 decoder 交叉检查；含全 1、高 32 位非零、canonical 边界的操作数不被截断。此时还不能将 LM 位公布给普通 OS。

### X2：长模式状态机、分页和异常

**修改范围**：`paging.rs`、`cpu/memory.rs`、系统/控制寄存器指令、描述符/异常交付、`ir/runtime/snapshot.rs`。

- [x] 先实现微内核需要的最小 64 位解释器切片：寄存器/内存 MOV、基础算术、跳转、栈和控制寄存器操作，并配独立参考测试。X2 的系统验收依赖这个切片；X3 再补齐全部指令，不能等待 X3 完成后才具备运行 X2 fixture 的能力。
- [x] 实现 EFER.LME/LMA/NXE/SCE、CR0.PE/PG、CR4.PAE、CR3、CS.L/CS.D 的合法迁移和 #GP；退出长模式、compat 模式和 legacy 模式均有往返测试。（2026-09-28：新增离开长模式再重进的 QEMU 往返用例。）
- [x] 实现四级 walker、4 KiB/2 MiB 页，明确拒绝未公布的页尺寸；累积 R/W、U/S、NX、A/D、CR0.WP 和 reserved-bit 检查。PAE/NX/物理高位共用一致规则。
- [x] 替换 32 位线性页直接索引 TLB：使用有界 tag/set 或稀疏缓存，tag 含完整线性页、访问权限和地址空间 epoch；禁止按 48 位页号分配全量数组。
- [x] canonical 检查、CR2、PF error code（包括 instruction fetch/NX）、页表项高位、跨页读写/栈/取指的异常和部分提交语义分别测试。#SS/#GP/#PF 的区分按实际操作规范处理。（2026-09-28：跨页读、PUSH 跨入不存在页、取指跨页、MOVAPS #GP 先于 #PF 等优先级用例。）
- [x] 长模式 IDT gate、64 位 TSS/RSPn/IST、IRETQ、特权级转换、NMI 阻塞/解阻塞、double fault/triple fault；不能沿用 32 位 task switch 作为 long-mode 中断机制。（IST、IRETQ、调用门特权转换、#PF 交付中缺页→#DF 经 IST、NMI 在处理程序中阻塞并由 IRETQ 解阻塞均有 QEMU 用例；2026-09-28 补长模式三重故障（`triple_fault.mjs`，SDM 断言：主板复位到实模式复位向量，无长模式状态残留）。）
- [x] CR8/TPR、FS/GS/KERNEL_GS_BASE、STAR/LSTAR/SFMASK、APIC_BASE、TSC/MSR 策略同步实现；CSTAR 的读写/保留行为按选定 Intel profile 冻结，不套用 AMD 的 compat SYSCALL 入口。未知或保留位写入按选定 profile 故障，debug/release 行为一致。（FS/GS/KERNEL_GS_BASE、SWAPGS、STAR/LSTAR/SFMASK、TSC_AUX、PAT、IA32_ARCH_CAPABILITIES、MTRR/MCA 已实现并测试；CR8↔APIC TPR 别名有 QEMU 用例、保留位 #GP 有 SDM 断言；2026-09-28 补 APIC_BASE（读取、写回、清 EN 后 CPUID.1:EDX.APIC 为 0、重新使能、超出 MAXPHYADDR 的位 #GP）QEMU 用例；release 构建配对跑 x64 系统/整数/向量/页层/兼容 JIT/三重故障等 14 组，全部通过，见 [X2 记录](validation/platform/X2/system.zh-CN.md)。）
- [x] 运行时 walker 和编译代码快照共享无副作用的页表判定规则；编译快照不设置 A/D 位、不代替执行交付异常，并保留完整高物理页依赖。（X4 页层不快照页表：编译只读后备物理页字节，所有访存在运行时经 x64 TLB/JAC 翻译，失败时 RETRY 由解释器交付异常。）

**退出条件**：独立微内核能够进入/退出 long mode，触发并验证页故障/IST/NMI/CPL 转换，QEMU 对比的故障 RIP/向量/错误码/CR2/可见写入一致。x86 语义按 [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) 对应指令及系统章节逐项建立测试依据。

### X3：64 位解释器与 OS 闭环

**修改范围**：整数/分支/栈/string/bit/muldiv/atomic、FPU/SIMD、系统指令、CPUID、加载器与调试输出。

- [x] 按覆盖矩阵补齐 profile 的所有长模式有效编码：64 位 FLAGS、shift/rotate、128 位乘除中间值、near/far 控制流、64 位栈、REP、LOCK、CMPXCHG16B 等。（2026-09-28：[opcode 执行矩阵](validation/platform/X3/opcode-matrix.zh-CN.md) 349,888 个编码在 CPL3 下与 iced-x86 + CPUID profile 0 不一致。）
- [x] 实现 SYSCALL/SYSRET/SWAPGS，处理 non-canonical 目标、flags mask、用户/内核 GS、compat 返回；Intel profile 下 compat 中执行 SYSCALL 应 #UD，SYSRET 从 long64 返回 compat 的路径单独测试。旧 SYSENTER/SYSEXIT 及 INT 路径在新模式中的行为明确且有测试。（SYSCALL/SYSRETQ 往返、SWAPGS、非规范 LSTAR、兼容模式 SYSCALL #UD（SDM 断言）、SYSRET 返回 CPL3 兼容模式再经 SYSENTER 回内核、SYSRETQ 非规范 RCX 在 ring 0 #GP(0)（SDM 断言）；2026-09-28 补 SYSEXIT（32 位形式进入兼容模式、REX.W 形式进入 64 位模式，选择子与栈按 SYSENTER_CS+16/24/32/40）QEMU 用例。）
- [x] XMM8–15、FXSAVE64/FXRSTOR64、MXCSR、对齐异常、x87/SSE 异常屏蔽语义可保存恢复。审计遗留 #DB/#TF/FPU 异常缺口；凡新 profile 依赖或公开的语义都必须补齐，不能用 `Readme` 的旧缺陷条目豁免。
- [x] CPUID 0x80000000/01/08、地址位数、LM/NX/SYSCALL/CX16/LAHF 等与实现一致；调试/反汇编/trace 使用完整 RIP，unsupported MSR 不以 host panic 代替 guest fault。（profile 另公布 RDTSCP、CLFLUSH 与 IA32_ARCH_CAPABILITIES。）
- [x] 优先走 BIOS 磁盘/ISO 引导，不要求 direct bzimage/ELF loader 先支持 x64；旧 direct loader 明确拒绝不支持的输入。后续若公布 x64 direct boot，另加协议测试。（2026-09-28：multiboot 在找到头部时即校验：64 位 ELF、非 i386 机器、非可执行或既无地址头也非 ELF 的映像以 `emulator-error` 拒绝（此前 `read_elf` 只 `console.assert`，会用 32 位结构解析 64 位 ELF）；bzImage 缺少引导签名/头、协议早于 2.02 或非 LOADED_HIGH 同样报错。`tests/x64/direct_loader.mjs` 覆盖五种拒绝与一个仍可启动的 i386 multiboot ELF；kvm-unit-tests 的 ELF32 映像照常运行。x64 客户机经 32 位 multiboot 入口自行进入长模式，不受影响。）
- [x] 在 `disable_jit: true` 下运行 x64 Linux：启动到自动测试脚本，运行 64 位程序、32 位兼容程序、系统调用、线程、mmap/mprotect、signals、文件/网络 I/O、重启/关机。兼容程序镜像必须包含对应内核选项和用户库。（1 核解释器下启动、64/32 位程序、SYSCALL/vDSO、线程、mmap/mprotect、实时信号、fork/pipe、tmpfs 与 O_DIRECT 文件 I/O、XC 矩阵、reboot 与 poweroff(S5) 均通过；2026-09-28 补网络 I/O：virtio-net 上 64/32 位进程经 AF_PACKET 各收发 16 帧并校验宿主回显。）

**退出条件**：目标 profile 的解释器矩阵无未说明缺口，单核 Linux/x64 测试完成；独立 Windows x64 目标进入安装/运行验收。仅进入 shell 不能替代指令矩阵。

### X4：Tier-0 与区域 IR 全链路适配

**修改范围**：`ir/{hir,state,types,lowering,mir}.rs`、frontend/backend、tier0、helper registry、runtime 的 entry/cache/pages/snapshot/continuation 等。

- [ ] GPR16、XMM16、RIP64、FLAGS64 所需语义贯通 HIR、MIR、StateMap、materialization、helper ABI、Wasm locals；寄存器别名和 fault exit 高位全部保留。（进展：X4 页层是独立的 Tier-0 级编译器，不经 HIR/MIR：16 个 GPR 为 i64 局部变量，EFLAGS 惰性记录，所有出口写回完整 64 位状态；IR/区域管线未扩宽。）
- [x] 先允许新指令用正确解释器 helper 执行，未支持的编译路径显式拒绝；再实现 Tier-0 原生模板及区域 lowering。helper 回退属于可接受执行路径，但每种编码必须有明确归属。（页层：非模板指令“就地步进”解释器，未能本地完成的访问 RETRY。）
- [x] mode key 不再只有 `default_32`：包含所有影响解码/执行的模式，或由 guard/epoch 显式保护；缓存入口、page key、物理 witness、RIP/线性地址不得用低 32 位碰撞。（页层函数按后备物理页索引、与位置无关；入口检查 CPL/CS/模式/CR/EFER/IF/TF/DR7/访问缓存 epoch。）
- [ ] 更新 i64 FLAGS 折叠、移位边界、有符号/无符号比较、扩展/截断、phi copies、CSE/LICM/RAM forwarding 的证明；i64 DIV 的 Wasm trap 不能泄漏为 guest #DE 之外的 host 崩溃。（进展：页层的 i64 标志、移位与比较由随机差分覆盖，DIV/IDIV 在除数为 0、宽被除数或 MIN/−1 时 RETRY 由解释器交付 #DE，不会产生 Wasm trap；区域管线的 phi/CSE/LICM/RAM forwarding 尚无 x64 版本。）
- [x] 准入、链接、批量实例化、热度、SMC、restore、reset 和异步编译取消全部带新 ABI/模式/页 generation；旧模式产物不能在切换长模式后误进入。（页层：准入、热度、SMC 退役、restore/reset 清空、异步发布取消均按后备页与执行上下文校验；页函数之间没有链接，也不批量实例化。）
- [ ] 同一 fixture 运行解释器、Tier-0、区域 Tier-1/2：比较提交点的完整架构状态、内存副作用、异常和 MMIO 顺序；再与独立参考核对。（进展：解释器、页层与 QEMU 三方比较已通过（整数、向量、系统、页层场景与差分模糊）；x64 区域管线未实施。）

**退出条件**：x64 高地址及兼容模式切换差分通过；32 位原有 IR suite 无新增回归；真实 OS 分别在默认 Tier-0 与 `ir_tier0:false` 下通过。不得只运行区域后端就宣布默认 JIT 支持 x64。

**实施记录（2026-09-28）**：新增 x64 页层（[`pagegen.rs`](../src/rust/x64/pagegen.rs)、[`pages.rs`](../src/rust/x64/pages.rs)、[`jac.rs`](../src/rust/x64/jac.rs)），取代原生寄存器块成为长模式代码的编译路径：每个 4 KiB 长模式代码页一个与位置无关的 Wasm 函数，`br_table` 分派，GPR 在 i64 局部变量中，EFLAGS 惰性记录，内联访问缓存，非模板指令就地步进解释器，不能本地完成的访问 RETRY。证据：整数/向量/系统 oracle 在页层下通过，`page_fuzz.mjs` 与解释器逐字节差分（最终构建 30 个种子 × 48 个程序），`page_system.mjs` 8 个 QEMU 场景（CPL3、#PF/WP/NX、跨页与同页 SMC、线性别名、STI 影子），`make ir-tests ir-tier0-tests api-tests` 无回归；Alpine x86_64 1/2/4 核启动 1:16/1:52/2:08（解释器约 16/85/140 min）。`ir_tier0:false` 时长模式同样走页层；x64 区域管线未实施，因此 X4 只关闭 Tier-0 级门槛。详见 [X4 页层记录](validation/platform/X4/page-tier.zh-CN.md)。

**续（2026-09-28）**：兼容模式（LMA=1、CS.L=0）代码改由 32 位 IR/Tier-0 编译（`X64_COMPAT_JIT`，默认开）：数据访问经 x64 四级页表翻译后填入 legacy TLB（带 `TLB_IA32E_DATA`，编译代码内联检查可命中，取指/快照路径不命中，代码页总按执行权限与 NX 重新确认），x64 的 INVLPG/CR 写同样失效；`compat_jit.mjs` 以解释器、页层（兼容模式解释）、页层 + 兼容编译三方逐字节比较，含编译后改写被调用例程与 PTE 重映射。页层新增 SSE 数据移动/按位运算、MOVD/MOVQ、MOVNTI、fence、MOV CR8、RDTSCP、moffs 与 ROL/ROR CL 模板（差分模糊增加 SSE/moffs 生成器并比较全部 XMM）。**x64 区域管线的决定**：第一版不实施。区域管线的 HIR/MIR、StateMap 与各项优化证明都基于 32 位寄存器/EFLAGS，扩宽的工作量与页层相当；页层已使 Linux 1/2/4 核在 1–2 min 内启动，Windows 剖析显示剩余开销集中在尚无模板的指令类（标量 SSE 浮点、MMX/SSE 打包整数、0F AE、SYSCALL/SYSRET），而非缺少跨块优化。下列区域管线条目因此保持未勾选，不以页层冒充。

### X5：36 位物理地址与设备地址宽度

**修改范围**：GuestPhysicalMemory、TLB/JIT 快路径、fw_cfg/E820、DMA/IDE/virtio/PCI/调试 API、快照分块。

- [x] 将容量、物理地址、后备块偏移分开。实现低 RAM、PCI hole、4 GiB 以上 RAM 的明确布局；把总容量和 fw_cfg/E820 高位写正确。
- [x] RAM 重映射后，不存在的物理页、跨窗口操作有一致行为；低 RAM 快路径必须检查映射 generation，不能缓存过期宿主 view。
- [x] 逐项审计设备地址宽度：32 位 DMA 设备保留其真实限制，64 位 virtio descriptor 地址必须正确处理高位；不能把设备全部强制扩为 64 位，亦不能忽略高位。（通用 VirtIO、balloon、8237 DMA、IDE PRDT 见 X5 记录；2026-09-28 v86gl 改为 64 位 descriptor/arena 地址经 36 位总线，拒绝低地址空洞；IDE 48 位 LBA/IDENTIFY/HOB 按 2^32 扇区以上的盘修正。）
- [x] RAM 的 CPU/DMA/debug/import 写入走相同代码页失效通知。高 RAM 的页表、代码、数据、MMIO、跨 4 GiB 边界各有 fixture。（2026-09-28：`high_memory.mjs` 第二阶段把 CR3 与页表放在 4 GiB 以上，热代码在那里被页层编译后再改写，两种执行模式结果一致。）
- [x] 快照、读取内存 API 和镜像导出支持分块，不构造单个超大 JS TypedArray/JSON 数组；所有大小计算审计 signed bitwise 操作。（V7 快照流以 ≤1 MiB 的校验记录读写，RAM 直接从后备页打包；x86_64 Linux 2 核在探针运行中经文件完成 V7 快照往返；`read_blob_physical` 按范围读取；IDE 的扇区/LBA 计算审计后修正 48 位路径，见 X5 记录。V6 单缓冲接口为兼容保留。）

**退出条件**：小内存 fixture 验证 >4 GiB 物理地址（高位 MMIO、重映射到 4 GiB 以上的 RAM 窗口、跨 4 GiB 边界），由 guest 写入校验、执行高地址代码、做 I/O 和快照恢复；配置总量超过 wasm32 可用范围时在启动前明确拒绝。

### X6（可选）：超过 4 GiB 的 RAM 容量

**修改范围**：GuestPhysicalMemory 后备（Memory64 或多 memory）、JIT 访存快/慢路径、快照分块、配置校验。

- [x] 评估 Memory64 与多 memory：两者都要求重写整个以单一 wasm32 memory 宿主指针为前提的 CPU 核心（Rust 目标、全部 helper、TLB、JIT），Memory64 的浏览器支持也不一致；改用“驻留帧缓存”：扩展 RAM 的页存于宿主 ArrayBuffer（可与 Worker 共享），CPU 在 wasm 堆的帧池中缓存 4 KiB 页，物理总线把该范围解码为新的 `Extended` 类型。
- [x] 扩展 RAM 访问走新后备，低 RAM 与 X5 高 RAM 的快路径不变；跨页访问逐页解析；存储按 1 GiB 分块懒分配，“touched” 位图限定上电清零与快照；宿主无法分配时在启动前报错。

**退出条件**：资源足够的 runner 上实际配置 6–8 GiB，由 guest 跨低/高 RAM 写入校验、执行高地址代码、做 I/O 和快照恢复。受限浏览器明确拒绝超资源配置，不把不能分配解释为架构不支持。

**实施记录（2026-09-29）**：公开实验选项 `extended_memory_size`（与 `extended_memory_cache`），位于 `4 GiB + high_memory_size` 之后，CMOS/E820/multiboot 报告连续的高位 RAM。解释器 helper 每次访问查帧，可随时换出；x64 页层的访问缓存与兼容模式的 32 位 TLB 在轮转模式下可把扩展页映射到其帧（CACHED，执行中不换出，超过一半或无帧可换时在分发循环的安全点统一失效；2026-09-29 发现多核轮转的 `run_cpu_slice` 循环缺少这个安全点，6.5 GiB Alpine 在帧池占满后每次访问都走 bounce 帧而近乎停滞，已补上并以 2 核 fixture 回归）；扩展页从不作为代码编译；兼容模式经 32 位总线孔径访问；LOCK 读改写持有扩展 RAM 锁到指令结束；V7 快照流以 kind 3 记录携带扩展页。合成 fixture（6 GiB 扩展 RAM、4 MiB 帧池）覆盖全区抽样写读、密集模式、字符串复制、代码执行、页表与 A/D、兼容模式、DMA 与快照恢复，解释器与页层逐字节一致。真实 OS 的 6.5 GiB 运行见 [X6 记录](validation/platform/X6/extended-memory.zh-CN.md)。

### C0：确定性机器时钟

**修改范围**：`src/main.js` 主循环、PIT/RTC/ACPI/LAPIC 定时器、TSC（`cpu.rs` 的 `read_tsc`/`tsc_offset`）、测试钩子。

- [x] Machine 级时钟：正常模式跟随宿主单调时间；测试模式按已提交指令数推进，可注入。所有设备与 TSC 从它读时间，不再各自调用 `microtick()`。
- [x] 规定暂停、后台节流、S3、快照恢复时的推进策略；宿主长暂停后的补发有上限并记录。
- [x] 时钟只推进一次/每 Machine：多核轮转时 AP 的执行不重复驱动设备计时。

**退出条件**：同一镜像、同一输入和种子在测试模式下两次运行得到相同的 IRQ 序列、PM timer 读数和串口输出；正常模式下单核启动时间与 P0 基线无显著差异。

### C1：每核 LAPIC、AP 启动和中断路由

**修改范围**：`apic.rs`、`ioapic.rs`、`pic.rs`、CPU reset/HLT/interrupt、`src/main.js`/CPU slice 执行入口、Machine Scheduler/InterruptRouter、固件初始化。

本阶段在 32 位下完成，不等待 x86-64。A2 已先落地，因此本次固件验收直接使用 v86 的 table-loader/MADT 路径。

- [x] **最小解释器调度器**：JS `run_cores()` 在安全点选择核并调用 Rust `run_cpu_slice(budget)`，每轮每核预算 4096 个解释器 dispatch（STI 的一条 shadow 指令最多超额 1）；同页无 PAUSE 忙等也受预算限制，长 REP 每次最多 256 个元素后让出。切换不拆开 LOCK/隐式 XCHG 的指令体。所有核 HLT 时 Machine 仍服务定时器，AP 的 HLT 不重复服务设备。多核默认禁用 JIT，C3 提供显式实验选项。dispatch 计数包含 REP 续跑与异常分派，**不是** C0 已提交指令时钟。
- [x] 按 §3.1 第一步实现状态块换入换出（范围来自 P2a），切换点只在主循环安全点；先以测试钩子验证两核交替执行无串扰，再接入调度器。
- [x] 每核独立 LAPIC/IRR/ISR/TMR/TPR/PPR/LVT/timer/APIC_BASE/MSR 状态（LAPIC 改为按核数组）；IOAPIC/PIC/外设属于 Machine。
- [x] 明确 BSP reset、AP wait-for-SIPI、INIT assert/deassert、SIPI vector 和重复 SIPI 的规则；AP 从正确实模式入口运行，不通过宿主直接跳进内核函数。
- [x] 实现 ICR destination/shorthand、physical/logical destination、fixed/lowest-priority/NMI/INIT/SIPI 和所需 ExtINT；不支持的保留编码遵循选定模型。
- [x] 实现 EOI、remote-IRR、电平重触发、mask/unmask、优先级和每核 LAPIC timer；设备 IRQ 通过路由选择目标，不无条件交给 BSP。
- [x] 32 位最小 trampoline 逐核写签名、发送回执 IPI，验证定向、广播、all-excluding-self、HLT 后唤醒、AP 重初始化；覆盖同一切片中先后两个不同 SIPI vector，只采用第一个。
- [x] 真正 SeaBIOS 启动：2/3/4/8 核通过 BIOS POST 后进入软盘引导扇区；fw_cfg 仍公布完整 expected CPU count，全部 AP 实际执行，内存中 MADT 核数/ID/校验和一致。

**前一轮实施记录（2026-09-27，C1 子门槛）**：新增 `make multicore-boot-tests` / `multicore-boot-tests-release`，覆盖 APIC physical/flat/cluster 路由、INIT/SIPI 顺序、NMI latch、优先级、IOAPIC 电平重投递、精确忙等预算、REP 续跑、BSP CLI+HLT 时 AP timer 唤醒，以及真实客户机 trampoline/SeaBIOS。`apic.flat` 已从 8 PASS/3 FAIL/1 SKIP 提升为 11 PASS/0 FAIL/1 SKIP，纳入 `kvm-unit-test-apic`。

前一轮还修复 CF9 注册位置、PCI/ACPI 快照 PM 解码顺序、单核 NMI/APIC enable 快照缺失；多核 save/restore 明确拒绝，restore 在写入 RAM 前拒绝。布局增加 `nmi_blocked`，当前为 59 字段、1144 字节每核区域、136 个已分类 static。详见 [C1 验证与审查记录](validation/platform/C1/review-and-validation.zh-CN.md)。以上是前一轮状态；本次时钟、ExtINT/APIC enable、拓扑和多核快照进度以下方新记录为准。

**退出条件**：2/4/8 核 trampoline 均由客户机启动；每核 ID/寄存器/栈独立；IPI 延迟受预算约束；固件启动不靠减少其 expected CPU count 逃避失败。

### C2：单 socket 拓扑和有界轮转执行

**修改范围**：CPUID、平台描述、固件 MADT/SSDT/可选 SMBIOS、CMOS、main run loop、JIT budget。

本阶段先用 32 位 OS、`disable_jit:true` 验收；C3 最小一致性门槛通过后，再用显式实验选项重跑两个 JIT 后端。多核默认保持解释器，完整 C3 门槛通过后再决定默认开放。x64 OS 上的同一矩阵由 XC 负责。

- [x] 全部来源使用同一 `Topology { sockets:1, cores:N, threads_per_core:1 }`。CPU/APIC ID 稳定映射到 core ID；BSP 标志唯一。
- [x] CPUID leaf 1 的 logical count/HTT、leaf 4 cache/core 信息、0xB/0x1F topology 与 profile 最大 leaf 一致；没有 SMT 不代表可以随意清除用于历史枚举的 HTT 位。逐个 subleaf 写预期输出测试。
- [x] SMT 层 count=1，core/package 层报告 N；package ID 始终为 0。3 核用合适 ID 位宽，不能用 N 直接当 shift。所有核的 CPUID 只在该不同处不同。
- [x] MADT 和 AML 各核对象 ID 与 CPUID 对齐；若生成 SMBIOS，Type 4 应反映一个处理器封装、N 核，不生成 N 个 socket。旧 MP table 只提供其能表达的信息，不能推翻 CPUID 拓扑。
- [x] 扩展 C1 的调度器，在预算/事件边界轮转，处理忙等、长 REP 和 HLT；定义 JIT 自循环/跨页链接的预算接口，C3 完成一致性后才开启。设备计时每台 Machine 推进一次，AP 运行不重复调用全局设备 timer。
- [x] 为所有核设置合理预算上限，并提供每核提交指令、REP 元素、故障、运行时间、IPI 和 halt 计数诊断。三后端逐核精确值、JIT 实际命中、快照和复位均通过；旧单核快照没有指标时清零，宿主运行时间不参与确定性重放比较。见 [C2 统计验证](validation/platform/C2/core-statistics.zh-CN.md)。

**退出条件**：Linux `lscpu` 显示 `Socket(s)=1`、`Core(s) per socket=N`、`Thread(s) per core=1`；`/sys/devices/system/cpu/*/topology` 一致；Windows 拓扑 API/系统工具同样确认。核绑定程序在所有核执行并得到独立进度，不能只检查 `/proc/cpuinfo` 条目数。

### C3：原子性、跨核 JIT 失效和全机恢复

**修改范围**：共享内存总线、atomic/fence 指令、IR 内存优化和安全点、页 generation、快照/复位协调。

- [x] 将 C1 的解释器原子事务保证推广到所有 JIT 路径：LOCK、隐式锁定 XCHG、CMPXCHG8B/16B 不可分割；跨页/未对齐/MMIO 的故障和部分提交按指令契约处理。不得仅把 LOCK 当可忽略前缀。（32 位：[原子异常边界](validation/platform/C3/atomic-memory-order.zh-CN.md) 在解释器/Tier-0/区域各 107 个场景，含跨页 RAM、MMIO、MMIO→RAM 与第二页不存在/只读，debug 与 release 均通过；非法 LOCK 编码 #UD。x64：整数 oracle 的原子用例（含 CMPXCHG16B）在解释器与页层下与 QEMU 一致，`page_system.mjs` 的 LOCK 跨入不存在页场景要求操作数与寄存器不提交；MMIO 与跨页访问在页层 RETRY 到解释器的原子路径。）
- [x] 明确 x86 内存顺序要求。轮转执行可采用更强的顺序作为正确性起点；IR 不能把跨核可能改变的 RAM load 在安全点前后永久复用，优化需要有效失效 guard。
- [x] TLB 每核独立：本核 INVLPG/CR3 操作按规范生效，其他核通过客户机 IPI shootdown 刷新。不要让“任一页表写自动 flush 所有核”掩盖 shootdown 缺陷。
- [x] 代码写入更新 Machine 级物理页 generation，通知所有相关 JIT。活动帧必须在保证的观察边界退出；待发布的旧快照编译结果被拒绝，table slot 只在安全回收后复用。
- [x] **先通过多核 JIT 最小安全门槛再运行 OS**：每核状态隔离、LOCK 事务、所有核代码页失效、load 优化边界和异步发布校验的微测试全绿；之后开启 C2 预留的 JIT 预算/链接路径，并重跑 C2 的完整 OS/拓扑矩阵。
- [x] 测试核 A 修改核 B 将执行的代码，按架构规定完成同步/序列化后 B 必须执行新代码；包含物理别名、DMA、自修改、恢复后异步编译回调，不要求未同步 SMC 有超出硬件的语义。
- [ ] stop/save/reset/S3/S5 协调全部核，清空或保留事件按类型区分。三重故障和 AP INIT 不混成同一个无条件全机重启操作，按平台策略测试。（进展：stop/save/restore/reset/S5 已由 [全机状态](validation/platform/C3/lifecycle.zh-CN.md) 与 OS 压力矩阵覆盖；[异常生命周期](validation/platform/C3/exception-lifecycle.zh-CN.md) 按平台策略区分 BSP shutdown（安全点全机复位）与 AP shutdown（仅该核停止，NMI/INIT 恢复，参与快照），debug/release 均通过，长模式三重故障另有用例；S3 依赖 A3，未完成。）

**退出条件**：锁保护计数器、无锁队列/发布、TLB shootdown、跨核 SMC、信号/线程迁移、磁盘/网络压力运行通过；保存于 pending IPI/REP/HLT 状态后恢复结果一致。至少 10 个固定调度种子、多档 quantum 均通过；执行后端覆盖解释器、Tier-0、区域管线。

**本次实施记录（2026-09-27，C0–C3）**：

- C0 已接入 `cpu_clock`（normal/deterministic）、全部 PIT/RTC/PM/LAPIC/TSC 时间读取及 pause/resume/save/restore 策略。确定性模式使用解释器提交账本，普通成功指令与已完成 REP 元素推进时钟，faulting dispatch 不退休；停止时冻结，长宿主间隔最多补入 1000ms 并计诊断。参见 [时钟及设备验证](validation/platform/C0/clock-and-devices.zh-CN.md)。历史提交 `bb8979f3→fc79557e` 的同环境正常单核启动中位数增加 0.619%，通过 10% 阈值；09-27 冻结产物为 1.087；09-28 含 x64 工作的产物先测得 1.148（未通过），修正解释器热路径后为 1.095（通过），见 [冻结 release 复验](validation/platform/C0/normal-up-final.zh-CN.md)。见 [性能对照](validation/platform/C0/normal-up-boot.zh-CN.md)。
- C1 补齐 APIC_BASE/SVR、ExtINT 到 AP、ESR/保留编码、同 vector pending TMR、timer mask/phase，并保留 BSP virtual-wire 启动策略。硬件禁用 APIC 不再接收 APIC 消息；软件禁用不屏蔽 NMI/INIT/SIPI。参见 [中断语义补齐](validation/platform/C1/interrupt-completion.zh-CN.md)。
- C2 的 1..8 CPUID/MADT/AML/fw_cfg/CMOS 一致性与真实 Linux 1/2/3/4/8 核单 package、逐核 affinity 计算均已通过；在一致性微测试门槛之后，interpreter/Tier-0/region 三后端的 15 个 OS 配置全部通过，JIT 模式同时检查每核绑定工作阶段真实 compiled activations。核数为 3 时使用 ceil(log2 N) 的 APIC ID 位宽。当前 BIOS 不生成 SMBIOS Type 4；没有 Windows 测试镜像。参见 [拓扑及 Linux 原始记录](validation/platform/C2/topology-and-linux.zh-CN.md)。调度提供 `cpu_quantum`、`cpu_schedule_seed`、每核 slices/dispatch steps/IPI；尚不把混合 dispatch/JIT step 统计当作完整的每核退休量和运行时间诊断。
- C3 新增每核稀疏 TLB 保存/恢复，不因换核而刷新客户机映射；按机器代码页状态重新同步 TLB 的 code 标志。独立 TSC offset、LAPIC/AUX、NMI/ExtINT/INIT/SIPI、REP/HLT、机器时钟和调度顺序纳入全机快照，核数不匹配在修改 RAM/设备之前拒绝。旧单核快照仍接受，旧 host-absolute timer 的相位采用文档化 best-effort 重锚。
- JIT 编译额度每个 Machine round 补一次；Tier-0 loop poll 和跨页链接受 slice budget 限制。`experimental_smp_jit:true` 显式开放实验执行，默认仍采用解释器。微测试在 interpreter/Tier-0/region 上覆盖 10 seeds、quantum 17/257/4096、4/8 核、LOCK/XCHG/CMPXCHG8B、共享 load、物理别名 SMC、DMA 写屏障、IPI shootdown 和异步发布。每个构建 101 场景；故意换核 flush 与移除 INVLPG 的负向控制都能失败。参见 [一致性微测试](validation/platform/C3/coherence.zh-CN.md) 和 [全机状态验证](validation/platform/C3/lifecycle.zh-CN.md)。
- CF9/8042 客户机复位延迟到指令返回安全点执行；restore/reset 的 execution epoch 阻止旧异步编译回调安装或取消新一代 table slot。快照事务冻结统一时间，恢复后继续同一调度与 REP 结果。

`make multicore-clock-tests`、`multicore-boot-tests`、`multicore-topology-tests`、`multicore-coherence-tests` 均有 `-release` 对应目标。真实 Linux 使用 `multicore-linux-tests`，JIT OS 模式见 C2 记录。完整 C3/R-SMP32 **仍未关闭**：跨页故障/MMIO 的原子部分提交、线程/信号迁移、真实磁盘/网卡长期压力，以及 S3（依赖 A3）尚需独立验收；CMPXCHG16B/x64 留给已列明的 x64/XC 范围。现有勾选表示对应实现及局部门槛，不替代各阶段尚未完成的退出条件。

**本轮继续实施与审查（2026-09-27）**：

- C3 新增真实 guest 原子边界：三个后端各 107 场景，覆盖跨页、未对齐、缺页、写保护、RAM/MMIO 混合，以及非法 LOCK 的 #UD；修复解释器和 region helper 的 CMPXCHG8B 失败路径遗漏写回，以及 MMIO read64 低 DWORD 符号扩展。无锁发布/队列 96 场景在 debug/release 均通过，提前发布负向控制会失败。见 [原子与内存序报告](validation/platform/C3/atomic-memory-order.zh-CN.md)。
- C3 每个后端使用真实 Linux `fork`/共享映射、逐核迁移、SIGUSR1、NE2K 帧回环和 IDE O_DIRECT 读写；debug/release 各 60 个负载场景和 6 次负载快照重放通过，三个后端均完成整机重启、四核重新上线和 S5。发现并修复整机复位遗漏共享 PIC/IOAPIC、旧定时器 ISR 阻塞 Linux 校准的问题；AP INIT 保持共享控制器状态。见 [OS 压力报告](validation/platform/C3/os-stress.zh-CN.md)。
- 异常交付新增 Intel double-fault 分类与 shutdown 状态：BSP 三重故障由主板在安全点复位全机；AP shutdown 保持独立，普通情形可由 NMI/INIT 唤醒，NMI 内 shutdown 只能机器复位。修复 IRET/IDT/GDT/TSS 的客户机无效输入导致 host panic、描述符整长/跨页检查，以及复位后旧调度轮次记账。见 [异常与生命周期验证](validation/platform/C3/exception-lifecycle.zh-CN.md)。
- 用户提供的 Windows XP 原盘只读检查为 Standard PC EISA/ISA 单处理器 HAL，不能直接用它证明 SMP 拓扑。只读原盘已实际进入桌面并通过单核 Win32 探针；临时内存覆盖层替换匹配 MP HAL/kernel 后四核进入 NT 内核，但停在 idle、尚未完成用户态逐核探针。需继续与独立模拟器比较适配路径；x64 Windows 验收不由 XP 替代。
- X1 共享解码有 33,088 个 iced-x86 对照用例；X3 的真实 NASM guest 从 32 位进入长模式并跳转高 RIP，1,540 个整数/flags/原子用例与 QEMU 一致。X2 另有 15 个 QEMU 系统/异常/IST/系统调用差分及 6 个独立 SDM 非法状态断言。X4 原生 i64 寄存器子集已有独立差分，完整 IR 和 OS 门槛继续实施。
- X5 的真实高 RAM/MMIO、36 位 VirtIO、32 位 IDE/8237 边界和 balloon DMA 已加入测试；整机快照保留物理窗口与每核完整宽 TLB，坏输入在机器状态修改前拒绝。见 [物理总线](validation/platform/X5/physical-bus.zh-CN.md)、[宽 TLB 快照](validation/platform/X5/tlb-snapshot.zh-CN.md)。
- 仍不公布 LM 能力，不表示 x64 OS、完整 Tier-0/region 或 XC 已通过。普通用户配置仍只需 `cpu_cores`，没有新增 `cpu_profile`/`cpu_execution` 选择。

**本轮续（2026-09-27 晚）：真实 x86_64 Linux 与 XC**（基线 `018eabbc` + 未提交修改；详见 [XC 记录](validation/platform/XC/linux64-boot.zh-CN.md)）：

- 修复宽解释器的中断交付时机：设备回调（IDE 数据口、8042、PIC 端口、LAPIC/IOAPIC MMIO）同步调用 `handle_irqs()`，在宽指令提交 RIP 之前交付 IRQ，随后被 `write_rip(next)` 覆盖，造成 ATAPI IDENTIFY 超时和 `rep insd` 处的 Oops。宽指令执行期间延迟外部中断，边界处统一交付；32 位路径不变。[`irq_boundary.mjs`](../tests/x64/irq_boundary.mjs) 的两个场景按 SDM 断言返回 RIP/RSP/IF，去掉修复的负向控制失败。
- 宽解释器补上 `PAUSE` 让出（多核自旋不再占满 quantum）；实现 64 位模式间接远 JMP/CALL 与 64 位调用门（含 CPL3→CPL0 栈切换），系统差分增至 46 个 QEMU 用例，另有 SDM 断言覆盖 QEMU 的偏差（非规范远 CALL 目标、DR 数据断点、MOVLPD 寄存器形式）。
- 吞吐：宽解释器 1.78 → 约 14 MIPS（物理总线低 RAM 短路、按页 preflight、取指页缓存、宽 TLB 按访问类型分槽、以字节校验的解码缓存与执行器归属缓存、免去不读 FLAGS 指令的惰性标志物化）；原生块缓存改为直接映射并加 64 次热度阈值。
- Alpine 3.24 x86_64（Linux 6.18，官方 ISO 未修改）：1 核解释器启动到 root shell，64 位进程（`SYSCALL`）与 32 位兼容进程（vDSO `SYSENTER`）的无 libc 探针覆盖系统调用、`mmap`/`mprotect`+SIGSEGV、`fork`/`wait4`、逐核 `CLONE_THREAD`+`LOCK`、跨核 TLB shootdown、文件 I/O 与 `pagemap` 物理帧位置；同一探针先在 QEMU 上 1/2/4 核验证。
- X5：新增测试配置 `high_memory_size`，把 RAM 顶部重映射到 4 GiB 并经 CMOS 0x5B–0x5D 交给 SeaBIOS；multiboot 图同步。Linux 1 核在 512 MiB 中 128 MiB 位于 4 GiB 以上时通过，两个探针进程的全部用户页位于 4 GiB 以上。
- XC 观察：2/4 核 x64 Linux 上线全部 AP 并继续启动；Alpine 内核为 `CONFIG_HZ=1000`，客户机时间跟随宿主时间，每个忙碌 vCPU 每秒要处理 1000 次时钟中断，而 vCPU 轮转共享约 14 MIPS，因此多核启动慢数倍并出现 soft-lockup 警告（按指令采样的剖析显示时钟中断、调度统计占主导）。这是吞吐问题，需 X4 编译或 W 系列并行解决，不能靠放慢客户机时间掩盖。
- 构建：`state_io.js`、`state_stream_transport.js` 已加入 Makefile 的 Closure 文件表（此前 `libv86.mjs`/`cpu-worker.js` 构建失败）；新增 §6.3 的 `x64-decode-tests`、`x64-system-tests`、`x64-differential-tests`、`highmem-tests`、`x64-multicore-tests`、`x64-guest-tests`、`x64-multicore-guest-tests`。
- 仍阻塞：Windows XP SMP——现有镜像为 Standard PC HAL，改用 ACPI MP HAL 需要重新安装，而 XP 安装光盘需要产品密钥，本地无法完成；Windows x64 无镜像。

### XC：x64 × 多核集成

**修改范围**：状态区布局（X1 扩宽后的 16×u64 GPR、16×XMM 等）、C1 的换入换出、每核 MSR（FS/GS/KERNEL_GS_BASE、STAR/LSTAR/SFMASK、TSC_AUX）、固件表中的 x2APIC 前置检查。

- [x] X1 扩宽后的状态区重新生成，换入换出覆盖新增字段；每核 MSR 与 SWAPGS 状态独立（`tests/x64/multicore.mjs` 四核状态/TLB 隔离、CX16、快照）。
- [x] AP 从实模式经保护模式进入长模式的全过程在每核独立完成；长模式下的 IPI、TLB shootdown、NMI 按 C1/C3 的测试重跑。`tests/x64/multicore.mjs` 在三后端 × 2 种子 × 2 quantum 上新增长模式阶段：64 位 IDT、定向 fixed IPI、发给 HLT 中 AP 的 NMI（核对被中断的 RIP）、all-excluding-self 广播，快照恢复后重放结果一致；真实 Linux 2/4 核 AP 上线，OS 级 TLB shootdown 探针见 XC 记录。
- [x] Tier-0/区域后端在 x64 多核下的 SMC 与代码失效沿用 C3 的协议，并加入长模式地址的用例。（页层：代码页写入经 `jit_dirty_page` 退役函数、所有核的写访问缓存失效；Linux 4 核 XC 矩阵的跨核 SMC 64 轮与 `page_system.mjs` 的 SMC/别名场景通过；x64 区域管线未实施。）

**退出条件**：C2/C3 的 OS 与一致性矩阵在 x64 Linux（含 32 位兼容进程）上通过；Windows x64 目标在有镜像时进入验收。

**实施记录（2026-09-28）**：`linux_probe.c` 新增 XC 矩阵（/sys 拓扑、每线程 24 次迁移、跨核实时信号、跨核 SMC 64 轮、O_DIRECT），64 位与 32 位兼容进程各一遍，先在 QEMU 1/2/4 核上作为参考通过。v86：1/2/4 核解释器、1/2/4 核页层全部通过（4 核解释器 135 min，16 次 soft lockup 告警）；4 核页层在探针运行中三次整机快照/恢复后继续通过，随后 reboot 到第二次登录（全部核在线）并 poweroff 进入 ACPI S5。多核下曾出现 poweroff 后未到 S5 的一次挂起，之后累计 12 次 4 核生命周期（其中 6 次在主机高负载下连续运行）均未复现，原因仍未定位，见 [XC 记录](validation/platform/XC/linux64-boot.zh-CN.md)。

**续（2026-09-28，Windows）**：用户提供的 Windows 8.1 Pro x64 镜像（只读，客户机写入进 RAM 覆盖层）在 v86 中经 SeaBIOS/bootmgr/winload 启动到桌面，页层下 1/2/4 核的 64 位与 WOW64 探针全部通过：`GetLogicalProcessorInformation` 报告 1 package × N cores × 1 thread，逐处理器亲和的线程各自观察到唯一的 APIC ID，Interlocked 计数 64N，64 位分配位于 4 GiB 以上；另有一轮 2 核完全无人值守通过。启动途中修正：MSR 0x17、CPUID.1:EDX 的 DE/MCE/MTRR/MCA/PAT 与相应 MSR（蓝屏 0x5D）、ATA 未实现命令的断言、兼容模式下截断 64 位 GDTR 基址（所有 WOW64 进程 0xC0000005）。解释器下的 Windows 运行过慢，未做。

### A3：S3、S4 和 ACPI 最终闭环

**修改范围**：机器电源状态机、RTC/wake source、设备 quiesce/resume、FACS/AML、磁盘持久化、快照协调。

- [x] S4 先行：在 PIIX4/SeaBIOS 模型中，OS 写入休眠映像后以 `_S4` 的 SLP_TYP 进入 soft-off（A1 已把该值当作带 `S4` 标记的关机处理），下次冷启动由 OS 自行恢复。emulator 侧工作是：关机后磁盘内容保留（含浏览器内存盘与 async/分块盘的写回策略）、冷启动路径正确、公开状态查询；验证后再在平台描述中公布 `_S4`。
- [x] S3 按真实固件/OS 唤醒流程实现：进入时停所有核、保留 RAM；唤醒时 CPU 复位，SeaBIOS（`CONFIG_S3_RESUME`）读到 CMOS 0x0F=0xFE 后跳 FACS waking vector；设置 WAK_STS；保存/重建各类设备状态，BSP 恢复与 AP 再启动；分别验证 32 位和 64 位 OS 的实际唤醒入口形式。
- [x] 全核停机屏障、RTC/电源按钮等公开 wake source、wake enable、WAK_STS 与 pending SCI 一致；S3 不使用“对所有核设置 HLT”代替。
- [x] OS 主导 S4 完成 guest hibernate→磁盘写入/flush→power off→冷启动→OS 从磁盘恢复。不要用宿主 save_state/restore_state 模拟 S4；不支持 S4BIOS 就不公布对应能力。
- [x] PM timer/TSC/RTC 在运行、暂停、S3、S4、snapshot restore 时采用 P1 已定义的策略；设备恢复不重复 IRQ、不丢完成事件、不触发时间回退。
- [x] S3/S4 未通过时表中保持隐藏；通过后从同一 profile 打开，重跑 ACPI table/AML 验证，不仅修改 UI 标签。

**退出条件**：单核和多核、32/64 位目标 OS 的 S3 和 S4 各至少 20 次循环；恢复后用户程序内存校验、所有核在线、磁盘/网络/时钟/关机正确。此阶段通过后才具备本计划的完整 ACPI 电源契约。

**实施记录（2026-09-28/29）**：S3 置 CMOS 0x0F=0xFE 后停止所有核（轮转模式不再调度；宿主并行时 stop-the-world），设备定时器继续运行；电源按钮或 RTC 闹钟唤醒经 `reboot_internal("s3-wake", keep_memory)` 复位 CPU/设备、保留 RAM，SeaBIOS 走 resume 路径到 FACS waking vector，WAK_STS 与唤醒原因随后置位；公开事件 `acpi-sleep`/`acpi-wake` 与 `power_state()`。S4 是带 S4 标记的 soft-off，上电按冷启动清零 RAM（含 X6 扩展 RAM），由客户机 `resume=` 恢复；未公布 S4BIOS。`etc/system-states` 由平台描述生成，ACPICA 执行 `\_S3/\_S4/\_S5` 得到 `{1,1,0,0}`/`{2,2,0,0}`/`{0,0,0,0}`。验收：32 位 Linux 4.16（1/2/4 核 JIT、1/2 核解释器、宿主并行 4 核）与 x86_64 Alpine 3.24 lts 内核（1/2 核页层）各 20 次 S3（RTC 与电源按钮交替，RAM 校验、墙钟不倒退、所有核在线）+ 20 次 S4（marker 与 tmpfs 内容恢复、`Waking up from system sleep state S4` 恰一次）。发现并修正：内存 `BTS/BTR/BTC` 非原子导致多核 S3 在 SeaBIOS SMP 锁挂起。Windows 的 S3/S4 未验收（镜像只读）。见 [A3 记录](validation/platform/A3/sleep-hibernate.zh-CN.md)。

### W0：显式上下文 ABI（宿主并行的前提）

**修改范围**：`global_pointers.rs` 的使用者、`cpu.rs`、`js_api.rs`、`wasm_builder.rs`、IR runtime/Tier-0/backend、helper import 签名、`call_indirect` 签名。

- [x] ~~按 §3.1 第二步，把 CPU 状态访问从固定地址迁到 `ctx_ptr + field_offset`~~：改为每实例重定位（`tools/parallel_wasm.mjs` 列出所有静态地址字段，`src/parallel/relocate.js` 按实例基址改写），CPU 状态块放在低地址槽位（`slot × 4096`），生成代码、import 与 `call_indirect` 签名都不变（理由与 arm64 实测见 W0 记录）。
- [x] 每核状态随实例私有（静态、栈、堆、TLB、JIT）；每 Machine 的状态（本地 APIC、IOAPIC、INIT/SIPI/NMI 锁存、物理总线、代码页归属、扩展 RAM）只经 `crate::parallel::machine`/`machine_state` 访问，并发规则见 W1。
- [x] 单线程性能：默认构建 `v86.wasm` 不含 W0 改动（`cfg(feature = "parallel")`）；并行构建 1 核轮转的计算负载与默认构建持平（低地址槽位之前慢 1.4 倍，已剖析修正），内存负载因原子访存慢 15%。

**退出条件**：C1–C3、XC 的全部测试在新 ABI 上通过；同一 Wasm 模块可以在两个独立状态基址上交替运行而无串扰。

**实施记录（2026-09-28/29）**：`make build/v86-parallel.wasm`（稳定版 Rust，仅 v86 crate 开启 `+atomics`，`--import-memory --emit-relocs --global-base=32768`）。退出条件由 `tests/parallel/relocation.mjs`（同一 shared memory 两台机器交替运行 linux4 负载、快照互不干扰）与 C1–C3/XC 轮转套件 11/11 在并行构建上通过来满足。见 [W0 记录](validation/platform/W0/context-abi.zh-CN.md)。

### W1：宿主 Worker 并行的正确性

**修改范围**：专用 parallel Wasm 构建、Worker 启动与通信、共享 RAM、CPU runtime/allocator/SoftFloat、JIT imports、设备协调器。

这是独立的大阶段，不能以在 C2 上加 `SharedArrayBuffer` 视为完成。Wasm 的共享 memory 与原子操作有单独约束，需按照 [WebAssembly threads 设计](https://github.com/WebAssembly/threads/blob/main/proposals/threads/Overview.md) 实现和测试。

- [x] 先完成无 JIT 的 2 核原型：每 Worker 私有栈/allocator/runtime/SoftFloat 状态，共享客户机 RAM 与消息队列；禁止把完整 Rust 单核 memory 实例化 N 次后无差别共享其 heap/global。
- [x] 定义共享内存访问 ABI。首版可用更强的顺序一致 atomics 保证标量访问；未对齐、跨页、16 字节 CAS、SIMD、MMIO 等采用受协调的慢路径。普通访问同样必须参与相关排他协议，单独锁住 LOCK 指令而其他核裸读写不能提供原子性。
- [x] 审计 Rust 对共享 RAM 的所有访问，不能在别的 Worker 并发修改时通过普通引用/切片制造数据竞争；Wasm/JS 原子 helper、宿主消息边界和安全封装必须明确。guest 页表 A/D 更新也要并发安全。
- [x] 原型通过后逐类开放 JIT 内存快路径，每次通过内存序 litmus、随机调度和独立结果验证；审计 LICM/CSE/forwarding 对并发观察的假设，不能照搬单核的 RAM 不变证明。
- [x] 设备由一个协调器拥有。PIO/MMIO、DMA、IRQ、时钟和磁盘请求携带 vCPU ID/序号，通过有界队列同步/异步处理；不能在浏览器主线程阻塞等待，也不能形成“持全局锁等待设备，设备等待停核”的死锁。
- [x] 每 Worker 实例化自己的 Wasm.Table/函数引用和 JIT runtime。只共享可传递的代码/元数据；发布核对全机 generation、模式和 topology，不能把一个 Worker 的函数索引当作另一个 Worker 的有效入口。
- [x] SMC、reset、restore、S3、S5、debug pause 建立 stop-the-world rendezvous 与超时故障诊断；所有核确认退出活动帧后才能复用内存、回收代码和采集快照。
- [x] 检测 secure context、cross-origin isolation、shared Wasm memory/Atomics 支持；记录 COOP/COEP 对资源加载的要求。普通启动由内部策略自动选择后端；环境不满足时保持请求的客户机核心数并回退到轮转模式，可从只读诊断查询原因。内部测试强制并行时不得自动回退。浏览器要求参考 [SharedArrayBuffer 文档](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)。

**退出条件**：C3/A3 的同一套验收在真实并发下通过；另加入 fence/store-buffering、原子对齐/跨边界、A/D race、丢唤醒、SMC 发布竞争、设备队列溢出、Worker 异常退出/取消等测试。长期压力期间无死锁、丢 IRQ、撕裂的受保证原子值或 host panic。没有证明的快路径继续走正确慢路径。

**实施记录（2026-09-28/29）**：机器线程运行 BSP 与所有设备，AP 各在一个 vCPU Worker（`src/parallel/{machine,vcpu,control}.js`）。客户机 RAM 访问在并行构建中为顺序一致原子操作（非对齐加 fence），LOCK 读改写以 CAS 提交、冲突时从保存的寄存器重做，跨页锁与 CMPXCHG16B 用 split lock，页表 A/D 原子 OR；JIT 三层使用原子访存模板并检查对齐，LOCK/XCHG-mem 交给解释器，`ram_loop` 在 Worker 活动时禁用。跨核代码一致性：每页 OWNERS 位、发布环（安装前等待确认并复核源字节）与失效环，`poll` 在每次分发、CPUID、IRET、中断交付时执行。设备 I/O 经控制块转发到机器线程；PM timer 与端口 0x80 在 Worker 本地处理。stop-the-world 纪元协议覆盖暂停、快照、复位、S3、上电、销毁；Worker 故障释放其持有的锁并以 `emulator-error` 停机。`parallel: "auto"` 检测 SharedArrayBuffer/Atomics、shared WebAssembly.Memory、Worker、`crossOriginIsolated` 与 `v86-parallel.wasm`，不满足时保持核数以轮转运行并在诊断中给出原因；`true` 为测试用强制模式。发现并修正 10 个问题（原子性、代码发布计量、PAUSE/有界 REP 让出、CPU profile 同步、arm64 状态地址编码等）。验收：litmus（原子计数、消息传递、store buffering、跨核 SMC、IPI 唤醒环、并发 A/D）2/4/8 核 × 解释器/JIT；生命周期与三类故障注入；C3 OS 压力 4 核三后端 × 10 种子；A3 4 核 20+20；x86_64 Alpine 2/4 核；无头 Chrome（COOP/COEP）源码与 bundle。默认执行模式仍为轮转；Windows 在宿主并行下的运行结果见 W1 记录。2026-09-29 追加：litmus 增加“不同宽度的锁操作作用于同一字节”（跨 dword 边界的 LOCK ADD 与其中对齐的 LOCK ADD word）与长模式 CMPXCHG16B 对同一 qword 的 LOCK ADD 两项，发现旧实现会丢更新（2 核下分别丢 25/16000 与 58/16000），改为“无单一宿主原子覆盖的锁操作独占执行、对齐 CAS 共享提交、CMPXCHG16B 以两次 8 字节 CAS 提交”后 2/4/8 核精确；发现代码发布等待以机器时钟计时、机器暂停时可能永久自旋（soak 中卡死），改为另以检查次数封顶；S3 加压 soak（20 min、101 次 S3）通过。见 [W1 记录](validation/platform/W1/parallel-correctness.zh-CN.md)。

### W2：性能与对外能力说明

- [x] 以固定 guest 总工作量比较 1/2/4/8 核的 cooperative/parallel，覆盖计算、锁竞争、内存、I/O 四类；检查结果校验和，避免将增加工作量或不同算法当加速。
- [x] 记录宿主物理核心数、浏览器/Node、冷/热 JIT、wall time、guest work、编译时间、CPU/内存占用和同步等待比例；trace 证明至少两个核执行区间重叠。
- [x] 在预先固定且有至少 4 个可用宿主核心的 runner 上，以可并行 CPU workload 的 2/4 核吞吐显著高于单核为发布条件；P0 先约定噪声范围/阈值。不得要求所有负载随核心数线性加速，也不得无测量承诺加速倍数。
- [x] 若全局内存锁或协调器成为瓶颈，按测量优化而不是放松原子语义。可只对经过证明的地址/指令开放快路径。
- [ ] API/类型/示例/UI/worker options/state version 更新一致；普通 CPU 配置只暴露 `cpu_cores`，后端选择保持内部自动策略；保留 legacy 兼容和只读可观测回退。`acpi` 去 experimental 需 A3/R1 通过，新 x64/多核模式稳定需各自 gate 通过。

**退出条件**：有可重跑正确性和性能报告；客户机拓扑、宿主执行模式、限制和已验证 OS 都能从文档与 API 明确得知。

**实施记录（2026-09-29）**：[`tests/parallel/bench.mjs`](../tests/parallel/bench.mjs)（`make multicore-parallel-bench`）以固定总工作量、按块领取、逐轮校验和运行 compute/lock/memory/io 四类负载。Apple M1 Pro（8P+2E）上并行 4 核相对 1 核：compute 1.59×、memory 2.52×、io 1.99×，同核数下比轮转快 6–70 倍；`cpu/wall` 证明多线程同时执行；锁竞争负载不扩展（LOCK/XCHG-mem 在 Worker 中由解释器执行），8 核受能效核与并发负载限制。测量中发现并修正的瓶颈：状态块地址编码、PAUSE/有界 REP 让出、PM timer 往返、代码发布计量。API：公开配置仍只有 `cpu_cores`，`parallel` 为内部选项（`"auto"` 可回退并给出原因），默认仍为轮转；`v86.d.ts` 新增实验选项 `extended_memory_size`。见 [W2 记录](validation/platform/W2/performance.zh-CN.md)。未勾选项：公开 API/UI 的默认切换，待 Windows 宿主并行与更多浏览器记录完成后再定。

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

以下入口经 Makefile 静态核实，**本文未运行它们**。在 `v86/` 根目录执行；需按 `Readme.md` 安装 wasm32 Rust、匹配的 clang、Node、Java/Closure 等。nasm/gdb/32 位 libc/QEMU 相关测试宜在固定 Linux 容器运行；当前 macOS 宿主不能默认视为具备全部依赖。（2026-09-29 补充：`nasmtests`/`nasmtests-force-jit` 在没有 gdb 的宿主上改用 QEMU 生成参考，已在 macOS arm64 上运行并全部通过，见 [R1 nasm 记录](validation/platform/R1/nasm-qemu-reference.zh-CN.md)。）

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

除标注“已实现”的项目外，以下名称是**待实现 Makefile targets**，不能在实施报告中写成现有测试：

| 建议目标 | 用途 | 首个责任阶段 |
|---|---|---|
| `platform-contract-tests` | 配置、布局、资源、CPUID/profile、固件一致性（**已实现**：状态布局检查、profile 选项、拓扑、ACPI 表） | P0/P1/P2a |
| `acpi-device-tests` | 注入时钟、PM/SCI/GPE、按钮/复位（**已实现**，`tests/devices/acpi_device.js`） | A1 |
| `acpi-table-tests` | table-loader、RSDP/表校验、ACPICA 反汇编/重编译/执行（**已实现**，`tests/devices/acpi_tables.js`） | A2 |
| `acpi-guest-tests` | ACPI OS 启动、表校验、电源按钮、S5/上电循环（**已实现**，`tests/devices/acpi_guest.js`，含 `DISABLE_JIT=1`）；S3/S4 循环见 `acpi-sleep-tests`（**已实现**：32 位 1/2 核与解释器、x86_64 lts 内核） | A1/A3 |
| `x64-decode-tests` | REX/模式/取指边界/独立 decoder（**已实现**） | X1 |
| `x64-system-tests` | long mode、MMU、异常、MSR、CPL/IST（**已实现**） | X2 |
| `x64-differential-tests` | 指令参考结果、解释器与各 JIT 后端（**已实现**；页层另有 `x64-page-tier-tests`，含 SSE 浮点模板差分） | X3/X4 |
| `x64-guest-tests` | BIOS x64 启动、64/32 位程序和系统调用（**已实现**；多核见 `x64-multicore-guest-tests`） | X3/X4 |
| `highmem-tests` | 高物理地址、4 GiB 以上重映射窗口、DMA、快照（**已实现**）；容量见 `extended-memory-tests`（1 核与 2 核轮转）与 `x64-extended-guest-tests`（**已实现**） | X5/X6 |
| `multicore-boot-tests` | INIT/SIPI、IPI、真实 AP、固件核数（**已实现**；另有 `-release`，OS 拓扑待 C2） | C1/C2 |
| `multicore-coherence-tests` | 原子、TLB shootdown、SMC、量子/种子（**已实现**） | C3 |
| `multicore-state-tests` | 全核暂停/恢复/reset/睡眠、旧 state 导入（**已实现**） | C3/A3 |
| `multicore-parallel-tests` | shared memory、内存序、rendezvous、Worker 生命周期（**已实现**；另有 `-release`、`multicore-parallel-browser-tests`、`multicore-parallel-bench`） | W1/W2 |
| `platform-release-gate` | 聚合矩阵/基线差异/性能与兼容报告（**已实现**：`tools/release_gate.mjs`，按发布级运行并写 `build/release-gate/<时间>/report.{md,json}`；`R-base` 级含 `nasmtests(-force-jit)`） | R1 |

复用现有 `tests/kvm-unit-tests/x86/{apic,ioapic,smptest,pae,syscall,msr}.c` 时，应先审计该旧版测试的断言、构建模式和平台假设；按 profile 选择或移植最小用例。QEMU TCG 是交叉参考，不把其所有实现细节视为规范；不同 CPU vendor 的特定行为要与选定 profile 对齐。

### 6.4 R1 发布验收清单

- [x] 所有公开 feature 在能力矩阵中有实现路径、规范依据和通过的测试，无“暂时返回成功”占位（[能力矩阵](validation/platform/capability-matrix.zh-CN.md)；未实现的能力不在表中公布）。
- [x] ACPI 固件/硬件/OS 三层闭环；无要求用户关闭 ACPI 的新 profile 安装流程（A1–A3；Linux i386/x86_64 与 Windows 8.1 x64 均以 ACPI 启动；Windows 的 S3/S4 未验收）。
- [x] x64 OS、compat 用户态、异常、高地址（36 位物理地址）、所有默认执行路径闭环；超过 4 GiB 的容量已选定 X6 并以扩展 RAM 实施（X1–X6、XC）。
- [x] OS 确认 **一个封装、N 个物理核心、每核一个线程**；每核确实执行任务，核间同步正确（C2、XC：Linux 与 Windows 8.1 x64）。
- [x] cooperative 和 parallel 的能力分别验收；后者有真实并发和可重复性能证据（C3/XC；W1、W2）。
- [x] S3/S4、快照、复位、设备 I/O 在多核 x64 下通过（Alpine x86_64 2 核 20+20 次；XC 快照/reboot/S5/网络）；旧快照兼容范围：V6/V7 格式不变，扩展 RAM 只进 V7 流，状态字段 98/99 新增且可缺省。
- [ ] DOS/Windows 9x/现有 Windows NT 系列/32 位 Linux 的关键回归与基线对比，无未解释的新增失败（`make platform-release-gate` 汇总各级入口；32 位指令级回归 `nasmtests`/`nasmtests-force-jit` 15629/15629 通过，参考来自 QEMU 并有逐条说明的偏差表；DOS/Win9x 镜像回归需在有镜像的 runner 上运行，本机未验收）。
- [x] 单核性能回归超过 P0 固定阈值时有剖析和处理（C0 复测 1.095；W0 的并行构建在 arm64 上的 1.4 倍退化经剖析以低地址状态槽位消除；默认构建不含 W0/W1 的原子路径）。
- [x] 测试报告含工具链、ROM/镜像 hash、命令、种子、日志、耗时和 skips；缺环境/镜像的项目标记未验收（`tools/release_gate.mjs` 记录 commit、未提交文件、工具链、宿主与每个入口的结果和日志；各阶段记录给出镜像 SHA-256 与命令）。

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
