# v86 IR：设计、架构与 Legacy JIT 对比

本文是 IR 的统一说明，以当前源码为准。**IR 已是唯一 JIT，Tier-0 默认开启**；
Legacy JIT 的分析器和代码生成器已移除。未编译或不能安全编译的代码仍由解释器执行。
旧设计、指令专题、实施进度及评审文档合并至此；覆盖目录和原始测量数据继续保留。

## 1. 设计思路

### 用两条编译路径兼顾启动速度与优化能力

- **Tier-0 页编译**：按代码页累计解释执行热度，从已观察入口发现基本块，直接用模板生成 Wasm，
  不构建 SSA、不运行完整区域优化管线。页内跳转、调用和返回尽量在同一函数内分派；
  高频跨页转移可以促成多页函数，最多包含 6 个连续或不连续的代码页。
- **Tier-1/2 区域编译**：把 x86 指令提升为显式中间表示，再进行优化和 Wasm lowering。
  Tier-1 使用低成本规范化和状态裁剪；Tier-2 增加跨块值复用、常量传播、循环及受守卫的访存优化。
- **解释器兜底**：冷代码、缺失入口和不满足编译条件的路径继续解释执行；Tier-0 无原生模板的指令
  通过单步助手执行，再按返回状态决定继续或退出。

当前默认主要使用 Tier-0；非 32 位代码及 Tier-0 编译失败或拒绝的入口仍可进入区域编译。
设置 `ir_tier0: false` 可使用区域管线。**当前没有通用的 Tier-0 → Tier-1 → Tier-2 自动升档链**；
区域管线自身保留 Tier-1 → Tier-2 升档。

### 把语义、优化与机器代码生成分开

区域管线的核心表示是：

- **HIR（高层 IR）**：用带类型的 SSA 值、基本块参数和 CFG 表达计算；显式处理 AL/AH/AX 等寄存器别名、
  FLAGS 来源以及 XMM 值。纯计算和有副作用的操作分开，便于判断哪些值可以折叠、复用或删除。
- **Effect 与 StateMap**：Effect 表示访存、helper、I/O 等操作的顺序；StateMap 记录观察点、故障点和出口
  应恢复的寄存器、FLAGS、EIP 与指令提交进度。恢复点需要的值也参与活跃性分析，不能被优化误删。
- **MIR（机器 IR）**：独立拥有值表达式、类型化局部变量、边复制、控制流、访存、helper 调用及状态物化计划。
  lowering 完成后即可释放 HIR；Wasm 后端消费 MIR，无需回看 x86 指令或调用旧代码生成器。

Tier-0 使用另一种低成本状态模型：GPR、XMM 和部分 x87 状态缓存在 Wasm 局部变量中，FLAGS 延迟计算与写回；
在退出或可能观察 CPU 状态的慢路径前同步。两条管线共享解码规则、CPU 语义助手和运行时发布设施。

### 所有快路径都保留明确的退出条件

1. **编译不执行客户机操作。** 前端读取不可变代码快照，区分逻辑 EIP、线性地址和物理依赖页；
   缺失代码、预算不足或不支持的形式终止本次编译，不在编译过程中触发客户机 MMIO 或交付异常。
2. **异常与提交精确。** 内存/RMW、栈和 REP 保留故障顺序与部分完成进度；helper 明确声明状态读写、
   返回结果和异常所有权。正常返回按契约重载，控制转移后以 CPU 状态为准，避免重复交付异常或恢复旧状态。
3. **访存优化需要证明。** RAM 快路径检查 TLB、权限、映射和代码页条件；跨页、MMIO、代码写入及其他
   不满足守卫的情况转慢路径或解释器。load 复用、store-to-load forwarding 和循环缓存只在已证明的范围内成立。
4. **编译与执行都有预算。** 限制区域大小、优化工作量、编译时机和执行批次；安全点把控制权交回 CPU 主循环，
   保留中断、设备和暂停处理机会。HIR/MIR verifier 检查类型、支配关系、边参数、状态恢复与机器计划约束。
5. **代码有效性属于运行时。** 发布和执行时核对入口模式、地址映射、代码依赖及 owner/generation；
   代码写入、映射变化、reset/restore 使相关产物失效，在无活动执行帧时回收表槽位，防止执行旧代码。

这些约束用于保持既有 CPU 语义；覆盖目录中没有 Pending，并不等于实现了基线之外的全部 x86 行为，
也不等于穷尽所有前缀、模式、故障及设备组合。

## 2. 当前架构图

```text
                         Guest x86 code / CPU state
                                      |
                      +---------------v----------------+
                      | CPU dispatch + interpreter     |
                      | execution heat / observed PCs  |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Scheduler + immutable snapshot |
                      | mode key / code dependencies   |
                      +---------------+----------------+
                                      |
                            Shared x86 decoder
                                      |
                 +--------------------+--------------------+
                 |                                         |
   +-------------v----------------+       +----------------v---------------+
   | Tier-0: page / multi-page     |       | Tier-1 / Tier-2: region compiler|
   | CFG discovery + templates    |       | CFG -> typed SSA HIR           |
   | integer / x87 / SSE / MMX     |       | effects + StateMaps + helpers   |
   | local state cache            |       +----------------+---------------+
   | br_table / structured loops  |                        |
   +-------------+----------------+       +----------------v---------------+
                 |                        | Bounded HIR passes             |
                 |                        | lower -> owned MIR -> optimize |
                 |                        | locals / control / state plans |
                 |                        +----------------+---------------+
                 |                                         |
                 +--------------------+--------------------+
                                      |
                      +---------------v----------------+
                      | Wasm emission / WasmBuilder    |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Host instantiate + publication |
                      | shared table / cache / owners  |
                      +---------------+----------------+
                                      |
                      +---------------v----------------+
                      | Admission + compiled execution |
                      | page / region linking          |
                      +---------------+----------------+
                                      |
                       +--------------+---------------+
                       |                              |
                valid next entry              exit / slow path
                       |                              |
                 compiled code              CPU helpers / interpreter
                                              / main-loop safepoint
```

Tier-0 的页内或簇内转移留在生成函数中；簇外由运行时链接循环查找下一函数。
页函数还支持批量打包到共享 Wasm 实例，减少跨实例调用。区域后端使用结构化控制流，
对不能结构化的 CFG 保留 dispatcher 路径。两条编译路径使用同一套发布、失效与表槽位管理。

关键代码入口：

| 职责 | 位置 |
|---|---|
| 编码目录与共享解码 | [gen/x86_table.js](../gen/x86_table.js)、[frontend](../src/rust/ir/frontend/) |
| Tier-0 分析、模板与多页函数 | [tier0](../src/rust/ir/tier0/) |
| HIR、状态与优化 | [hir.rs](../src/rust/ir/hir.rs)、[state.rs](../src/rust/ir/state.rs)、[passes](../src/rust/ir/passes/) |
| lowering、MIR 与 Wasm 后端 | [lowering.rs](../src/rust/ir/lowering.rs)、[mir.rs](../src/rust/ir/mir.rs)、[backend/wasm](../src/rust/ir/backend/wasm/) |
| 热度、编译、准入及缓存 | [schedule.rs](../src/rust/ir/runtime/schedule.rs)、[compile.rs](../src/rust/ir/runtime/compile.rs)、[cache.rs](../src/rust/ir/runtime/cache.rs) |
| CPU 分派、槽位及宿主桥接 | [cpu.rs](../src/rust/cpu/cpu.rs)、[jit.rs](../src/rust/jit.rs)、[cpu.js](../src/cpu.js) |

常用控制：`disable_jit: true` 只运行解释器；`ir_opt_level` 和 `ir_passes_disabled` 控制区域优化；
`get_jit_info()` 查看调度/缓存统计，`ir_dump` 与 `get_ir_dumps()` 查看区域 HIR/MIR/Wasm。
`jit_backend` 仅接受 `"ir"` 或省略。验证入口为 `make ir-tests`、`make ir-tier0-tests`、
`make ir-generated-check`；专项测试见 [测试说明](../tests/Readme.md)，覆盖目录见 [ir-coverage.json](../src/rust/ir/frontend/ir-coverage.json)。

## 3. 相比 Legacy JIT 的优势

Legacy JIT 已有页内分派、寄存器局部缓存和访存快路径。IR 在保留这些低成本执行手段的基础上，
增加了更清晰的编译层次、更强的优化表达能力和统一运行时：

| 方面 | Legacy JIT | 当前 IR |
|---|---|---|
| 编译器结构 | 指令分析与直接 Wasm 发射紧密耦合，优化分散在指令生成逻辑中 | 区域管线把解码、语义、优化、lowering 和发射分层；Tier-0 单独承担低成本页编译 |
| 优化范围 | 以指令模板、局部特化和控制流组织为主 | 显式 SSA 支持跨块 GVN、SCCP、DCE、FLAGS 活跃性、状态写回裁剪，以及有界 LICM 和受守卫的 RAM 复用 |
| 冷热取舍 | 主要依赖直接编译路径及其局部优化 | Tier-0 快速覆盖已观察代码，区域 Tier-1/2 提供独立的优化路径，不要求每次页编译都构建完整 SSA |
| 浮点与向量热点 | 较多依赖 CPU helpers 和内存中的状态 | Tier-0 原生 x87 常见路径、x87 寄存器段优化及 Wasm SIMD 模板减少调用和状态搬运；特殊值与不满足守卫的情况回退 |
| 跨页执行 | 已支持页内分派及部分连续多页模块 | 根据实际转移热度形成包含非连续页的簇，并支持页函数链接和共享实例打包，减少频繁返回外层分派的成本 |
| 正确性与演进 | 语义、恢复和发射约束较多依赖各条生成路径维护 | HIR/MIR、Effect、StateMap、helper ABI 与 verifier 把约束显式化，便于差分验证、单独关闭 pass 和定位问题 |

**性能收益已有历史测量支持，但不保证每个负载都更快。** 本地保存的
`build/bench/results-t0-clusters.json`（2026-09-26，Apple M1 Pro、Node v25.6.0，
历史构建 `0d508ec2+dirty`）记录：quick 套件相对 Legacy 的 warm 几何均值约 **1.67×**，
cold 约 **1.35×**；warm 的 x87、SSE、MMX 分类分别约 2.69×、2.45×、1.69×。
同批控制流分类 cold 仅约 0.93×，说明冷编译和工作集仍会影响收益。
这些是 3 次 warm、1 次 cold 的历史样本，本次文档合并没有重跑性能验收；测量口径见
[CPU 基准说明](cpu-benchmarks.md)。

评估实际收益应同时看等量客户机工作的正确性、冷启动编译成本、热代码吞吐与应用表现。
XP 测试的首次 `800×600×32` 切换只是显示模式里程碑；游戏帧率还受渲染、音频和客户机节流影响，
不能直接归因于 JIT。
