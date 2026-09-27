# C0 机器时钟与设备验证

日期：2026-09-27。本记录描述 `MachineClock`、PIT/RTC/ACPI 独立设备门槛，以及真实 Wasm 解释器的提交计数和确定性 fixture。完整 C0 的真实 OS 及正常模式性能结果以总体验证记录为准。

## 时间策略

- 正常模式从可注入的宿主单调函数取增量；虚拟时间从 0 开始。相同读数不增加时间，宿主倒退不倒退虚拟时间，也不在宿主追平以前重复计费。
- 单次宿主间隔默认最多计入 1000 ms。较长后台挂起只补这一段，丢弃的毫秒数和次数保存在 `get_diagnostics()`；PIT 和 RTC 将错过的周期合并为本次服务的一次 IRQ，不逐个补发。此上限可以用 `max_host_delta_ms` 配置。
- 确定性模式只按成功提交的工作量推进。普通成功指令计 1，REP 按成功元素数计数，成功的空 REP 计 1；faulting dispatch 不退休，但 REP 在异常前完成的元素保留。`instructions_per_ms` 默认 100000；调用方可直接 `advance_instructions(count)`，或用 `set_instruction_source(fn)` 提供可消费的提交量。`now()` 只消费此前已提交的进度，不给本次读取增加指令或时间。切换核心本身不增加时间。
- 全部核心 HLT 后，调度器才可显式 `advance_to(deadline_ms)`。设备返回相对 deadline，调度器将其换为绝对时间；设备读取本身不会调用前跳接口。
- `pause()` 先同步最后一段时间，再冻结单调时钟和 RTC；`resume()` 重设宿主锚点，因此不会计入暂停期间的宿主时间。未来 S3 应使用相同冻结策略；目前此接口不代表已实现 S3。
- RTC 墙钟基准单独保存。正常模式基准来自创建时的宿主 UTC，确定性模式默认固定为 2000-01-01 00:00:00 UTC，也可设置 `wall_epoch_ms`。之后日历从虚拟时间推进，不反复读取宿主 UTC。
- 快照保存时间、墙钟基准、模式、推进速率、累计提交量、HLT 前跳量和诊断。恢复时必须先恢复机器时钟，再恢复设备；宿主锚点重新建立。暂停状态沿用目的模拟器的生命周期，加载快照不会自行启动时钟。

## 设备改动

PIT、RTC 和 ACPI 的所有当前时间读取均经过 `cpu.clock`。ACPI 保留原 `acpi.clock` 可注入函数，因此既有设备级测试仍可直接设置 PM 时间。

PIT 使用绝对 deadline 判断到期并保留周期相位，避免浮点毫秒换回整数 tick 时漏掉恰好到期的 IRQ。周期计数到 0 时重新装载；单次模式到 0 后停止。RTC periodic/alarm/update 可以同时锁存，避免高频 periodic 分支饿死另外两类事件；到期后下一次周期 deadline 严格位于未来。

RTC 新增 state[15] 标记，表明 deadline 已使用机器单调时间。旧快照以保存的 `last_update` 将 UTC deadline 换到当前单调域，保留剩余间隔及保存的日历，不计入离线时间。缺少 MachineClock 状态的旧快照没有共同的宿主单调锚点：恢复时将 PIT 起点和 LAPIC `timer_last_tick` 重新锚定到目的机器当前时间、保留保存的计数寄存器，并从 RTC 日历重建机器墙钟 epoch。这是避免旧宿主启动时长干扰定时器的尽力迁移，不承诺旧 PIT/LAPIC 的精确相位。

## Rust 提交接口

`cpu::execution` 在确定性解释器的外层 dispatch 提供 `begin_instruction()` / `finish_instruction()`；开始点在取得 opcode 之后、执行指令语义之前；更早的取指异常不会进入提交过程。同步异常调用 `mark_fault()`，异步 IRQ 或指令完成后的 trap 不应调用此标记。`string_instruction` 一次性记录 `StringExecution` 结果；IR/JIT 的独立字符串入口不伪造解释器提交量。`take_clock_progress()` 返回并消费先前完成的工作量，允许在下一条 PIO 的 JS 回调中取时钟，而不把当前 PIO 自身提前退休。

`set_deterministic_execution(bool)` 控制确定性执行模式，`is_deterministic()` 供调度与 STI shadow 查询；`reset()` 清除临时计数而保留模式。该计数器在完整指令边界之间为 Machine 的临时状态，不随 vCPU 换入换出，也不把宿主正常模式的 dispatch 统计宣称为精确退休量。正常模式保留原执行路径；确定性模式由调用方禁用 JIT/IR，并禁止嵌套的外层 dispatch。

## 独立验证

命令：`node tests/smp/clock.mjs`。11 项通过，不需要 Wasm 构建。

1. 正常模式单调、重复读取不强推、宿主长暂停上限及诊断。
2. 暂停冻结和恢复排除宿主暂停时间。
3. 提交进度仅消费一次、分片粒度不影响累计时间、读取次数不影响时间。
4. 快照恢复时间和 RTC 基准，与目的宿主时间无关。
5. 相同输入重复两次得到相同 PIT/RTC/PM IRQ 序列、PM 读数和 RTC 日历值，包含 PM bit 23 翻转。
6. HLT 恰好跳到 PIT/RTC deadline 时可发 IRQ，且下一 deadline 位于未来。
7. 机器及设备快照恢复 PIT/RTC/PM 相位，继续执行后仍一致。
8. reload=1/17/1193/65535 各重复 10000 次 PIT 精确 deadline 前跳，共 40000 次无漏发或零间隔停滞。
9. 同时到期的 RTC periodic/alarm/update 都被锁存。
10. 旧 RTC UTC 快照迁移。
11. 非法时钟参数、提交量及 deadline 被拒绝。

这组独立测试没有执行客户机，因此不单独证明串口输出重现或单核启动性能。

## Wasm 解释器集成验证

命令：`node tests/smp/clock_execution.mjs`。debug/release Wasm 均 12 项通过；`TEST_RELEASE_BUILD=1` 选择发布构建。

1. NOP、带 prefix 的 NOP 和 HLT 各退休一次；UD2 的 #UD 分派不退休，异常处理器中的 HLT 正常退休。
2. 2 核配置的 REP STOSB 每片最多 256 元素，1000 个元素及最终 HLT 合计 1001 工作量；空 REP 仍退休一次。
3. STI 在第一个 slice 结束保留 shadow，下一 slice 先执行 INC，再接受待决 self IPI；投递本身不重复计数。
4. 32 位分页客户机中的 address16 REP STOSB 在第 6 个元素触发 #PF，先前 5 次写入、ECX/EDI 和 5 个已提交工作量均保留，异常元素不退休。
5. 客户机在一个 Wasm slice 内反复 `IN EAX,DX` 读真实 PM 端口，8 个结果严格递增；分片内部的设备读可消费此前提交量，没有“执行完 slice 才能读到时间”的停滞。
6. 真正调用 `save_state()` / `restore_state()` 后，虚拟时间、RTC epoch 和提交量恢复一致；暂停时显式 deadline 前跳也不增加时间，恢复执行按后续提交继续推进。
7. 固定 x86 指令镜像、输入、轮转 seed 的 2 核配置运行两次，IRQ 序列及时间戳、64 个客户机 PM 读数、串口 `K\n`、提交量和最终虚拟时间完全相同。该 fixture 不把第二核启动或 Linux 启动算作本项测试内容。
8. 每核重复写 TSC、虚拟时间推进后再写 TSC，以及正常模式非零初始 offset，均读回最后写入的值。审查发现并修复旧 `set_tsc` 重复扣除 offset 的问题。
9. 确定性客户机以 CF9 OUT 请求复位，OUT 完成并让出到安全点后才替换 CPU 状态；提交计数器不再因执行途中 reset 触发断言，后续指令也不越过复位请求执行。
10. 客户机在 slice 内编程 PIT 后 HLT，下一轮按新配置计算 deadline，不再使用编程前 100 ms 的默认等待而跳过首次到期。
11. 正常模式快照用随读取递增的可注入宿主时间检测混用时刻；save/restore 全事务冻结时钟，RTC、PM、机器快照采用同一时刻，完成后保留原先 run/pause 生命周期。
12. 构造真正使用旧 RTC UTC 字段和旧宿主单调锚点的快照，恢复后 RTC 日历与机器墙钟一致、周期 IRQ 剩余时间保留，PIT/LAPIC 立即锚定当前时间；LAPIC 在约定的 1 ms 后到期，不受构造的 10 亿 ms 旧宿主锚点影响。

Rust `execution.rs` 同时附带四项无共享全局状态的计数单元测试，交由统一 Rust 测试入口执行。上述 Wasm 集成测试验证了它的实际解释器接线，不仅比较模拟的计数器。
