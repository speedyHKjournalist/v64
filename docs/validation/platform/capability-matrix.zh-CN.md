# 能力矩阵（P0 / R1）

每项能力：是否公布（公开选项/默认行为）、适用模式、各执行后端状态、规范出处、验收入口、已知限制。状态截至 2026-09-29（`7a281f34 + 未提交修改`）。“内部”指只经测试开关或内部选项启用、不在 `v86.d.ts` 中作为稳定能力公布。

## 平台与 ACPI

| 能力 | 公布 | 规范 | 验收入口 | 状态 / 限制 |
| --- | --- | --- | --- | --- |
| 平台描述（端口、IRQ、PCI 窗口、核数的唯一来源） | 默认 | — | `platform-contract-tests` | 通过；设备实例化仍在 `cpu.js` |
| RSDP/XSDT/FADT(rev≥3, RESET_REG)/DSDT/MADT，经 SeaBIOS table-loader | `acpi: true` | ACPI 6.6 §5 | `acpi-table-tests`（ACPICA 反汇编/重编译/执行） | 通过 |
| PM1 事件/控制、PM timer、GPE0、SCI（电平、W1C）、SMI_CMD、电源按钮、复位寄存器 | `acpi: true` | ACPI 6.6 §4 | `acpi-device-tests`、`acpi-guest-tests` | 通过 |
| S5 soft-off、上电 | `acpi: true` | §7.4 | `acpi-guest-tests` | 通过 |
| S3 挂起到内存（RTC/电源按钮唤醒，SeaBIOS resume） | `acpi: true` | §7.4、§16 | `acpi-sleep-tests`、[A3](A3/sleep-hibernate.zh-CN.md) | 通过：32 位 1/2/4 核 × JIT/解释器、并行 4 核、x86_64 1/2 核各 20 次 |
| S4 OS 主导休眠 | `acpi: true` | §16.1 | 同上 | 通过（同上）；不支持 S4BIOS |
| PCI 中断路由（_PRT、链接设备）、IOAPIC | `acpi: true` | §6.2.13 | `acpi-guest-tests`、C1 | 通过 |
| HPET、MCFG/ECAM、EC/电池/温控、S1/S2、x2APIC、NUMA | 不公布 | — | — | 未实现，表中不出现 |

## CPU

| 能力 | 公布 | 解释器 | 32 位 Tier-0 / 区域 IR | x64 页层 | 验收入口 | 状态 / 限制 |
| --- | --- | --- | --- | --- | --- | --- |
| 32 位保护模式、分页、PAE、SSE/SSE2/SSE3、x87 | 默认 | 是 | 是 | — | `nasmtests(-force-jit)`、qemu/kvm-unit-tests、IR suite | nasm 15629/15629（无 gdb 宿主上以 QEMU 生成参考，已知 QEMU 偏差见 [R1 nasm 记录](R1/nasm-qemu-reference.zh-CN.md)）；SSE 算术的 NaN 结果不再依赖宿主 |
| 长模式/兼容模式、NX、SYSCALL/SYSRET、CX16、LAHF/SAHF-LM、RDTSCP、CLFLUSH、IA32_ARCH_CAPABILITIES；48 位线性、36 位物理地址 | `experimental_x64`（实验） | 是 | 兼容模式代码经 32 位 IR | 是 | `x64-decode-tests`、`x64-system-tests`、`x64-differential-tests`、`x64-page-tier-tests`、`x64-guest-tests` | 通过；不公布 AVX/XSAVE/BMI/LA57/1 GiB 页/PCID/VMX；x64 区域管线未实施 |
| x64 页层 SSE：移动、逻辑、ADD/SUB/MUL/DIV（PS/PD/SS/SD） | 随 x64 | 是 | — | 模板（FP 在 MXCSR 默认且 PE 已置位、操作数/结果正常时原生，否则解释器） | `x64-page-tier-tests`（`sse_fp_template.mjs`） | 通过；其余 SSE 算术逐条解释 |
| 1 socket × N cores × 1 thread，N = 1..8 | `cpu_cores`（实验） | 是 | `experimental_smp_jit` 下是 | 是 | `multicore-boot-tests`、`multicore-topology-tests`、`multicore-linux-tests` | 通过（Linux i386/x86_64、Windows 8.1 x64 拓扑） |
| 核间一致性（原子、TLB shootdown、SMC、快照/复位） | 随 `cpu_cores` | 是 | 是 | 是 | `multicore-coherence-tests`、`multicore-atomic-tests`、`multicore-memory-order-tests`、`multicore-state-tests`、`multicore-os-stress-tests` | 通过 |
| 宿主并行（vCPU Worker） | 库：内部选项 `parallel`；index.html：多核时自动（需 COOP/COEP，可关闭） | 是 | 是 | 是 | `multicore-parallel-tests(-release)`、`multicore-parallel-browser-tests`、[W1](W1/parallel-correctness.zh-CN.md) | 正确性通过（含不同宽度与 16 字节锁操作的互斥、长模式 CMPXCHG16B litmus、S3 加压 soak）；LOCK 与 XCHG-mem 由解释器执行；默认仍为轮转 |

## 内存

| 能力 | 公布 | 验收入口 | 状态 / 限制 |
| --- | --- | --- | --- |
| RAM ≤ 2 GiB − 128 KiB（wasm32） | `memory_size` | 既有 | — |
| 36 位物理总线、RAM 重映射到 4 GiB 以上、高位 MMIO、64 位 DMA 地址 | `high_memory_size`（测试） | `highmem-tests`、[X5](X5/physical-bus.zh-CN.md) | 通过；32 位 PAE 旧路径不支持 4 GiB 以上的页表项 |
| 超过 wasm32 的 RAM 容量（扩展 RAM） | `extended_memory_size`（实验） | `extended-memory-tests`、`x64-extended-guest-tests`、[X6](X6/extended-memory.zh-CN.md) | 6 GiB fixture（1 核与 2 核轮转）与 Alpine x86_64 6.5 GiB（5 GiB memtest 全在扩展 RAM、0 错误）通过；其中的代码只解释执行；宿主并行时只走慢路径 |
| 整机快照：V6 单缓冲、V7 分块流 | 默认 | `multicore-state-tests`、X5/X6 | 通过；扩展 RAM 只进 V7 流 |

## 已知缺陷与未验收（不计为通过）

- 4 核 x86_64 Linux 曾出现一次 poweroff 后未进入 S5 的挂起，之后累计多次生命周期未复现，根因未定位（见 [XC 记录](XC/linux64-boot.zh-CN.md)）。
- Windows：8.1 x64 在页层 1/2/4 核启动与探针通过；解释器下未运行（过慢）；S3/S4 未验收；宿主并行下的运行记录见 W1。
- 浏览器：宿主并行只在 Chrome（headless，COOP/COEP）验证；Firefox/Safari 未记录。
- `nasmtests` 在无 gdb 宿主上的参考来自 QEMU TCG：x87 栈错误类测试（920 个）不比较 st/FSW；FPREM 在无效运算后的条件码没有硬件参考（见 [R1 nasm 记录](R1/nasm-qemu-reference.zh-CN.md)）。
