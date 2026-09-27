# C2 每核精确执行指标验收

2026-09-27，`tests/smp/core_statistics.mjs` 在 debug/release 的解释器、Tier-0 和 region 后端全部通过。各后端运行相同的三个客户机程序，退休指令数、REP 元素、异常和 HLT 计数一致；两个 JIT 后端都断言每个核心实际执行过编译代码。

## 指标语义及工作量

`get_diagnostics().cores` 的五个指标逐项与 Wasm `core_statistics_get(core, field)` 比较：

| 诊断字段 | 含义 |
| --- | --- |
| `retired_instructions` | 成功完成的架构指令；前缀不是额外指令，REP 仅在完成时退休一次，faulting dispatch 不退休 |
| `rep_elements` | REP 已成功完成的元素；包含最终异常前的成功元素，空 REP 为 0，无 REP 的字符串指令不增加此项 |
| `faults` | 客户机同步 fault 次数，本 fixture 包含 #UD 和 #PF |
| `halt_count` | 成功执行 HLT 的次数 |
| `runtime_ms` | 该核心在宿主执行入口内累计的运行时间；要求非负且工作量后大于 0，保存/恢复时精确还原 |

测试手动建立三个独立的 32 位分页上下文以隔离计数验收，随后只由客户机指令产生上述事件。它不代替 Linux 的 AP 启动/拓扑验收。所有核心先执行普通 NOP、带前缀的 NOP、一次非 REP STOSB 和确定次数的三指令算术循环，再执行不同的 REP/异常路径：

| 核 | 算术循环次数 | REP 路径 | 退休指令数 | REP 元素 | faults | HLT |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 0 | 2048 | 1000 次 STOSB 完成，随后 UD2 → #UD → handler HLT | 6156 | 1000 | 1 | 1 |
| 1 | 2085 | ECX=0 的空 REP，然后 HLT | 6267 | 0 | 0 | 1 |
| 2 | 2122 | 从 0x4FFB 开始，五次成功后在未映射的 0x5000 触发 #PF → handler HLT | 6377 | 5 | 1 | 1 |

预算为 17、调度 seed 为 42。解释器中，核 0 的 dispatch 次数严格大于退休指令数，证明 REP 的续跑和 fault 分派没有被直接当作退休量。测试同时校验算术最终值、ECX 剩余量、CR2 和实际 RAM 写入，避免仅检查统计数字自洽。非 REP STOSB 在此审查中暴露了原先会被计入 `rep_elements` 的问题，现由该断言覆盖。

## 后端及生命周期验证

| 后端 | debug 每核编译命中 | release 每核编译命中 |
| --- | --- | --- |
| interpreter | 0 / 0 / 0 | 0 / 0 / 0 |
| Tier-0 | 286 / 290 / 295 | 286 / 290 / 295 |
| region | 65 / 66 / 125 | 65 / 66 / 125 |

解释器断言两类编译计数都为 0；region 断言 Tier-0 未执行。编译命中数用于证明覆盖路径，不作为将来必须不变的实现常数。原始运行数据见 [debug 日志](logs/core-statistics-debug-2026-09-27.txt) 和 [release 日志](logs/core-statistics-release-2026-09-27.txt)。日志中的宿主运行时间随负载变化，不用于跨后端性能排名。

三个核心停在 HLT 后，测试保存完整机器快照，令核 1 再执行两个 NOP 和一个 HLT，并验证核 0/2 的全部指标逐字不变、核 1 只增加相应退休/HLT/运行时间。恢复快照后，各核五个指标（包括浮点运行时间）与原值完全相同。机器复位后，所有核心全部清零，包括等待 SIPI 的 AP。

另有旧格式迁移回归：从序列化快照中移除可选的每核扩展 state[96]，恢复到已执行过指令的单核 VM，五个指标必须初始化为 0。该测试先复现了目的 VM 的退休量/HLT/运行时间泄漏，修复后 debug/release 均通过。

## 重跑及产物

```sh
node tests/smp/core_statistics.mjs
TEST_RELEASE_BUILD=1 node tests/smp/core_statistics.mjs
```

`SMP_MODES=interpreter,tier0,region` 可选择子集；默认运行全部三种。release JS 必须与 Wasm 同次构建。本次运行基于 `fc79557e` 加当前工作树的统计/异常/原子修复，精确产物如下：

| 文件 | SHA-256 |
| --- | --- |
| `build/v86-debug.wasm` | `7920e19210e04e8cb1b0972a9ad41dea2e9fbf6ff34d2c1fbb49cae4eef3c52b` |
| `build/v86.wasm` | `549160bc21296edc03b997d3034d4b9f13b07211bdaf695437284e4ca0699243` |
| `build/libv86.mjs` | `005a18598b04a77fc10c1050b9fd323e2d9f30df02d969cf3c300550889d04cb` |
| `tests/smp/core_statistics.mjs` | `1d264c8ef48ba09bf619db93cd0b6eba8d3158e719611c571d518a78a2e00950` |

脚本也通过了 `node --check` 和仓库 ESLint 配置检查。
