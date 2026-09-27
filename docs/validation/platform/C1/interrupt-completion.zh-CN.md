# C1 中断控制器语义补全

日期：2026-09-27；接续 `bb8979f3`。本记录补充[前次启动与调度审查](review-and-validation.zh-CN.md)，不替代 C0 时钟、C2 OS 拓扑和 C3 全机恢复的独立验收。

## 修复与模型

| 问题 | 当前行为 |
|---|---|
| `IA32_APIC_BASE.EN` 只存在于当前 CPU 的状态块，向其他核投递时无法判断其是否关闭 | 每核独立硬件使能；关闭后 MMIO 读 `FFFFFFFF`、写忽略，停止接受 APIC 消息和 timer；其他核不受影响。重新开启后 LAPIC 处于软件禁止状态 |
| SVR 的软件使能位没有参与 fixed/lowest-priority 接收和 CPU ack | 软件禁止时拒收新 fixed/lowest，保留 IRR/ISR，mask 全部 LVT，禁止软件重新 unmask；INIT/NMI/SIPI 仍有效。重新使能后原 pending IRQ 可继续被接受 |
| PIC 无条件交给 BSP，LINT0 mask 和 IOAPIC ExtINT destination 无效 | 显式平台 virtual-wire：上电 BSP 的 LINT0 配为未屏蔽 ExtINT，AP 的 LINT0 屏蔽。客户机可屏蔽 BSP LINT0，并将 PIC 经 IOAPIC 输入 0 的 ExtINT RTE 路由至 AP。ExtINT 在目标 CPU 实际接受时读取 PIC vector，不受 LAPIC TPR 限制，不进入 LAPIC ISR |
| lowest-priority 会选择软件/硬件禁止的 APIC | 仲裁仅包含可接受 fixed IRQ 的目标，按 PPR class、APIC ID 确定一个接收者 |
| cluster broadcast 错当全核广播，保留 DFR 值错当 cluster | cluster `F` 广播仍尊重低四位 member mask；仅 DFR `F`/`0` 分别实现 flat/cluster，其他值不匹配逻辑目标 |
| reserved ICR/IOAPIC delivery mode 会触发宿主断言或假投为 fixed | 不支持 SMI 和保留 delivery mode 均不注入 fixed IRQ；ICR ExtINT 也按保留编码忽略。非法 vector `<10h` 记录 ESR，不注入；`FFh` 可作为普通 fixed vector |
| 在 level IRQ 的 ISR 尚未 EOI 时，同 vector 的新 edge IRQ 覆盖 TMR，导致 IOAPIC remote IRR 永不清除 | 独立保留 queued IRQ trigger mode；EOI 使用当前 ISR 的 mode，只清 ISR、不清最后接受的 TMR，下一次 ack 再装入 queued mode。集成 xAPIC 的普通 IPI 按 edge 处理 |
| IOAPIC 对 NMI/INIT/ExtINT 设置 remote IRR，之后没有 LAPIC EOI 可清除 | 仅 level fixed/lowest 在目标接受后设置 remote IRR；mask/unmask 和正常 level EOI 重投递仍经同一路由 |
| masked LAPIC one-shot 在 unmask 时补发已经过期事件；periodic timer 大幅迟到后丢失相位；保留 timer mode 导致 host panic | 改 LVT 前按旧 mask/mode处理到当前时刻；过期 one-shot 不补发；periodic 迟到合并为一个 pending IRQ并保留相位；未公布 TSC-deadline 和保留 timer mode 停止、不崩溃 |

BSP 上电未屏蔽 LINT0 是 v86 明确的传统 PIC 启动兼容配置，不声明为裸硬件 RESET 所有 LVT 的 Intel 默认值。`acpi:false` 或 BSP 硬件禁止 LAPIC 时仍保留传统直接 PIC。LINT0 的 PIC 输入当前只实现所需的 ExtINT 模式，未新增 SMM/SMI 或 PIC 输入改配成 NMI/fixed 的能力。

规则依据：[Intel SDM Vol. 3A 的 APIC 章节](https://cdrdv2-public.intel.com/835754/253668-sdm-vol-3a.pdf)，尤其使能/禁止、软件禁止后的状态、ICR 与 EOI。硬件禁止时 MMIO 返回值和重新开启语义也核对了 [QEMU `hw/intc/apic.c`](https://github.com/qemu/qemu/blob/master/hw/intc/apic.c)。所有实现选择以当前 v86 的公开能力为界，不表示复现实体处理器的仲裁时序。

## 状态与调用接口

原 `Apic` 的 184 字节布局不变。每核新增独立 `ApicAux` 48 字节：

| 偏移 | 字段 |
|---|---|
| 0 | `u32 hardware_enabled` |
| 4 | `u32 extint_pending` |
| 8 | `[u32;8] pending_tmr` |
| 40 | `u32 ipi_sent` |
| 44 | `u32 ipi_received` |

`apic_aux_addr(core)`/`apic_aux_size()` 用于完整快照；`apic_restore_legacy_aux(core, enabled)` 为旧快照从 IRR/TMR 重建 queued trigger mode。IPI 计数按核导出供诊断读取，按 `u32` 回绕。

`apic::acknowledge_pic_irq()` 取代 CPU 无条件 BSP PIC ack。只读 `routed_pic_pending(core)` 与 `apic_core_interrupt_pending(core)` 共用路由政策，因此 HLT 唤醒检查不会提前 ack PIC。后者也包含该核可以接受的 PIC 请求。

## 验证结果

| 命令 | 结果 |
|---|---|
| `cargo test --lib cpu::apic --target aarch64-apple-darwin` | 7/7 通过；新增 6 项 覆盖 硬件/软件禁止、vector/ESR、同 vector queued mode、periodic 相位、masked one-shot、保留 timer mode |
| `node tests/smp/apic_routing.mjs` | debug Wasm 2/4/8 核全部通过；实际执行 guest WRMSR/OUT 验证 CPU/MSR/PIC 控制器接线，不只修改宿主状态 |
| `TEST_RELEASE_BUILD=1 node tests/smp/apic_routing.mjs` | release JS/Wasm 2/4/8 核全部通过；本地日志 `build/c1-apic-routing-release.log` |
| `node --check tests/smp/apic_routing.mjs` | 通过 |
| `make kvm-unit-test-apic` | EOI 修复后 `ioapic/smptest/apic` 分别 19/1/11 PASS；apic 的 1 SKIP 是未公布的 TSC-deadline timer |

扩展路由夹具还验证真实 PIC 经 IOAPIC ExtINT 投至 AP（BSP LINT0 已屏蔽），并检查 vector 来自 PIC、TPR 不阻止接受、LAPIC ISR/IOAPIC remote IRR 不锁住。原有 INIT/SIPI 顺序、NMI、physical/shorthand/flat/cluster、优先级和 level EOI 重投递检查全部保留。

KVM 与整机 OS 回归结果由相应统一构建/运行日志补充，不能由路由夹具结果外推。本机没有可用 `eslint`；未将未执行的 lint 写为通过。

完整 KVM 回归还检出了补全初版的一项回退：EOI 曾把 TMR 一起清零，导致 `ioapic.flat` 的 level→level 和 level→edge 两个“先读取旧 TMR”场景失败。已修复为 EOI 仅清 ISR，TMR 保留最后接受的 mode，并在 JS 路由夹具增加直接断言。没有通过改动 KVM 的预期值掩盖问题。
