# C1 子任务：未提交改动审查、AP 启动与有界解释器调度

日期：2026-09-27。接手 commit：`8edd6d699e66801d021b4504d165c2b3a09f5a36`，工作区已有 A2/P1/P2a 和部分 C1 改动；不是主计划原始基线的干净 checkout。本轮保留这些改动继续推进，没有提交或重置工作区。

本次只完成 C1 的启动/调度子门槛。C0 尚未完成，不能将本记录当作完整 C1、C2 或 `R-SMP32` 的验收。主计划和本记录共同给出当前能力边界。

## Review 结论与修复

| 优先级 | 问题与触发条件 | 修复与回归 |
|---|---|---|
| P1 | 恢复 CPU 快照时 ACPI 先于 PCI 恢复，按旧 PMBA/PMREGMISC 重建端口；恢复后 PCI 配置与实际解码不一致，客户机 PM 块不可访问 | PCI 配置恢复后调用 ACPI decode hook；测基址变化、启用/禁用方向和 RCR 保存恢复 |
| P1 | BSP 为 CLI+HLT、AP 等待自己的 LAPIC timer 时，没有任何核再服务定时器，AP 永远不能唤醒 | Machine 每轮无条件服务一次定时器；各核 slice/HLT 不重复服务，测试真实 AP timer 唤醒 |
| P1 | 同一切片的第二个 SIPI 覆盖第一个 vector；较晚 INIT 还可能保留更早的 SIPI/NMI | INIT 覆盖旧启动事件并清先前 NMI；只锁存首个 SIPI。guest 测两种 vector 顺序和重新 INIT |
| P1 | 单核快照遗漏新增的 NMI blocked/pending、APIC enable、未处理启动事件；多核只拒绝保存却接受单核快照恢复 | CPU state[94] 增加可选中断状态；旧快照缺字段时使用默认值；多核 restore 在解析/写 RAM 前拒绝 |
| P1 | WRMSR FS/GS base 的非零高位在 debug 导致宿主断言，在 release 静默截断；IR WRMSR adapter 也必须识别 guest fault | 高位拒绝为 guest #GP，保留原 base；IR fault 不算成功提交，差分测试覆盖低位、异常帧和每核隔离 |
| P2 | CF9 handler 误嵌入 CF8 第四字节写回调，首次 PCI 配置访问前不能复位，后续配置访问又清空 RCR | 构造时注册一次；字节复位与 CF8 word/dword 访问分离，保存/恢复 RCR |
| P1 | 连续 STI 递归执行下一条，`run_cpu_slice(1)` 可执行 101 条甚至耗尽宿主栈 | 多核仅 IF 从 0→1 时执行一条 shadow 指令；预算计入递归步骤，最多超额一条；连续 STI 和 CLI/STI/NOP 回归 |
| P2 | 旧调度每核调用完整主循环，预算取决于宿主时间，临时 debug 字典持续增长；无 PAUSE 忙等不能按指令预算退出 | 新解释器 slice 有 dispatch 上限，删除临时 debug 结构，输出每核 slices/steps 诊断 |
| P2 | APIC 的 ISR 比较允许同一优先级类别中断嵌套；ICR/EOI 路由可能在持有 APIC 可变引用期间再次借用它 | 共享 PPR 类别判断，路由在原引用结束后执行；测试同级抑制、目标核选择和电平 EOI 重投递 |

优先级含义：P1 会造成客户机停机、状态错误或宿主失败；P2 影响特定访问/调度情形。最低优先级仲裁采用确定性的 PPR 类别/ID 次序，未宣称复现某个实体 CPU 的总线仲裁实现。NMI 回归使用合法物理目的地址，不把保留的 self-NMI shorthand 当作公开能力。优先级和 IPI 语义参照 [Intel SDM Vol. 3A §12.6–12.8](https://cdrdv2-public.intel.com/835754/253668-sdm-vol-3a.pdf)。

## 接口与实现范围

- `CPU.run_cores()` 负责事件和核选择，Rust `run_cpu_slice(budget)` 只运行当前核解释器；每核每轮预算 4096 dispatch，STI shadow 最多超额一条。正常指令完整执行，REP 可在最多 256 元素后的合法续跑点让出。该计数不是退休指令时钟。
- 每轮统一服务 PIT/RTC/ACPI/全部 LAPIC timers；BSP 的 CLI+HLT 不阻止其他核的定时器。给已经轮过的核发送 IPI 会请求下一轮；IF=0 的 HLT 核不会因不可接受的 maskable IPI 忙等。
- 新的 startup event peek/restore 接口支持单核快照。CPU state 版本仍是 6，新增可选 slot[94]；旧快照使用默认中断状态。多核保存/恢复仍明确不支持。
- 默认仍为一核。`cpu_cores` 接受整数 1..8，多核要求 `acpi: true`，且自动禁用 JIT。APIC 与 ACPI 配置分离仍未实现。
- x86-64、宿主 Worker 并行、S3/S4、完整 OS 拓扑没有新增完成声明。当前每次换核清本地运行时 TLB，不能用于证明 C3 的跨核 shootdown 正确性。

## 验证

工具链、ROM、内核和 fixture SHA-256 见 [manifest.json](manifest.json)。宿主为 macOS arm64、Node 25.6.0、Rust 1.93.1、NASM 3.01。日志保存在本地 `build/c1-*.log`，不提交大型构建产物。

| 命令/入口 | 结果 |
|---|---|
| `make multicore-boot-tests` | 2/4/8 核 guest INIT/SIPI、独立状态、IPI/HLT/re-INIT；路由、scheduler、snapshot guard 通过；真实 SeaBIOS 另覆盖 3 核 |
| `make multicore-boot-tests-release` | 相同测试使用 release JS/Wasm，通过 |
| `make smp-tests` | 原 P2a JIT/解释器换核对照通过；关闭 TLB flush 的负向控制产生差异 |
| AP startup 负向控制 | 临时模拟旧“第二个 SIPI 覆盖”行为，2/4/8 核都被 first-vector 断言检出 |
| SeaBIOS 负向控制 | 阻止 AP 执行但不改核数，BIOS rendezvous 超时，没有 boot marker；正常版本 POST/软盘启动通过 |
| `make ir-cpu-info-tests` | debug/release 各 3920 CPUID、2926 MSR、336 FS/GS 低位/高位 #GP、48 次实际换核后的 MSR 读取；TSC/CPL/VM86/异常回归通过 |
| release JS/Wasm、Worker、ADVANCED browser 构建 | Closure 0 error / 0 warning；Wasm 构建通过 |
| `make rust-test` | 292 passed、6 ignored；Wasm builder 输出验证通过 |
| KVM taskswitch/taskswitch2 | 正常退出；taskswitch2 11 PASS |
| KVM realmode | 127 PASS；首次并发构建时在末尾性能循环超过 60s，单独 `--timeout 120 --expect-pass 127` 重跑正常退出 |
| KVM ioapic/smptest/apic | 19 / 1 / 11 PASS；apic 的 1 SKIP 为未公布的 TSC deadline timer；原 3 个 apic_disable FAIL 已消除 |
| ACPI device/table | 19 / 5 通过；本次 PATH 无 `iasl`/`acpiexec`，2 项 ACPICA 检查跳过 |
| Linux 6.8 PIC、Linux 4.16 IOAPIC | 串行运行通过表、SCI、电源按钮、PM timer、FADT reset 和一次 S5 循环 |
| API reset/reboot/state | reset/reboot 通过；state 四种配置串行通过，包含启动中 snapshot |
| JS lint | 本次涉及的 source/test/generator 文件通过；全仓库有 90 个错误，均在未修改的已有测试/bench 文件 |
| `make rustfmt` | 未通过：当前 stable rustfmt 不接受仓库使用的部分 nightly 配置，全仓库多处已有格式差异；没有进行无关格式改写 |

首次高负载并发运行中，两种 Linux 的 `current_clocksource` 检查读到旧时钟源，API state 首次恢复也长时间未到提示符；原命令串行重跑通过。失败日志保留，测试补充 clocksource/dmesg 与快照前后 CPU 诊断及超时，不删除硬件断言。这仍是需要 C0 与后续压力回归调查的时序敏感性，不能写成确定性验收已完成。

## 兼容性、回退与下一步

一核仍走原有 JIT/main-loop 路径；增加 APIC_BASE.BSP 和 per-core APIC ID 的正确返回。无固定工作量单核性能基准，不能据此给出吞吐无回退结论。多核 JIT 和宿主并行未开放。

回退使用 `cpu_cores: 1`（或省略），单核 state v6 可继续读取；本轮未生成可持久化的多核 state，也未修改镜像或 ROM。

接下来先做 C0：统一 Machine clock、明确暂停/快照策略和可复现事件队列，再补 C1 的 ExtINT、APIC enable/保留编码等完整语义；C2 再统一 CPUID 拓扑并用 Linux 检验 1 socket × N cores × 1 thread。C3 的跨核原子、TLB、SMC、全机恢复和 JIT 安全门槛仍全部保留。Windows 与 x86-64 OS 未验收。
