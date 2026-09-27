# X4：原生 wide 寄存器块（部分门槛）

现有 HIR/MIR 已有 I64 标量，但 `StateMap` 的 GPR[8]、GuestEip(u32)、CpuEntryKey 的 u32 地址以及 LinearAddress→Wasm i32 映射仍是旧路径约束。`x64/compiler.rs` 因而新增独立、明确类型的 wide instruction plan，使用 X1 shared decoder 和单一架构 bank，复用既有 WasmBuilder 生成真实 i64 运算；不将解释器 helper 调用伪装为 native 编译。

约定：`compiler::compile(bytes,start:GuestIp,guard_token:u64,max_instructions)` 返回 `Artifact { bytes, plan, native_instructions, locals }`。产物导出 `f(budget:i32)->i32`，返回实际已退休 native 指令数。内存 import 为 `e.m`，唯一 function import 为 `e.x64_native_guard(token:i64)->i32`。guard 必须核对当前核、完整 RIP/控制状态、物理映射、source bytes、机器 generation，以及中断/TF/shadow/HLT 条件，并物化输入 lazy FLAGS。token 由 Wasm i64/JS BigInt 传递，不经 Number 截断。

产物直接读取分 bank 的 16×64 GPR，在 native Wasm 中计算结果和 FLAGS；每条完成后提交 GPR/FLAGS/full RIP，逐条检查 budget。当前子集包含 MOV、ADD/ADC/SUB/SBB/CMP/AND/OR/XOR/TEST、常数计数移位/旋转、CMOV/SETcc/POPCNT/BT 系列、XCHG、LEA 和直接条件分支，不访问 guest data memory、不调用设备或解释器，unsupported instruction 在其前退出。caller 负责 instruction counter、退休 ledger 和 IRQ 交付。该边界让 cold entry 的 byte/mapping 验证在一个无 host observer 的 activation 内保持有效。

验证：

```sh
cargo test x64::compiler
X64_ORACLE_ONLY=1 node tests/x64/integer_oracle.mjs
node tests/x64/native_oracle.mjs
X64_JIT=1 node tests/x64/integer_oracle.mjs
```

独立 native fixture 会检查 Wasm import 列表只有 admission guard；将 QEMU 实际客户机产生的完整 GPR/明确定义 FLAGS 输出，和独立实例化 native Wasm 的结果比较。1269 个输入（768 个 ALU、336 个移位/旋转、条件/POPCNT/bitops 及32个完整RIP分支）已通过；同时检查 64-bit token、budget=0、budget 中途退出和 stale guard 拒绝时零架构状态提交。实际 guest 在 native/fallback 混合执行中也通过全部 1540 个 QEMU 记录；为证明异步发布后的真实 native 命中，加入长热循环并在每轮让出事件循环，观测到 native retired=999999、published=18149。原一次性顺序执行会在异步产物发布前完成，仅编译计数不能作为命中证据。

尚未据此完成的门槛包括：guest memory 原生 guard/RMW/fault continuation、完整 shared HIR/MIR 状态图扩宽、宽 SIMD/FPU 编译、跨页块与高/低 RIP 别名/SMC/DMA/重映射/快照 stale artifact 矩阵，以及 OS/性能 gate。本文件明确记录已验证子集，不替代 X4 总体验收。

原生 Jcc 覆盖全部16种条件的两种结果，依据QEMU实际客户机分支输出判定 taken/not-taken；native分支起点位于0xFFFF8000FFFFFFF0，taken目标越过低32位边界，同时核对 FLAGS/GPR 不变，避免仅验证低DWORD而漏掉 RIP 截断。

## 2026-09-27 续：原生块缓存与真实 OS

- 缓存由 1024 项线性表改为按 RIP 直接映射的 4096 槽，token 低位即槽号，入口查找、guard 与发布确认都是常数时间；被替换的槽使旧 token 失效，迟到的发布被拒绝；替换累计达到槽数时整体复位，限制宿主侧残留函数。
- 入口不再在 `run` 中预先校验；字节/翻译校验只在原生序言调用的 `x64_native_guard` 中进行，guard 拒绝（返回 0 条退休）后才比较并淘汰过期项。guard 快照改为共享 `Arc<[u8]>`，不再每次复制源码字节；`ram_page` 对低 RAM 短路。
- 冷代码：此前每个首次到达的 RIP 都立即编译并结束切片发布，每个冷块都是一次独立的宿主模块实例化。现需同一 RIP 到达 64 次才编译；未编译代码留在解释器。
- 结果：同一内存/栈热循环 JIT 模式 6.1 → 10.8 MIPS，仍低于解释器（约 14.5 MIPS）。原因是结构性的：块只含寄存器指令，一遇到访存就结束；每次进入要经过 Rust→JS 映射→块模块→Rust guard→返回的多次宿主边界，guard 本身要做两次翻译和字节比较。块内不形成循环，热循环每次迭代都重新进入。

真实 OS：`X64_JIT=1 node tests/x64/linux_boot.mjs`（原生块 + 解释器混合，1 核）结果见 [XC 记录](../XC/linux64-boot.zh-CN.md)。

下一步（X4 主体，未开始）：沿用 32 位 IR 已有的同步发布与主模块函数表（`call_indirect` 进入，免去 JS 映射与异步实例化）；块内以 helper import 做访存（翻译 + 低 RAM 直接读写，失败或 MMIO 时在该指令前退出，由解释器精确交付故障；写入命中本块代码页时在该指令后退出）；块内回边形成循环并逐次检查预算与中断条件；再扩展到 CALL/RET/PUSH/POP 与链接。完成前不宣称 x64 JIT 加速。
