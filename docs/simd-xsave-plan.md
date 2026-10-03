# SSSE3、SSE4.1/4.2、AVX/AVX2 与 XSAVE 完整实现计划

状态：设计与实施计划；本文不表示这些功能已经实现或通过验收。

基于 2026 年 10 月 3 日审查的工作区，Git 基线为 `696d91ab`。目标是让现有
`cpu_type: "x86"` 和 `cpu_type: "x86_64"` 在架构允许的执行模式下完整支持这些指令集，
覆盖解释执行、编译执行、操作系统状态切换、快照和多核。实现完成前，保持相应 CPUID
能力位关闭；不能以少量程序能够运行、指令名称已登记或解释器与 JIT 结果相同作为完整性证明。

## 1. 交付范围与完成定义

### 1.1 必须交付的功能

| 功能 | 本计划的完成范围 |
| --- | --- |
| SSSE3 | 全部合法 MMX/XMM 形式、寄存器/内存源、立即数、模式与异常规则 |
| SSE4.1 | 全部合法形式，包括整数扩展、混合、舍入、点积、插入/提取和非临时读取 |
| SSE4.2 | 字符串比较四条指令、PCMPGTQ、CRC32；独立审计已有 POPCNT |
| AVX | 两字节/三字节 VEX、架构定义的 128/256 位形式、三操作数、标量合并、YMM 状态及零化指令 |
| AVX2 | 256 位整数扩展、新增 128/256 位形式、广播、排列、变长移位、掩码读写与 gather |
| 基础 XSAVE | XSAVE、XRSTOR、XGETBV(0)、XSETBV、XCR0、CR4.OSXSAVE、CPUID leaf 0xD |
| XSAVE 家族扩展 | 分阶段完成 XSAVEOPT、XSAVEC、XGETBV(1)、XSAVES、XRSTORS，并分别公布能力位 |
| 状态分量 | x87/MMX、SSE/MXCSR、YMM_Hi128；按架构定义处理初始化状态与 32/64 位格式 |
| 所有执行入口 | 32 位解释器、IR Tier-0、IR region 管线、64 位解释器及 page tier；兼容模式同样覆盖 |
| 可移植性 | Wasm SIMD 和无 `simd128` 构建提供相同客体语义，宿主无需具有原生 AVX |

这里将“XSAVE 完整”明确拆成基础功能和上述家族扩展，两部分均列入最终目标。
XSAVES/XRSTORS 阶段实现 `IA32_XSS` 及其校验，但本项目没有新增 supervisor state
分量，因此初始受支持 XSS 位图为零。不能借此宣称支持其他状态组件。

不将 FMA/FMA4、F16C、BMI1/2、AES/PCLMUL、SHA、SSE4a、XOP、AVX-512、AVX10、
MPX、PKRU、AMX 或 APX 混入 AVX2。它们有独立能力位或状态组件，后续另行规划。
本计划要求指令可观察的行为正确，不要求模拟特定物理 CPU 的周期数、缓存实现或
AVX/SSE 转换性能惩罚。非临时访问涉及的内存行为仍须符合现有内存模型。

### 1.2 “完整”的判定单位

以 **指令编码形式** 为单位建立机器可读清单，而非只统计 mnemonic：

```text
ISA / mnemonic / encoding family / opcode map / opcode / mandatory prefix
W / L / vvvv 约束 / ModRM group / operands / immediate / VSIB
legal modes / address size / operand size / CPUID requirements
CR0 / CR4 / XCR0 requirements / exception class / memory footprint
destination merge and upper-half policy / flags / MXCSR effects
interpreter / tier0 / region / x64 interpreter / page tier / portable backend
semantic oracle / positive tests / negative tests / lifecycle tests
```

每个形式必须有合法编码测试、非法编码测试、独立语义依据和每条相关执行路径的覆盖。
后端可以调用已验证的公共语义 helper；复杂指令不必全部内联，但不能静默跳过、返回固定值，
或因某种 JIT 模式缺少实现而变成 #UD。性能优化另设验收，不用“已内联”替代语义正确。

指令规范以 [Intel SDM 官方入口](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)
中的 Volume 2 各指令条目及 Volume 3 异常规则为准。P0 固定实际使用的手册版本、
下载校验值和勘误，避免测试随着在线文档更新而无记录变化。

## 2. 当前代码基础与缺口

| 入口 | 审查所得现状 | 所需改动 |
| --- | --- | --- |
| [`gen/x86_table.js`](../gen/x86_table.js)、[`gen/generate_interpreter.js`](../gen/generate_interpreter.js) | `0F38/0F3A` 仍是占位；生成器围绕主表和 `0F` 表组织，并假设现有 opcode 长度 | 扩展 map-aware 编码描述和生成器，不能仅追加数值 opcode |
| [`src/rust/cpu/instructions_0f.rs`](../src/rust/cpu/instructions_0f.rs) | `instr_0F38/0F3A` 调用未实现入口；XSAVE/XRSTOR/XSAVEOPT 为未定义指令路径 | 接入新解码、共享语义及独立功能门控 |
| [`src/rust/ir/frontend/decode.rs`](../src/rust/ir/frontend/decode.rs)、[`gen/generate_ir_decoder.js`](../gen/generate_ir_decoder.js) | 当前解码围绕单字节及 `0F`，无 VEX 元数据 | 扩展编码身份、立即数、第三源及 VSIB 表达 |
| [`src/rust/x64/decode.rs`](../src/rust/x64/decode.rs) | 长模式拒绝 C4/C5；`base_opcode` 与后续分发需要支持更多 map | 保持解释器/page tier 共用解码结果，增加 VEX 与三字节 map |
| [`src/rust/ir/tier0/simd.rs`](../src/rust/ir/tier0/simd.rs)、[`src/rust/ir/tier0/emit.rs`](../src/rust/ir/tier0/emit.rs) | SIMD 缓存围绕 8 个 XMM/v128 | 扩展 YMM 高半依赖、物化、写回和 helper 边界 |
| [`src/rust/ir/types.rs`](../src/rust/ir/types.rs)、[`src/rust/ir/simd.rs`](../src/rust/ir/simd.rs)、[`src/rust/ir/backend/simd.rs`](../src/rust/ir/backend/simd.rs) | 已有 V128、整数 SIMD、scalar 后端及状态恢复基础 | 表达成对 v128 的 256 位值、跨半区操作和副作用 |
| [`src/rust/x64/vector.rs`](../src/rust/x64/vector.rs)、[`src/rust/x64/pagegen.rs`](../src/rust/x64/pagegen.rs) | 已有 SSE–SSE3、较完整的 FP 处理及部分原生模板 | 抽取可复用语义，扩展 16 个 YMM 和 page tier |
| [`gen/state_layout.js`](../gen/state_layout.js) | XMM0–7 与 XMM8–15 分库存放；无 YMM_Hi128/XCR0；固定状态区为 4096 字节 | 追加每核字段并重新生成 Rust/JS 布局；校验空间、范围与快照兼容 |
| [`src/rust/cpu/misc_instr.rs`](../src/rust/cpu/misc_instr.rs)、`x64/vector.rs` | 分别实现 legacy 与 long-mode FXSAVE/FXRSTOR；legacy 对齐检查仍有待补齐 | 提取模式相关的状态编解码，修复影响 XSAVE 的旧路径缺陷 |
| `instructions_0f.rs`、[`src/rust/x64/system.rs`](../src/rust/x64/system.rs) | CPUID 未公布目标扩展，无 leaf 0xD；两条路径的 CR4 合法位校验不一致 | 集中能力定义，统一 OSXSAVE、XCR0 和异常规则 |
| [`src/rust/ir/runtime/sse_fp.rs`](../src/rust/ir/runtime/sse_fp.rs)、[`src/rust/cpu/cpu.rs`](../src/rust/cpu/cpu.rs) | 明确保留旧 FP 限制；legacy MXCSR 的部分舍入、DAZ/FZ、未屏蔽异常尚未完整处理 | 为 SSE4.1/AVX 建立准确的公共 FP 核心，修复继承路径 |
| [`src/rust/ir/runtime/continuation.rs`](../src/rust/ir/runtime/continuation.rs) | selective continuation 保存范围包含 legacy XMM，但没有 YMM 高半 | 扩展捕获/恢复与失效规则，防止 helper 返回后恢复过期高半 |
| [`tests/nasm/`](../tests/nasm/)、[`tests/x64/`](../tests/x64/) | 已有差分与外部 oracle；NASM fixture 目前只记录 XMM0–7 | 版本化记录格式，增加 YMM、MXCSR、XCR0、异常与内存副作用 |

现有 IR 是唯一的 32 位 JIT，旧 Legacy JIT 已移除。long mode 使用独立 page tier，
不能假设修改 32 位 IR 就同时完成 64 位支持。沿用
[`docs/ir-design.md`](ir-design.md) 和 [`docs/x86-64.md`](x86-64.md) 的分工，
本项目不以建设 64 位 region 管线为前置条件。

## 3. 总体设计

### 3.1 一份编码契约，共享纯语义，保留模式适配层

在生成源中建立规范化编码描述，供解释器表、IR 解码、x64 解码校验和覆盖报告使用。
建议保留 `gen/x86_table.js` 作为入口，将新 SIMD 表和特性依赖拆到专门模块；
具体拆文件方式在 P0 确定。不要手工修改生成后的解释器文件或 coverage JSON。

公共语义层接收已经读取的操作数，返回结果及 flags/MXCSR 更新，不在整数 lane 运算中
直接访问全局 CPU 或客体内存。各执行引擎负责模式检查、地址转换、异常交付和结果提交。
字符串比较、FP、gather 与 xstate 使用明确的专用结果类型，不强行塞进单一“向量二元运算”。

新模块建议按职责组织为 SIMD 整数、SIMD 浮点、字符串/CRC、xstate；最终路径随现有
Rust 模块结构确定。公共 helper 的读写状态、副作用和异常出口必须登记到 IR helper contract。

### 3.2 YMM 表示与状态所有权

- 保留现有 XMM 低 128 位存储，追加 16 × 128 位的 `YMM_Hi128`，避免 XMM/YMM 两份低半数据。
- 32 位/兼容模式按编码可访问 0–7，long mode 可访问 0–15；模式切换不得误清不可寻址的寄存器。
- 追加每核 `XCR0`；家族扩展阶段补充 `IA32_XSS`、必要的 in-use/modified 跟踪信息。
  架构状态均标为 `owner: "core"`，临时优化缓存单独分类。
- 256 位执行优先表示为 `(lo: v128, hi: v128)`。Wasm scalar 后端提供等价实现，
  不为客体 AVX 引入宿主 AVX 或新的浏览器能力要求。
- IR 使用显式的成对向量值和集中读写 API；不先在整个类型系统增加 V256，避免一次性扩大
  优化器和寄存器分配器改动。需要 256 位整体操作时，由语义操作统一管理两半。
- 每个编码记录写入策略：legacy SSE 保留高半；VEX.128 向量目的寄存器清零高半；
  VEX.256 写完整两半。标量指令的低半合并、内存源零化等规则逐条描述，不能只看长度决定。
- `VZEROUPPER/VZEROALL`、FXRSTOR/XRSTOR、helper、去优化、跨页退出和快照都走同一状态边界。

### 3.3 精确异常与内存访问

建立逐类异常表，明确 #UD、#NM、#GP、#SS、#AC、#PF、#XM 的条件和优先顺序。
不能给所有 SIMD 指令套用同一套 CR0/CR4 检查：MMX、legacy XMM、AVX、CRC32、
POPCNT、XSAVE 和 XGETBV/XSETBV 的条件不同。

普通向量运算先检查合法性、读取需要的操作数，再提交目的状态。不得提前读取比指令规定
更宽的内存，例如把窄源扩展读取成完整 16/32 字节。编译阶段只读指令快照，不触发数据 MMIO
或客体异常。跨页、非 canonical 地址、段边界和高物理地址复用现有受检访存接口。

gather 允许架构规定的逐元素进度，不能套用普通指令的整体回滚；XSAVE/XRSTOR 的多次
内存访问和故障后的可观察状态也单独按规范定义。page tier 的 RETRY 只用于尚未产生
副作用的指令；已提交 gather lane 后不能从头重放全部访存。

## 4. 分阶段路线与依赖

| 阶段 | 交付物 | 依赖 | 阶段验收 |
| --- | --- | --- | --- |
| P0 | 完整编码清单、能力依赖、测试/性能基线、固定参考版本 | 无 | 目标形式清单可审阅，已有能力无变化 |
| P1 | `0F38/0F3A` 与 VEX 解码基础、负例、模式适配 | P0 | 独立解码差分通过，旧解码无回归 |
| P2 | YMM/XCR0 每核状态、基础 XSAVE/XRSTOR、快照迁移 | P0；指令入口依赖 P1 对应部分 | 分量 round-trip、异常、旧快照和多核通过 |
| P3 | SSSE3 全部形式、执行后端与覆盖 | P1 的 legacy maps | MMX/XMM 及三条 32 位执行路径、两条 x64 路径通过 |
| P4 | SSE4.1/SSE4.2、公共准确 FP 核心 | P1；复用 P3 语义基础 | 全部 forms、FP/字符串边界与独立 oracle 通过 |
| P5 | AVX 128 位、三操作数、零化、VEX 状态门控 | P1、P2、P3、P4 | legacy/VEX 混合链、标量合并和状态恢复通过 |
| P6 | AVX 全部 256 位形式及掩码访存 | P5 | 256 位浮点、排列、异常及 OS 上下文保存通过 |
| P7 | AVX2 普通整数、广播、排列、变长移位 | P6 | 逐形式和双 128 位 lane 边界测试通过 |
| P8 | AVX2 gather 与掩码故障/重启完整性 | P7；复杂访存框架可提前并行 | 故障进度、mask 写回、重启及 MMIO 计数通过 |
| P9 | XSAVEOPT/XSAVEC/XGETBV(1)/XSAVES/XRSTORS | P2；与 P5–P8 并行 | 各独立能力位、格式及状态跟踪通过 |
| P10 | 发布集成、真实客体、浏览器/可移植构建及性能 | P3–P9 | 完整清单无缺口，所有发布验收完成 |

P1 的 legacy maps 可先交付，以便 P3/P4 与 P2 并行。FP 核心、oracle/fixture 升级也可
从 P0 后独立推进。解码元数据、寄存器状态接口和能力定义先冻结，再并行开发指令族。
每个阶段都要接入相应编译执行路径和测试，不把所有后端工作积压到最后。

## 5. P0–P1：清单、能力契约和解码

### 5.1 编码清单与生成检查

在 `gen/` 下新增目标 ISA 清单及审计工具，为每种 register/memory、W/L、模式、
立即数和掩码形式分配稳定 ID。利用 Intel 指令表建立范围，使用
[Intel XED](https://intelxed.github.io/ref-manual/) 或已有 iced-x86 作为独立解码参考。
解码参考不是执行语义 oracle。

扩展 `ir-coverage.json` 生成、测试归属及未知编码检查。现有 `Pending=0` 只覆盖旧目录；
新验收应同时断言预期 forms 总集和实现集相等，防止“没登记就不算缺失”。
P0 输出各 ISA 的 forms 数量并固定在基线中，本文不凭 mnemonic 数量估算完整性。

### 5.2 解码改造

- 分离 `encoding family + map + opcode + pp`，不要继续靠 opcode 整数长度猜 mandatory prefix。
- legacy 增加 `0F38/0F3A` 的第三 opcode 字节及相应 imm8；正确保留 `0F39` 等未分配空间。
- 实现 C5 两字节和 C4 三字节 VEX，解出反相 R/X/B、vvvv、W、L、pp、map 字段。
- 按模式区分 legacy LES/LDS 与 VEX；覆盖 16/32 位及兼容模式，不能把所有 C4/C5 都判成 VEX。
- 独立声明 W0/W1/WIG、L0/L1/LIG 和保留 vvvv 规则；忽略位与非法位不能混为一谈。
- 校验重复/冲突 prefix、LOCK、REX 与 VEX 的组合，按规范决定可接受、忽略或 #UD。
- 支持 imm8 高位编码第四源的 VBLENDV* / VPBLENDVB，及 gather 的 VSIB 索引。
- VSIB 保留向量索引寄存器、元素宽度和 scale，不能沿用普通 SIB 的 GPR 索引及 no-index 判断。
- 对合法和非法编码均验证长度、15 字节上限、截断输入、跨取指页和 #UD/取指故障顺序。
- 更新 x64 `Decoded`/`base_opcode`、page tier 分类以及测试 oracle 的编码 key，避免 map 碰撞。

P1 验收包含独立解码器差分、所有 prefix/字段组合的边界集、LES/LDS 回归和取指故障测试。
未开启某项能力时仍应得到稳定的解码及正确 #UD 行为，不允许执行到另一个旧指令。

## 6. P2 与 P9：XSAVE、CPU 契约和生命周期

### 6.1 CPUID 与运行时启用

| 枚举入口 | 需要落实的内容 |
| --- | --- |
| CPUID.1:ECX | SSSE3[9]、SSE4.1[19]、SSE4.2[20]、XSAVE[26]、OSXSAVE[27]、AVX[28]；POPCNT[23] 独立 |
| CPUID.7.0:EBX | AVX2[5]，保留其他既有位；不顺带打开 BMI/FMA 等能力 |
| CPUID.0 | 最大 basic leaf 能到达 0xD，并保留 `cpuid_level` 等已有配置契约 |
| CPUID.0xD,0 | 支持的 XCR0 位图、当前启用状态所需标准大小、全部支持分量所需大小 |
| CPUID.0xD,1 | EAX 中 XSAVEOPT[0]、XSAVEC[1]、XGETBV(1)[2]、XSAVES/XRSTORS[3]；适用的 compacted 大小及支持的 XSS 位图 |
| CPUID.0xD,2 | YMM_Hi128 的大小、标准偏移和属性；其他未支持分量子叶正确返回零 |

CPUID 中硬件能力与 OS 启用状态分开：OSXSAVE 根据当前 vCPU 的 CR4.OSXSAVE 返回，
AVX/AVX2 硬件能力不随一次 XSETBV 被清除。执行时检查对应能力、CR0/CR4 和 XCR0。
Linux 的应用检测流程也要求结合 CPUID 与 XGETBV，见
[Linux xstate 文档](https://www.kernel.org/doc/html/latest/arch/x86/xstate.html)。

基础 XCR0 支持位为 x87[0]、SSE[1]、YMM[2]；复位值为 1。XSETBV 检查 ECX、CPL、
保留位、x87 必须保留启用、YMM 对 SSE 的依赖，以及 OSXSAVE 前提。XGETBV(0) 与
XGETBV(1) 分别受对应条件控制；不支持的 index 不能返回伪造零值。

统一 legacy 与 x64 的 CR4 写入校验，修复当前未公布 XSAVE 却接受 OSXSAVE 位的路径。
能力关闭、OS 未开启、TS/EM 状态和 XCR0 不完整的测试分别记录异常向量与指令位置。
实现 CR4/XSETBV 写入后的 JIT admission 失效或运行时重检，保证已编译代码立即遵守新状态。

### 6.2 状态区编解码

基础标准格式按架构分量组织，不直接复制内部 CPU state block：

| 区域 | 偏移 / 大小 | 工作项 |
| --- | --- | --- |
| Legacy region | 0 / 512 字节 | x87/MMX、MXCSR、XMM；遵循模式和 REX.W 对指针字段/寄存器数量的规定 |
| Header | 512 / 64 字节 | XSTATE_BV、XCOMP_BV、保留字段及格式合法性 |
| YMM_Hi128 | 576 / 256 字节 | 16 个寄存器的高半存储；非 long mode 的实际访问范围按规范处理 |

仅支持这些分量时，标准格式全部启用的大小为 832 字节。CPUID 动态大小由分量表和启用位
计算，不能在所有查询中无条件返回 832。compact 格式由对应布局算法处理，即使当前
分量组合恰好与标准格式使用相同偏移，也必须检查格式位。规则依据
[Intel SDM Volume 1，第 13 章](https://www.intel.com/content/dam/develop/external/us/en/documents-tps/253665-sdm-vol-11.pdf)。

实现要求：

- 按每条指令计算 requested/enabled mask，区分“未请求保持不变”“请求恢复存储值”
  和“请求但状态位未置位时恢复初始化值”。
- XSAVE/XSAVEOPT 保留未请求分量的 XSTATE_BV 位；XSAVEC/XSAVES 按 RFBM/in-use
  规则重写位图、清零未请求位并设置 XCOMP_BV。各指令未规定写入的保留字节保持不变，
  不能用统一的 header 清零或合并策略替代。
- MXCSR/MXCSR_MASK 有专门的保存与恢复条件，不能简单归结为复制 SSE 分量；特别测试
  只请求 YMM、SSE 标记为 init、非默认 MXCSR、无效 MXCSR 保留位等组合。
- 64 字节对齐、CPL/TS、段限制、页权限、canonical 地址以及各异常优先级逐项验证。
- 按实际需要访问的字段/分量访存，不预读/预写完整 832 字节，不触碰未请求区域制造额外 #PF。
- 保存前同步 x87 shadow 与编译器缓存；恢复后更新/失效 x87、XMM/YMM、MXCSR 派生状态。
- 明确多次访存故障后的允许部分效果和恢复策略；不把普通向量“先检查后提交”当作
  所有 xstate 指令的统一架构要求。
- 修复共享到这里的 FXSAVE/FXRSTOR 对齐、MXCSR 和模式差异；FXSAVE/FXRSTOR 本身
  不应偷偷保存、清零或恢复 YMM 高半。

### 6.3 家族扩展的单独验收

| 扩展 | 独立工作与验收 |
| --- | --- |
| XSAVEOPT | 标准格式及合法 init/modified 优化语义；保守保存可作为正确性阶段实现，跳过写入优化另测 |
| XSAVEC | compacted 格式、XCOMP_BV、分量布局和 init 规则；XRSTOR 对支持格式正确恢复 |
| XGETBV(1) | 返回与 XCR0/in-use 语义一致的值，独立 CPUID 门控，不强制将架构允许的保守 in-use 判成错误 |
| XSAVES/XRSTORS | CPL0、IA32_XSS 的 RDMSR/WRMSR、用户/监督状态位图及 compacted 保存恢复；未支持 XSS 位写入 #GP |

优化跟踪必须纳入所有写入来源，包括 legacy SSE、VEX、FXRSTOR、XRSTOR、VZERO*、
复位及快照恢复。首轮可以采用规范允许的保守跟踪；不能漏标 dirty 后错误省略写入。
如果实现 modified 优化，还要验证恢复来源、目标缓冲区、权限/地址上下文等适用条件。

### 6.4 快照、复位、多核与迁移

布局改动从 `gen/state_layout.js` 生成，不直接手改 `global_pointers.rs` / `src/state_layout.js`。
新增字段能放入当前 4096 字节状态槽，但仍须运行布局和 parallel relocation 检查，禁止
依赖过时文档中的状态总大小。

`src/cpu.js` 当前快照范围按精确 `CORE_STATE_RANGES` 校验，追加紧邻字段可能合并旧范围。
需要显式版本化迁移或兼容范围映射；仅把字段放在尾部不自动保证兼容。

- 老快照缺少新字段：按旧 CPU 能力恢复，YMM 高半初始化为零，XCR0 初始化为 1，XSS 为零。
  不能让通用“缺失字段填零”生成非法 XCR0。
- 新快照保存 CPU feature profile、每核 XCR0/YMM/XSS 及架构可见跟踪状态；恢复前完成
  profile、位图和状态范围验证，失败不能部分修改正在运行的 VM。
- 缺少 feature profile 的旧快照按旧能力集解释；不能因升级模拟器让恢复后的 OS
  突然看到新的 AVX 能力。新状态恢复到不支持的实现应清晰拒绝。
- 区分 reset、INIT、SIPI、软重启的架构状态规则，为 BSP/AP 分别测试，不能全部复用清零。
- 同步 [`src/rust/cpu/context.rs`](../src/rust/cpu/context.rs)、
  [`src/parallel/machine.js`](../src/parallel/machine.js) 和 state streaming 的保存恢复。
- 每核使用不同 XMM/YMM/XCR0 指纹，覆盖单 Worker 调度、parallel Workers、暂停恢复、
  迁移到新 VM、故障重启和浏览器 worker 生命周期。

## 7. P3–P4：SSSE3 与 SSE4

### 7.1 SSSE3 清单

| 类别 | 指令 |
| --- | --- |
| 字节排列/对齐 | PSHUFB、PALIGNR |
| 水平加减 | PHADDW、PHADDD、PHADDSW、PHSUBW、PHSUBD、PHSUBSW |
| 乘加/舍入乘法 | PMADDUBSW、PMULHRSW |
| 符号/绝对值 | PSIGNB/W/D、PABSB/W/D |

覆盖每条存在的 MMX 与 XMM 形式；MMX 与 x87 的别名、tag/状态转换必须正确。
重点测试 PSHUFB 高位清零、不同宽度的索引截断、PALIGNR 的全部 imm8、饱和边界、
最小负数绝对值、符号零值，以及 PMADDUBSW 的有符号/无符号输入组合。
PMULHRSW 按精确定义处理舍入与结果截取，不能套用通用饱和乘法。

### 7.2 SSE4.1 清单

| 类别 | 指令 |
| --- | --- |
| 混合 | BLENDPS/PD、BLENDVPS/PD、PBLENDW、PBLENDVB |
| 点积/舍入 | DPPS、DPPD、ROUNDPS/PD/SS/SD |
| 插入/提取 | INSERTPS、EXTRACTPS、PINSRB/D/Q、PEXTRB/W/D/Q 的 SSE4.1 编码形式 |
| 扩展 | PMOVSXBW/BD/BQ/WD/WQ/DQ、PMOVZXBW/BD/BQ/WD/WQ/DQ |
| 比较/打包 | PCMPEQQ、PACKUSDW、PTEST |
| 最大/最小 | PMAXSB/SD/UW/UD、PMINSB/SD/UW/UD |
| 乘法/规约 | PMULLD、PMULDQ、MPSADBW、PHMINPOSUW |
| 非临时读取 | MOVNTDQA |

显式区分新 PEXTRW 形式与已有形式，Q 形式的 long-mode 约束、GPR 宽度及零扩展单独测。
验证隐式 XMM0 mask、提取/插入立即数、窄内存源真实宽度、PTEST flags、PHMINPOSUW
最小位置规则，以及 MOVNTDQA 对齐和内存访问行为。

### 7.3 SSE4.2 与 POPCNT

- 实现 `PCMPESTRI/PCMPESTRM/PCMPISTRI/PCMPISTRM`：显式/隐式长度、byte/word、
  有/无符号、四类聚合、极性、有效元素和 mask/index 输出，覆盖全部 imm8。
- 测试长度为零、负长度、最小有符号长度、超出最大元素数、嵌入 NUL、无匹配/全匹配，
  以及 ECX/XMM0 与所有规定 flags 的修改。隐式结束符不允许改变固定内存操作数的访问要求。
- 实现 `PCMPGTQ` 有符号 64 位比较。
- 实现 CRC32 的合法 8/16/32/64 位源形式，使用 CRC-32C 的独立位级模型验证，
  不误用普通 IEEE CRC32；目的寄存器宽度、前缀及 flags 保持另测。
- POPCNT 已存在，但它是独立能力位；审计其 16/32/64 位形式和 flags，不用开启 SSE4.2
  替代它自己的门控。CRC32/POPCNT 不应套用 XMM 的任务切换检查。

### 7.4 浮点准确性是前置任务

抽取 x64 已有 FP 处理中的可复用部分，补齐所有目标指令用到的 f32/f64 操作、转换、
比较、舍入及异常记录。可扩展当前 SoftFloat 接口，但不得通过中间 extF80 转换
不经证明地替代所有 f32/f64 操作，避免双重舍入。

必测四种舍入方式、DAZ/FZ、正负零、subnormal、无穷、qNaN/sNaN、NaN 来源选择、
溢出/下溢/精度和未屏蔽异常。ROUND 的立即数控制和精度异常抑制、DPPS/DPPD 的
mask 与加法顺序独立实现。AVX 比较支持 32 种谓词，不能复用现有 `predicate & 7` 截断。

Wasm SIMD 仅在结果、NaN、舍入及 MXCSR 效果等价的条件下走快路径，其余进入公共准确
helper。旧 SSE 与新 VEX 混合执行同样需要共享正确的 MXCSR，不保留两套互相矛盾的行为。

## 8. P5–P6：AVX

按 P0 固定的 AVX 编码清单实现，以下是分组而非替代完整 forms 清单：

| 分组 | 实现范围与重点 |
| --- | --- |
| VEX.128 既有操作 | 架构定义的 SSE/SSE2/SSE3/SSSE3/SSE4 的 VEX 形式；不机械地给每条 legacy 指令加 V 前缀 |
| 数据传送 | 对齐/非对齐、标量、整数/浮点及非临时形式；加载/存储方向、寄存器别名与上半清零 |
| FP 运算与转换 | 合法 PS/PD/SS/SD 形式、水平运算、sqrt/rcp/rsqrt、转换及 32 比较谓词 |
| 广播/排列 | VBROADCASTSS/SD/F128、VPERMILPS/PD、VPERM2F128、VINSERTF128、VEXTRACTF128、混合/解包/洗牌 |
| 掩码与测试 | VMASKMOVPS/PD、VTESTPS/PD，以及合法 VEX PTEST 形式 |
| 控制与清零 | VLDMXCSR/VSTMXCSR、VZEROUPPER/VZEROALL |

P5 先完成 128 位与统一三操作数/上半策略，再在 P6 完成全部合法 256 位形式。
VEX.128 的许多整数形式属于 AVX，256 位整数扩展通常属于 AVX2；每个形式按能力定义
判断，不能仅凭 mnemonic 或目的宽度猜测。并非所有标量、点积和转换都存在 L=1 形式。

所有 source/destination 重叠组合都要测试。输入操作数先快照，之后才清高半或写目的；
标量上部位可能来自第一源，不能沿用 legacy destination-preserving 逻辑。
对 256 位 lane 内操作分别执行两个 128 位半区；跨半区的 insert/extract/permute 另有语义。

VMASKMOV 按活跃 lane 访存，被屏蔽 lane 不触发架构要求抑制的内存异常。
测试全零 mask、页边界、不可访问地址、零填充/保留结果和实际写入范围。
不能用一次整 32 字节 load/store 再做 mask 合并替代。

RCP/RSQRT 等近似指令按规定误差及特殊值要求验收，不要求与某一型号硬件逐位相同；
规范唯一确定的精确结果和状态位采用逐位比较。DPPS 水平运算的部分 NaN 传播/位置等
实现相关结果使用允许结果集或 postcondition；v86 自身各后端仍保持确定且一致的结果。
参考 [Intel SDM Volume 2A 的 DPPS 条目](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)。

## 9. P7–P8：AVX2

| 分组 | 覆盖要求 |
| --- | --- |
| 256 位整数 | 合法 VEX.256 加减、饱和、比较、逻辑、乘法、移位、打包/解包、水平运算、符号/绝对值和 shuffle |
| 扩展与广播 | VPMOVSX*/VPMOVZX*、VPBROADCASTB/W/D/Q、VBROADCASTI128，以及 AVX2 新增的寄存器源广播形式 |
| 排列与混合 | VPERMD、VPERMPS、VPERMQ、VPERMPD、VPERM2I128、VINSERTI128、VEXTRACTI128、VPBLENDD |
| 每元素移位 | VPSLLVD/Q、VPSRLVD/Q、VPSRAVD，含移位量超过元素宽度 |
| 掩码读写 | VPMASKMOVD/Q，包含 128/256 位形式和故障抑制 |
| Gather | VPGATHERDD/DQ/QD/QQ、VGATHERDPS/DPD/QPS/QPD 的全部合法形式 |

按指令区分 lane 内 shuffle/pack 与跨 256 位排列；不同元素/索引宽度导致的有效 lane 数、
未使用目的位和高半清零必须登记。特别覆盖 PSHUFB、PALIGNR、水平运算在 256 位下的
128 位 lane 边界，防止“把向量扩成 32 字节后全局操作”的错误实现。

Gather 独立开发和验收：

1. VSIB 解析、索引符号扩展、scale、地址大小与 FS/GS 基址正确；验证受限制的寄存器重叠。
2. 以 mask 指定的活跃元素读取，已完成元素更新目的并清除对应 mask 进度。
3. 在任意 lane 制造 #PF/#GP 等错误，验证从低序元素向高序元素交付故障的规则
   （right-to-left）、允许的提前完成、故障元素、mask 和 RIP。
4. 验证 mask 元素规范化、成功后 mask 清零，以及故障时目的/mask 的未使用位和高半状态；
   单独测试 16 位地址大小 #UD 和 gather 不产生 #AC 的规则。
5. 故障处理后重新执行，确认 v86 按其已提交的 mask 进度继续，不因执行引擎退出而重放已提交操作。
6. page tier/IR 使用专用慢路径或可恢复执行协议；不使用会重复已提交 lane 的整指令 RETRY。
7. 用访存计数器、不同页面权限和索引别名检查模拟器选定的访问策略；覆盖全部 mask 与不同宽度组合。

VMASKMOV/gather 的硬件访问顺序或次数并非统一保证，Intel 也不建议把它们用于 MMIO。
v86 对这些设备地址选择确定的逐 lane 行为，并用 MMIO 计数器检测实现内部的意外重复；
这是模拟器的行为约定和 RETRY 检查，不能作为“硬件保证每个元素恰好访问一次”的证明。
参考 [Intel SDM 的 gather 与 masked move 条目](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)。

## 10. 编译后端与优化约束

每批语义进入解释器后立即接入其他执行路径：

- **Tier-0**：更新 SIMD 寄存器缓存、读写范围、成对 v128 和退出物化；helper 前后
  对 XMM/YMM/MXCSR 的失效规则一致。
- **IR region**：扩展 frontend、HIR/MIR lowering、状态映射、liveness、helper contract、
  continuation、scalar/SIMD backend。清高半是实际状态写入，必须参与数据流和死写消除。
- **x64 page tier**：先通过精确的 step/helper 路径获得完整可执行性，再为常见算术、传送、
  shuffle 和整数运算增加模板；覆盖 XMM/YMM8–15、RIP-relative、完整 64 位地址。
- **优化器**：禁止把可能引发异常的 FP/内存操作当作纯运算消除，禁止跨状态恢复、XSETBV、
  MXCSR 写入错误移动 SIMD 操作；跨半区依赖、mask 与 flags 一起纳入验证。
- **调度**：长 helper 的预算、IRQ/NMI 可见边界以及自修改代码失效沿用引擎约定；gather
  的部分进度和 xstate 恢复边界需要额外审查。

发布报告分别给出“完整语义覆盖”和“原生模板/内联覆盖”，避免所有指令都回退执行却被
误报为性能实现完成。复杂指令保留 helper 是允许的，只要语义、可恢复性和性能预算达标。

## 11. 测试与验收矩阵

### 11.1 独立参考与测试格式

复用 [`tests/rust/sse3.mjs`](../tests/rust/sse3.mjs) 的解释器/Tier-0/region 对照、
[`tests/rust/compiled_arms.mjs`](../tests/rust/compiled_arms.mjs) 的编译执行计数，
以及 [`tests/x64/vector_oracle.mjs`](../tests/x64/vector_oracle.mjs) 的外部客体参考方式。

- 整数/CRC/字符串采用独立位级模型，避免直接把实现代码复制进测试。
- 使用可用的 x86 硬件结果、固定 QEMU TCG 版本和 SDM postconditions 交叉验证。
  现有 x64 oracle 已记录 QEMU 在部分 FP 异常/NaN 上的差异，不能单纯以 QEMU 为真值。
- Apple Silicon 上可运行 QEMU oracle；没有原生 x86 参考时明确记录缺口，发布前在
  具备相应能力的 x86 测试环境补足需要硬件判定的案例。
- 扩展 NASM fixture/GDB/QEMU stub 或新增版本化 guest record，包含所有可见 YMM、
  MXCSR、XCR0、EFLAGS、异常向量/错误码/IP、内存变化。旧 fixture 保持可读。
- AVX 客体初始化必须设置 CR4.OSXSAVE/XCR0，分别处理 CPL0 boot stub 与宿主用户态测试。
- 随机测试固定 seed，失败保存最小字节序列、初态、路径和预期结果，支持独立重放。

### 11.2 必测维度

| 维度 | 必测内容 |
| --- | --- |
| 模式 | real/protected 16/32、VM86、compatibility 16/32、long64；按各指令合法性验证执行或拒绝 |
| 编码 | legacy、VEX2/3、map、pp、W/L/vvvv、ModRM/SIB/VSIB、REX、imm8、非法组合与长度 |
| 数据 | 全零/全一、符号边界、溢出/饱和、随机 lane、全 imm8；FP 特殊值和控制位组合 |
| 寄存器 | 源/目的全别名、隐式 XMM0、ECX/长度寄存器、0–7/8–15、YMM 高低半 |
| 内存 | 对齐/非对齐、真实访问宽度、跨页/跨段、权限、canonical 地址、高物理地址、MMIO、自修改代码 |
| 状态与异常 | CPUID/CR0/CR4/XCR0 组合、MXCSR、#UD/#NM/#XM/#GP/#SS/#AC/#PF、失败后的部分效果 |
| 执行路径 | 32 位解释器、Tier-0、regions、64 位解释器、page tier；有/无 Wasm SIMD |
| 生命周期 | reset/INIT/SIPI、每核切换、IR continuation、快照/流式快照、parallel Worker 恢复 |

全 imm8 测试适用于含立即数的目标形式；各模式按可达规则组织代表性组合，不以不可管理的
全部维度笛卡尔积替代有目的的测试。每项高风险交互仍必须有显式案例。

### 11.3 操作系统验收

- 基于已有 Linux x86/x86_64 客体，验证实际 CPUID→OSXSAVE→XSETBV→XSAVE 路径；
  加入进程/线程切换、signal/sigreturn、系统调用和线程跨核迁移的 YMM 指纹探针。
- 基于已有 Windows 8.1 x64 客体，验证 64 位和 WOW64 AVX 程序、线程/异常上下文保存、
  多核及快照恢复；不把桌面启动成功等同于 AVX 状态正确。
- 用明确编译选项构建 SSSE3/SSE4/AVX/AVX2 小程序并检查产物实际包含目标指令。
  不使用会隐式引入 FMA/BMI/AES 等额外要求的整机 `-march` 配置作为唯一探针。
- 正向探针之外，增加禁用 OSXSAVE/XCR0 的负例、旧 guest/旧快照回归，以及调度中途
  修改不同 vCPU 控制状态的测试。

### 11.4 已有检查入口

以下是当前已有目标，按改动阶段选取；本次仅写计划，未执行这些构建和运行测试：

```sh
make state-layout-check ir-generated-check platform-contract-tests
make ir-decoder-tests ir-decode-contract-tests ir-coverage-tests
make sse3-tests packed-simd-tests
make ir-simd-move-tests ir-simd-integer-tests ir-simd-immediate-tests
make ir-simd-shuffle-tests ir-simd-transfer-tests ir-simd-lane-tests ir-simd-masked-tests
make ir-sse-fp-tests ir-fp-state-tests ir-helper-audit ir-portable-tests
make nasmtests nasmtests-force-jit
make x64-decode-tests x64-system-tests x64-differential-tests
make x64-page-tier-tests x64-opcode-matrix-tests
make smp-tests multicore-coherence-tests multicore-state-tests
make multicore-parallel-tests multicore-parallel-tests-release
make multicore-parallel-browser-tests ir-backend-browser-tests
make x64-guest-tests x64-multicore-guest-tests
make bench-quick
```

**计划新增** `ssse3-tests`、`sse41-tests`、`sse42-tests`、`xsave-tests`、`avx-tests`、
`avx2-tests`、`simd-xsave-tests`，并接入 CI；这些名称当前不是可依赖的已有目标。
CI 分为快速确定性语义/解码检查与较长的差分、浏览器、OS 集成任务，合并与发布分别设 gate。
`make all-tests` 不能代替上述专项汇总。

## 12. 发布、性能和最终检查表

### 12.1 能力开放与兼容策略

内部开发可使用测试专用 feature mask；公共 CPUID 只在整个 ISA 的合法形式、异常和所有
执行入口通过后开放。SSSE3、SSE4.1、SSE4.2、基础 XSAVE、AVX、AVX2 以及 XSAVE
家族扩展独立验收，AVX2 必须建立在完整 AVX/xstate 上。

CPU feature profile 在 VM 创建时固定并保存到快照；不允许运行中从旧能力集升级到新能力集。
保留当前旧 profile 用于快照和回归，新建 VM 是否默认采用扩展 profile 在 P10 按兼容性结果
确定。若增加公开配置，应同时更新 `v86.d.ts`、starter、CPU Worker 和文档，并拒绝不满足
依赖的能力组合。宿主 SIMD 快路径不可用不应偷偷缩减客体 profile。

更新并人工审核 [`tests/platform/cpu-contract.json`](../tests/platform/cpu-contract.json)，
包括 CPUID.0xD、OSXSAVE 动态变化、不同核数和两类 CPU profile。不能只刷新基线掩盖变化。
同步 `docs/x86-64.md` 的 CPU 能力表及相关 IR/多核说明。

### 12.2 性能预算

P0 固定旧 profile 的启动、整数、x87、SSE、代码生成大小/时间和多核基线。建议发布预算：
既有客体主要工作负载中位数回退不超过 5%，启动场景不超过 10%；超过时先分析和优化，
不能靠打开 FP 不准确路径换取通过。阈值和重复次数在 P0 与现有 benchmark 的噪声一起固定。

新 ISA 增加纯寄存器、访存、跨 lane、字符串比较、gather 和 XSAVE 上下文切换基准，
分别报告解释器、编译路径、helper 占比、Wasm 大小与无 SIMD 构建。性能比较使用相同工作量，
不预设双 v128 实现的 AVX2 必然比 SSE 快两倍。

### 12.3 最终验收

- [ ] 机器可读 forms 清单完整，所有目标形式具有实现和独立测试归属，无未解释缺口。
- [ ] SSSE3 MMX/XMM、SSE4.1/4.2、AVX/AVX2 的全部合法编码、模式和操作数形式完成。
- [ ] 基础 XSAVE 及计划内家族扩展逐项完成；未实现的其他状态组件不被公布。
- [ ] CR0/CR4/XCR0/CPUID 的能力检查和故障顺序在各引擎一致，并符合独立规范测试。
- [ ] FP 舍入、NaN、MXCSR 和未屏蔽异常正确，近似指令按误差要求验收。
- [ ] 普通访存、mask fault suppression、gather 部分完成/重启与 xstate 故障分别通过。
- [ ] 32 位解释器/Tier-0/regions、64 位解释器/page tier 及无 simd128 构建通过。
- [ ] 新旧快照、reset/INIT/SIPI、每核状态和 parallel Worker 生命周期通过。
- [ ] Linux、Windows x64/WOW64 的实际 SIMD 上下文切换探针通过。
- [ ] CPU contract、公开配置与文档一致，既有客体回归和性能预算达标。

达到以上条件才能将本项目标为“完整实现”；仅完成到某一阶段时，按已验收的 ISA 和
XSAVE 子能力报告进度，不将 AVX 基础、AVX2 普通算术或 XSAVE 指令占位称为全部完成。
