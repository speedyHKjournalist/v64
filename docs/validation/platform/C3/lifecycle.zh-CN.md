# C3 全机状态、时钟与安全点

日期：2026-09-27。覆盖协作式单 Wasm 机器；运行时只有一个核心位于固定地址状态块中，其他核心保持独立寄存器和稀疏 TLB。

## 实现

- `src/rust/cpu/context.rs` 保存每核 TLB 翻译及 TSC offset。换核时搬运有效翻译，保留客户机页表缓存语义；载入时仅重算共享代码缓存对应的 `TLB_HAS_CODE`。快照保存客户机物理地址与属性，避免把源 Wasm RAM 的宿主指针带到另一个实例。
- CPU state 的兼容槽 95 为机器时钟，96 为带版本的全机核心状态。记录活动核、核数、quantum、PRNG seed/round、全部固定核心区域、184 字节 LAPIC、48 字节 APIC AUX、INIT/SIPI/NMI/ExtINT、TSC offset、TLB 和调度统计。代码缓存重新编译。
- restore 首先验证拓扑、区域长度与 TLB 页条目，然后才修改目标。旧单核快照可以恢复；旧 host-absolute PIT/LAPIC deadline 没有共同时间锚点，只能保留计数并重新开始相位，RTC 保留日历。核数不同则拒绝，不在导入过程中创建/删除核。
- 从串口/PIO 等同步设备监听器发起的 save/restore 请求通过 microtask 延迟到 Wasm 栈和整个机器轮次返回后的安全点。
- 公共 save/restore 的整个序列化事务冻结时钟，用 `finally` 恢复调用前的 pause/run 状态，避免 RAM 打包期间 RTC/PM 与 TSC/PIT 相位漂移。
- `execution_epoch` 在 restore/reset 递增。持有旧 epoch 的异步 Wasm 编译结果不再安装 table slot，也不取消或结束新一代编译任务。Rust 原有代码页 generation/owner 验证仍保留。
- CF9/8042 的客户机 OUT 只请求让出。真正全机复位在 Wasm 指令返回后的安全点执行；BSP 回到 reset vector，AP 回到 wait-for-SIPI，事件清空。AP INIT 只重置目标核心，且保留其 TSC offset。
- S4/S5 的既有 soft-off 路径在机器切片结束后停止 runner，并冻结统一时钟；S3 尚未公开，完整睡眠恢复属于 A3 的后续门槛。

## 验证

`node tests/smp/lifecycle.mjs`（发布构建加 `TEST_RELEASE_BUILD=1`）：

- 1/2/3/4/8 核：所有核心寄存器、运行/等待/HLT、NMI blocking/pending、ExtINT、STI shadow、TSC offset、APIC、调度顺序保存恢复一致。
- 同一核心连续写两次 TSC，换核及恢复后保留最终写入值。
- 尝试将状态导入不同核数机器，验证异常且目标 RAM、全部核心与时钟未变。
- 全机 reset 回 BSP、AP 等待 SIPI，清除旧 INIT/SIPI/NMI。
- 真正的客户机 OUT 在同步设备回调中请求公开 save_state，断言采集发生于 Wasm 之外且包含已完成 OUT/HLT。
- 两核都执行 REP STOSB，各提交 256/1000 元素时快照；直接完成与恢复后完成的 RAM、全部核心、调度 seed/round 和提交量时钟逐项相等。

`node tests/smp/publication.mjs`：使用真实 JS 发布桥，挂起 Wasm 实例化 Promise 后调用真正的 restore/reset；恢复相同 owner 对象以排除仅凭对象变更拒绝的假通过，确认 epoch 拒绝旧结果且没有安装、取消或完成新 table slot。该测试验证桥接时序；真实 guest SMC/generation/DMA 路径在 `coherence.mjs` 中独立验证。

以上 debug/release 均通过。时钟精确提交、异常/REP/STI、运行中时间事务、客户机 CF9、旧快照迁移参见 [C0](../C0/clock-and-devices.zh-CN.md)。未把这些微测试解释为所有设备队列、磁盘或网络负载下的恢复压力验收。

## 集成检查

- `make rust-test`：305 passed、0 failed、6 ignored，`-D warnings`。
- `make kvm-unit-test-apic`：IOAPIC 19 PASS、SMP 1 PASS、APIC 11 PASS/1 SKIP（TSC deadline 未声明支持）。
- `make ir-cpu-info-tests`：debug/release 分别验证 3920 CPUID、2926 MSR、336 FS/GS、224 RDTSC、280 权限、8 非法 APIC_BASE 的客户机 #GP 等差分场景。非法 APIC_BASE 从旧的 debug host panic/release 静默接受改为两个构建一致的 #GP，并验证输入与 enable 状态不变、fault EIP 正确。
- `make smp-tests`：解释器/JIT 状态交替与独立执行一致；故意跳过 TLB 刷新的原始负向控制仍可检出上下文串扰。
- 时钟/启动/拓扑/快照/发布及 101 场景一致性矩阵的 debug/release 检查均通过；ESLint 修改范围、布局生成检查、`git diff --check` 通过。
- Linux 15 个配置使用固定 debug 产物，保留具体 hash 与原始证据；未声称跑过 release OS 或 Windows。
