# SSSE3 至 x86-64-v3 指令集与 XSAVE 完整实现计划

状态：设计与实施计划；本文不表示这些功能已经实现或通过验收。

初稿基于 2026 年 10 月 3 日的工作区（Git 基线 `696d91ab`）。2026 年 10 月 4 日复核到
`6912875a`，其间合入了 SMM（见第 2 节），并按审阅意见修订了解码前缀、浮点、XSAVE、
快照/INIT、测试参考和发布顺序；同日把 x86-64-v3 的其余指令（FMA、F16C、BMI1、BMI2、
LZCNT、MOVBE）纳入范围。目标是让现有
`cpu_type: "x86"` 和 `cpu_type: "x86_64"` 在架构允许的执行模式下完整支持这些指令集，
使 x64 配置达到 x86-64-v3，并覆盖解释执行、编译执行、操作系统状态切换、快照和多核。实现完成前，保持相应 CPUID
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
| FMA | VFMADD、VFMSUB、VFNMADD、VFNMSUB、VFMADDSUB、VFMSUBADD 的 132/213/231 全部形式（PS/PD/SS/SD，128/256 位），乘加只舍入一次 |
| F16C | VCVTPH2PS、VCVTPS2PH 的 128/256 位、寄存器/内存形式及 imm8 舍入控制 |
| BMI1 | ANDN、BEXTR、BLSI、BLSMSK、BLSR 的 32/64 位形式，TZCNT 的 16/32/64 位形式；未开放时 `F3 0F BC` 按 BSF 执行 |
| BMI2 | BZHI、MULX、PDEP、PEXT、RORX、SARX、SHLX、SHRX 的 32/64 位形式 |
| LZCNT | 16/32/64 位形式，只在 x64 配置开放（第 13 节 Q7）；未开放时，包括在 32 位配置中，`F3 0F BD` 按 BSR 执行 |
| MOVBE | 16/32/64 位的加载与存储形式（只有内存操作数形式） |
| 基础 XSAVE | XSAVE、XRSTOR、XGETBV(0)、XSETBV、XCR0、CR4.OSXSAVE、CPUID leaf 0xD |
| XSAVE 家族扩展 | 分阶段完成 XSAVEOPT、XGETBV(1)、XSAVEC，最后是 XSAVES/XRSTORS，并分别公布能力位（第 13 节 Q3） |
| 状态分量 | x87/MMX、SSE/MXCSR、YMM_Hi128；按架构定义处理初始化状态与 32/64 位格式 |
| 所有执行入口 | 32 位解释器、IR Tier-0、IR region 管线、64 位解释器及 page tier；兼容模式同样覆盖，且 32 位解释器与 x64 引擎结果一致 |
| 可移植性 | Wasm SIMD 和无 `simd128` 构建提供相同客体语义，宿主无需具有原生 AVX |

这里将“XSAVE 完整”明确拆成基础功能和上述家族扩展，两部分均列入最终目标（XSAVES/XRSTORS
由第 13 节 Q3 定为实现）。本项目没有新增 supervisor state 分量，XSAVES 本身没有功能收益，
公开后还会让 Linux 改走 XSAVES/XRSTORS 的压缩格式路径，所以它放在 M5 的最后一步，并对这条
路径做完整的操作系统验收。XSAVES/XRSTORS 同时实现 `IA32_XSS` 及其校验，初始受支持 XSS
位图为零，不能借此宣称支持其他状态组件。

本计划覆盖 x86-64-v3 的全部要求：在 x86-64-v2 之上，还有 AVX、AVX2、BMI1、BMI2、F16C、
FMA、LZCNT、MOVBE 和 OSXSAVE。很多“要求 AVX2”的软件实际按 v3 整组检测；glibc 的 AVX2
字符串函数也要求 AVX2、BMI1、BMI2、LZCNT 同时可用，只开放 AVX2 时不会被选中。
x86-64-v3 只针对 x64 配置；32 位配置开放其中除 LZCNT 以外的指令（第 13 节 Q7）。

不将 FMA4、AES/PCLMUL、VAES/VPCLMULQDQ、GFNI、AVX-VNNI、SHA、ADX、SSE4a、XOP、AVX-512、
AVX10、MPX、PKRU、AMX 或 APX 纳入本计划。它们有独立能力位或状态组件，后续另行规划；
其中落在 `0F38`/`0F3A` 或 VEX 编码空间的指令，本计划只保证它们稳定地产生 #UD。
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
下载校验值和勘误，避免测试随着在线文档更新而无记录变化。本文统一引用
[SDM 合订本（cdrdv2 835781）](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)，
并注明卷号和章节。P0 固定的版本是 325462-085US（2024 年 10 月），SHA-256
`ae21642237489554840f3e640848e53bdbbbfa73108a92e60139748b4f804de3`；更换版本时同步更新所有引用。

## 2. 当前代码基础与缺口

| 入口 | 审查所得现状 | 所需改动 |
| --- | --- | --- |
| [`gen/x86_table.js`](../gen/x86_table.js)、[`gen/generate_interpreter.js`](../gen/generate_interpreter.js)、[`src/rust/decode_rules.rs`](../src/rust/decode_rules.rs) | `0F38/0F3A` 仍是占位；生成器围绕主表和 `0F` 表组织，并假设现有 opcode 长度。`mandatory_prefix` 让 66 优先于 F2/F3；遇到未列出的强制前缀时只有 `dbg_assert`，release 构建执行无前缀形式 | 扩展 map-aware 编码描述和生成器，不能仅追加数值 opcode；按 5.2 节统一前缀规则 |
| [`src/rust/cpu/instructions_0f.rs`](../src/rust/cpu/instructions_0f.rs) | `instr_0F38/0F3A` 调用未实现入口；XSAVE/XRSTOR/XSAVEOPT 为未定义指令路径；`0FAE /7`（CLFLUSH）一律 #UD，而 x64 配置公布了 CLFSH | 接入新解码、共享语义及独立功能门控；顺带消除 CLFLUSH 在兼容模式下的双引擎分歧 |
| [`src/rust/ir/frontend/decode.rs`](../src/rust/ir/frontend/decode.rs)、[`gen/generate_ir_decoder.js`](../gen/generate_ir_decoder.js) | 当前解码围绕单字节及 `0F`，无 VEX 元数据 | 扩展编码身份、立即数、第三源及 VSIB 表达 |
| [`src/rust/x64/decode.rs`](../src/rust/x64/decode.rs) | 长模式拒绝 C4/C5；`base_opcode` 与后续分发需要支持更多 map；同样 66 优先，未列出的强制前缀只在 64 位模式下 #UD | 保持解释器/page tier 共用解码结果，增加 VEX 与三字节 map；前缀规则与 32 位解码器统一 |
| [`src/rust/ir/tier0/simd.rs`](../src/rust/ir/tier0/simd.rs)、[`src/rust/ir/tier0/emit.rs`](../src/rust/ir/tier0/emit.rs) | SIMD 缓存围绕 8 个 XMM/v128 | 扩展 YMM 高半依赖、物化、写回和 helper 边界 |
| [`src/rust/ir/types.rs`](../src/rust/ir/types.rs)、[`src/rust/ir/simd.rs`](../src/rust/ir/simd.rs)、[`src/rust/ir/backend/simd.rs`](../src/rust/ir/backend/simd.rs) | 已有 V128、整数 SIMD、scalar 后端及状态恢复基础 | 表达成对 v128 的 256 位值、跨半区操作和副作用 |
| [`src/rust/x64/vector.rs`](../src/rust/x64/vector.rs)、[`src/rust/x64/pagegen.rs`](../src/rust/x64/pagegen.rs) | 已有 SSE–SSE3、较完整的 FP 处理及部分原生模板 | 抽取可复用语义，扩展 16 个 YMM 和 page tier |
| [`gen/state_layout.js`](../gen/state_layout.js) | XMM0–7 与 XMM8–15 分库存放；无 YMM_Hi128/XCR0；固定状态区为 4096 字节 | 追加每核字段并重新生成 Rust/JS 布局；校验空间、范围与快照兼容 |
| [`src/rust/cpu/misc_instr.rs`](../src/rust/cpu/misc_instr.rs)、`x64/vector.rs` | 分别实现 legacy 与 long-mode FXSAVE/FXRSTOR。legacy 的对齐 #GP 只是 `dbg_assert`；x64 的 FXSAVE 整块写出 512 字节（SDM 规定处理器不写 464–511 字节），并且在非 64 位模式下也存取 XMM8–15 | 提取模式相关的状态编解码，修复影响 XSAVE 的旧路径缺陷（6.2 节） |
| `instructions_0f.rs`、[`src/rust/x64/system.rs`](../src/rust/x64/system.rs) | CPUID 未公布目标扩展，无 leaf 0xD；两条路径的 CR4 合法位校验不一致（legacy 接受 bit 18 OSXSAVE）。CPU 配置只是布尔值 `X64_TEST_CAPABILITIES`，不进快照；`cpuid_level` 可配置（Windows NT 用 2）。32 位配置的 CPUID 0x80000000 返回 5，即没有有效的扩展 leaf，因此无法报告 LZCNT（0x80000001:ECX[5]） | 集中能力定义并改为能力位图，统一 OSXSAVE、XCR0 和异常规则；32 位配置不补扩展 leaf，也不开放 LZCNT（第 13 节 Q7） |
| [`src/rust/cpu/smm.rs`](../src/rust/cpu/smm.rs)（基线后合入） | SMI 进入时把 CR4 清零；RSM 原样恢复 CR4，不做合法位校验；`entered_mode()` 会调用 `ir_admission_barrier` | RSM 与 MOV CR4 共用校验，并列入 JIT 失效写入方（6.1 节） |
| [`src/rust/ir/runtime/sse_fp.rs`](../src/rust/ir/runtime/sse_fp.rs)、[`src/rust/cpu/cpu.rs`](../src/rust/cpu/cpu.rs) | 32 位引擎（解释器、Tier-0、regions）的 SSE/SSE2 算术直接用宿主或 Wasm 运算：不设置任何 MXCSR 状态位，算术不支持 RC/DAZ/FZ（`set_mxcsr` 只打日志），也从不产生 #XM。x64 的 `vector.rs` 基于 SoftFloat，是精确的 | 单列 P4a：建立准确的公共 FP 核心，改造现有 SSE/SSE2 浮点路径（7.4 节） |
| [`src/rust/ir/runtime/continuation.rs`](../src/rust/ir/runtime/continuation.rs) | selective continuation 保存范围包含 legacy XMM，但没有 YMM 高半 | 扩展捕获/恢复与失效规则，防止 helper 返回后恢复过期高半 |
| [`lib/softfloat/softfloat.c`](../lib/softfloat/softfloat.c)、[`src/rust/softfloat.rs`](../src/rust/softfloat.rs) | 捆绑的 C SoftFloat 已包含 `f32_mulAdd`、`f64_mulAdd`、`f32_to_f16` 和 `f16_to_f32`，Rust 侧尚未声明 | FMA/F16C 的精确路径直接复用；x86 的 NaN 选择规则在外层实现（9.3 节） |
| `gen/x86_table.js` 的 BSF/BSR、`x64/execute.rs`、`x64/pagegen.rs` | `0F BC/BD` 忽略 F3 前缀，行为等同于不支持 BMI1/LZCNT 的 CPU | TZCNT/LZCNT 是唯一随能力位改变解码结果、而不是变成 #UD 的形式：能力关闭时仍按 BSF/BSR 执行（5.2 节） |
| 惰性标志：32 位引擎的 `flags_changed`/`last_op1`/`last_result`，x64 page tier 的惰性标志记录 | 只覆盖现有整数指令 | BMI1/BMI2/LZCNT/TZCNT 接入两套机制，未定义标志取固定值（9.2 节） |
| [`src/cpu.js`](../src/cpu.js) | 多核快照按区间恢复，缺失区间填复位值（SMBASE 是先例）；单核旧快照把 1360 以上的 core 区间清零。INIT 只保留 `INIT_PRESERVED` 中的 PAT、MTRR、MC 和 SMBASE，其余（包括 x87、XMM、MXCSR）都取复位值 | 按 6.4 节加入 XCR0/XSS 的填充与 INIT 规则 |
| [`tests/nasm/`](../tests/nasm/)、[`tests/x64/`](../tests/x64/) | 已有差分与外部 oracle；NASM fixture 目前只记录 XMM0–7；`qemu_oracle.js` 只解析 `XMM0n=`，并以 `-cpu max` 运行 QEMU | 版本化记录格式，增加 YMM、MXCSR、XCR0、异常与内存副作用；处理 11.1 节列出的 QEMU 缺口 |

现有 IR 是唯一的 32 位 JIT，旧 Legacy JIT 已移除。long mode 使用独立 page tier，
不能假设修改 32 位 IR 就同时完成 64 位支持。沿用
[`docs/ir-design.md`](ir-design.md) 和 [`docs/x86-64.md`](x86-64.md) 的分工，
本项目不以建设 64 位 region 管线为前置条件。

兼容模式（LMA=1、CS.L=0）由两个引擎共同执行：在 `X64_COMPAT_JIT` 下，编译过的代码经
32 位解释器单步执行，未编译的代码走 x64 引擎。两者对同一指令的任何分歧，都要等代码变热后
才会暴露（RDTSCP 曾因此出现“热了就 #UD”）。目前已知的同类偏差有 CLFLUSH、FXSAVE/FXRSTOR
的 XMM 范围和 SSE 浮点精度。新形式按 3.1 节共用解码，并按 5.2 节做双引擎差分。

## 3. 总体设计

### 3.1 一份编码契约，共享纯语义，保留模式适配层

在生成源中建立规范化编码描述，供解释器表、IR 解码、x64 解码校验和覆盖报告使用。
建议保留 `gen/x86_table.js` 作为入口，将新 SIMD 表和特性依赖拆到专门模块；
具体拆文件方式在 P0 确定。不要手工修改生成后的解释器文件或 coverage JSON。

VEX、`0F38` 和 `0F3A` 的字段解析与合法性判定只实现一份（例如扩展
[`src/rust/decode_rules.rs`](../src/rust/decode_rules.rs)），由 32 位解释器生成器、IR 解码和
x64 解码共同调用，从结构上消除兼容模式下的双引擎分歧。解释器对 VEX 采用两级分派（先 map
再 opcode），不把 map×pp×L×W 摊平成巨型 match 或 br_table；V8 遇到数万项的 br_table
曾因 Zone OOM 中止。

公共语义层接收已经读取的操作数，返回结果及 flags/MXCSR 更新，不在整数 lane 运算中
直接访问全局 CPU 或客体内存。各执行引擎负责模式检查、地址转换、异常交付和结果提交。
字符串比较、FP、gather 与 xstate 使用明确的专用结果类型，不强行塞进单一“向量二元运算”。

新模块建议按职责组织为 SIMD 整数、SIMD 浮点（含 FMA/F16C）、字符串/CRC、位操作
（BMI/LZCNT/MOVBE）、xstate；最终路径随现有
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
  非 64 位模式下，VZEROUPPER/VZEROALL 只修改 YMM0–7；FXSAVE/FXRSTOR/XSAVE/XRSTOR 也不存取
  XMM8–15 及其高半。

### 3.3 精确异常与内存访问

建立逐类异常表，明确 #UD、#NM、#GP、#SS、#AC、#PF、#XM 的条件和优先顺序。
分类直接采用 SDM Volume 2A 第 2 章的异常类型（Exception Type 1–13；F16C 属 Type 11，
VEX 编码的 GPR 指令属 Type 13），清单为每个形式登记所属类型。不能给所有 SIMD 指令套用
同一套 CR0/CR4 检查：MMX、legacy XMM、AVX、BMI、CRC32、POPCNT、XSAVE 和 XGETBV/XSETBV
的条件不同。最容易出错的几条规则要显式写进测试：

- VEX 编码的 SIMD 指令（包括 FMA、F16C）要求 CR4.OSXSAVE=1 且 XCR0[2:1]=11b，否则 #UD；
  CR0.TS=1 时 #NM。SDM 的异常类型表只对传统 SSE 列出 CR0.EM 和 CR4.OSFXSR；QEMU 对 VEX
  指令也检查 CR0.EM，这一点需要硬件判定（11.1 节）。
- VEX 编码的 GPR 指令（BMI1、BMI2）不受 CR0.TS、CR4.OSXSAVE 和 XCR0 影响，操作系统没有
  开启 AVX 时照样可用；VEX.L=1 时 #UD，非 64 位模式下忽略 VEX.W1。
- VEX 访存除 Type 1（对齐 move、VMOVNTDQA 等）外不要求对齐。
- 传统 SSE 的 16 字节对齐要求有例外：MOVU*/LDDQU、PCMPxSTRx，以及按窄宽度访问内存的形式。
- 现有 32 位路径在 CR4.OSFXSR=0 时只打日志，不产生 #UD。新旧形式共用同一个检查函数，并一起修正。

普通向量运算先检查合法性、读取需要的操作数，再提交目的状态。不得提前读取比指令规定
更宽的内存，例如把窄源扩展读取成完整 16/32 字节。编译阶段只读指令快照，不触发数据 MMIO
或客体异常。跨页、非 canonical 地址、段边界和高物理地址复用现有受检访存接口。

gather 允许架构规定的逐元素进度，不能套用普通指令的整体回滚；XSAVE/XRSTOR 的多次
内存访问和故障后的可观察状态也单独按规范定义。page tier 的 RETRY 只用于尚未产生
副作用的指令；已提交 gather lane 后不能从头重放全部访存。

## 4. 分阶段路线与依赖

| 阶段 | 交付物 | 依赖 | 阶段验收 |
| --- | --- | --- | --- |
| P0 | 完整编码清单、能力依赖、热点形式清单、测试/性能基线、固定参考版本；第 13 节待决问题的结论 | 无 | 目标形式清单可审阅，已有能力无变化 |
| P1 | `0F38/0F3A` 与 VEX 解码基础、统一的强制前缀规则、负例、模式适配 | P0 | 独立解码差分通过，旧解码的有意修正都有回归测试 |
| P2 | YMM/XCR0 每核状态、基础 XSAVE/XRSTOR（只接受标准格式）、快照迁移 | P0。XSAVE 系列在 `0F AE`/`0F C7`，XGETBV/XSETBV 在 `0F 01`，都属现有 map，不依赖 P1 | 分量 round-trip、异常、旧快照和多核通过 |
| P3 | SSSE3 全部形式、执行后端与覆盖 | P1 的 legacy maps | MMX/XMM 及三条 32 位执行路径、两条 x64 路径通过 |
| P4a | 公共准确 FP 核心；现有 SSE/SSE2 浮点改造与快路径准入 | P0 的精度策略结论（Q2） | 旧 SSE 浮点的精确性差分与性能预算都通过 |
| P4b | SSE4.1/SSE4.2 | P1、P4a；复用 P3 语义基础 | 全部 forms、FP/字符串边界与独立 oracle 通过 |
| P5 | AVX 128 位、三操作数、零化、VEX 状态门控 | P1、P2、P3、P4b | legacy/VEX 混合链、标量合并和状态恢复通过 |
| P6 | AVX 全部 256 位形式及掩码访存 | P5 | 256 位浮点、排列、异常及 OS 上下文保存通过 |
| P7 | AVX2 普通整数、广播、排列、变长移位 | P6 | 逐形式和双 128 位 lane 边界测试通过 |
| P8 | AVX2 gather 与掩码故障/重启完整性 | P7；复杂访存框架可提前并行 | 故障进度、mask 写回、重启及 MMIO 计数通过 |
| P9 | XSAVEOPT、XGETBV(1)、XSAVEC，最后是 XSAVES/XRSTORS | P2；与 P5–P8 并行 | 各独立能力位、格式及状态跟踪通过 |
| P10 | BMI1、BMI2、LZCNT/TZCNT、MOVBE：VEX 编码 GPR 指令、旧编码位操作与标志位接入 | P1；与 P2–P9 并行 | 逐形式语义与标志位通过；能力关闭时 TZCNT/LZCNT 按 BSF/BSR 执行的测试通过 |
| P11 | FMA、F16C | P4a、P6 | 单次舍入、NaN/MXCSR 规则、F16C 舍入控制与独立 oracle 通过 |
| P12 | 发布集成、真实客体、浏览器/可移植构建及性能 | P3–P11 | 完整清单无缺口，所有发布验收完成 |

P1 的 legacy maps 可先交付，以便推进 P3/P4b；P2 不依赖 P1，可以在 P0 之后直接开始。
P10 只依赖 P1 的 VEX 解码，不涉及 YMM、XSAVE 和 MXCSR，可以与 P2–P9 并行。
P4a 的 FP 核心、oracle/fixture 升级也可从 P0 后独立推进。解码元数据、寄存器状态接口和
能力定义先冻结，再并行开发指令族。每个阶段都要接入相应编译执行路径和测试，不把所有
后端工作积压到最后。

### 4.1 发布里程碑

能力位按里程碑开放。每个里程碑独立验收，对应 `tools/release_gate.mjs` 中的一个等级（11.4 节）：

| 里程碑 | 包含阶段 | 开放的能力 | 价值与前提 |
| --- | --- | --- | --- |
| M1 x86-64-v2 | P1 的 legacy maps、P3、P4a、P4b | 两个配置都开放 SSSE3、SSE4.1、SSE4.2 | x64 配置已有 CX16、LAHF/SAHF、POPCNT 和 SSE3，补齐后即达到 x86-64-v2（RHEL 9 系要求它；Windows 11 24H2 要求 SSE4.2 和 POPCNT）。不需要 VEX、YMM 或 XSAVE |
| M2 基础 XSAVE | P2 | XSAVE（OSXSAVE 位随 CR4 反映）；XCR0 只支持 x87 和 SSE | 有 XSAVE 而无 AVX 有硬件先例（Goldmont），可以先验证操作系统的上下文切换路径。XCR0 的可支持位由 CPU 配置推导，开放 AVX 后才允许 bit 2 |
| M3 AVX | P5、P6 | AVX；XCR0 bit 2 | 依赖 M1、M2 |
| M4 x86-64-v3 | P7、P8、P10、P11 | AVX2、FMA、F16C、BMI1、BMI2、LZCNT、MOVBE 一起开放（32 位配置不含 LZCNT） | 依赖 M3。软件多按 v3 整组检测；glibc 的 AVX2 字符串函数要求 AVX2、BMI1、BMI2、LZCNT 同时可用，libm 的 `_fma` 变体要求 FMA 和 AVX2，只开放其中一部分收益有限。P10 的指令可以更早用内部 feature mask 测试，对外随 M4 开放 |
| M5 XSAVE 扩展 | P9 | XSAVEOPT、XGETBV(1)、XSAVEC，最后开放 XSAVES | 依赖 M2；每开放一项都会改变 Linux 和 glibc 的代码路径（6.3 节） |

每个里程碑开放能力位之前，5.1 节热点形式清单中属于该里程碑的形式，必须已在编译路径上有
原生模板（12.2 节）。

## 5. P0–P1：清单、能力契约和解码

### 5.1 编码清单与生成检查

在 `gen/` 下新增目标 ISA 清单及审计工具，为每种 register/memory、W/L、模式、
立即数和掩码形式分配稳定 ID。清单中的 iform、isa-set、CPUID 位、异常类型、操作数宽度和
属性，直接由 [Intel XED](https://intelxed.github.io/ref-manual/) 的数据文件生成，避免手抄
SDM 表格；SDM 只做仲裁，分歧逐条登记。XED 或已有的 iced-x86（`tests/x64/oracle`）同时作为
独立解码参考。解码参考不是执行语义 oracle。

扩展 `ir-coverage.json` 生成、测试归属及未知编码检查。现有 `Pending=0` 只覆盖旧目录；
新验收应同时断言预期 forms 总集和实现集相等，防止“没登记就不算缺失”。
P0 输出各 ISA 的 forms 数量并固定在基线中，本文不凭 mnemonic 数量估算完整性。

P0 同时产出“热点形式清单”。做法是反汇编目标客体中会因能力位开放而改走新路径的代码，
列出其中实际执行的形式。这类代码包括 glibc 的 IFUNC 变体（含 libm 的 `_fma` 变体）与 ld.so
惰性绑定、Linux 内核的上下文切换、zstd 这类按 BMI2 运行时分派的库，以及 Windows 的对应库。
清单中的形式例如 PCMPISTRI、VMOVDQU ymm、VPCMPEQB、VPMOVMSKB、VZEROUPPER、TZCNT、
LZCNT、BLSR、SHLX/SARX/BZHI、VFMADD231SD/PD、PSHUFB、PALIGNR 和 XSAVE/XRSTOR。
它用于 4.1 节的开放前提和 12.2 节的性能基准。

### 5.2 解码改造

- 分离 `encoding family + map + opcode + pp`，不要继续靠 opcode 整数长度猜 mandatory prefix。
- legacy 增加 `0F38/0F3A` 的第三 opcode 字节及相应 imm8；正确保留 `0F39` 等未分配空间。
- 实现 C5 两字节和 C4 三字节 VEX，解出反相 R/X/B、vvvv、W、L、pp、map 字段。
- 按模式区分 legacy LES/LDS 与 VEX；覆盖 16/32 位及兼容模式，不能把所有 C4/C5 都判成 VEX。
- 独立声明 W0/W1/WIG、L0/L1/LIG 和保留 vvvv 规则；忽略位与非法位不能混为一谈。
- 校验重复/冲突 prefix、LOCK、REX 与 VEX 的组合，按规范决定可接受、忽略或 #UD。
- 强制前缀采用 XED 的 refining-prefix 规则：F2/F3 优先于 66，F2/F3 并存时取最后一个；
  有 F2/F3 时，66 只作操作数大小前缀，例如 `66 F2 0F 38 F1` 是 CRC32 r32, r/m16。现有两个
  解码器都让 66 优先：按代码推断，`66 F3 0F 10` 在 32 位和兼容模式下执行 MOVUPD，在 64 位
  模式下 #UD，而硬件执行 MOVSS。统一后会改变旧 `0F` 表的行为，这是有意修正，需补回归测试。
- 未列出的强制前缀在所有模式、所有构建下一律 #UD。现在 32 位生成器只有 `dbg_assert`，
  release 构建会执行无前缀形式；照搬到 `0F38` 后，`F3 0F 38 00` 会被执行成 MMX PSHUFB。
- `F3 0F BC/BD` 在开放 BMI1/LZCNT 时是 TZCNT/LZCNT，未开放时 F3 被忽略、按 BSF/BSR 执行。
  这是本计划中唯一随能力位改变解码结果、而不是变成 #UD 的情形。解码缓存、Tier-0 和
  page tier 的编译结果都以 CPU 配置为前提；恢复快照导致配置变化时一并清空。
- `0F 38 F0/F1`：无前缀或只有 66（操作数大小）时是 MOVBE，只有内存形式，寄存器形式和
  F3 前缀 #UD；F2 前缀是 CRC32，`66 F2` 是 CRC32 的 16 位源形式。
- BMI1/BMI2 的 VEX.vvvv 用法各异（源、目的或控制操作数），按清单逐条登记。
- 支持 imm8 高位编码第四源的 VBLENDV* / VPBLENDVB，及 gather 的 VSIB 索引。
- VSIB 保留向量索引寄存器、元素宽度和 scale，不能沿用普通 SIB 的 GPR 索引及 no-index 判断。
- 对合法和非法编码均验证长度、15 字节上限、截断输入、跨取指页和 #UD/取指故障顺序。
- 更新 x64 `Decoded`/`base_opcode`、page tier 分类以及测试 oracle 的编码 key，避免 map 碰撞。

P1 验收包含独立解码器差分、所有 prefix/字段组合的边界集、LES/LDS 回归和取指故障测试。
未开启某项能力时仍应得到稳定的解码及正确 #UD 行为，不允许执行到另一个旧指令。
在兼容模式下合法的每个新形式，都要在 32 位解释器和 x64 引擎上做差分（第 2 节末），
比较长度、#UD 和执行结果。

## 6. P2 与 P9：XSAVE、CPU 契约和生命周期

### 6.1 CPUID 与运行时启用

| 枚举入口 | 需要落实的内容 |
| --- | --- |
| CPUID.1:ECX | SSSE3[9]、FMA[12]、SSE4.1[19]、SSE4.2[20]、MOVBE[22]、XSAVE[26]、OSXSAVE[27]、AVX[28]、F16C[29]；POPCNT[23] 独立 |
| CPUID.7.0:EBX | BMI1[3]、AVX2[5]、BMI2[8]，保留其他既有位（例如 ERMS[9]） |
| CPUID.80000001H:ECX | LZCNT[5]（AMD 称 ABM），保留 LAHF/SAHF[0]；只在 x64 配置报告。32 位配置的 0x80000000 继续返回 5（没有扩展 leaf），不报告 LZCNT（第 13 节 Q7） |
| CPUID.0 | 最大 basic leaf 能到达 0xD，并保留 `cpuid_level` 等已有配置契约。`cpuid_level` 小于 0xD 时，隐藏 XSAVE、OSXSAVE 以及依赖它们的 AVX、AVX2、FMA、F16C；小于 7 时，隐藏 AVX2、BMI1 和 BMI2。否则 Linux 会因 leaf 0xD 不可达而告警，并退回 FXSAVE |
| CPUID.0xD,0 | 支持的 XCR0 位图、当前启用状态所需标准大小、全部支持分量所需大小 |
| CPUID.0xD,1 | EAX 中 XSAVEOPT[0]、XSAVEC[1]、XGETBV(1)[2]、XSAVES/XRSTORS[3]；适用的 compacted 大小及支持的 XSS 位图 |
| CPUID.0xD,2 | YMM_Hi128 的大小、标准偏移和属性；其他未支持分量子叶正确返回零 |

CPUID 中硬件能力与 OS 启用状态分开：OSXSAVE 根据当前 vCPU 的 CR4.OSXSAVE 返回，
AVX、AVX2、FMA、F16C 的硬件能力不随一次 XSETBV 被清除。执行时检查对应能力、CR0/CR4 和 XCR0。
Linux 的应用检测流程也要求结合 CPUID 与 XGETBV，见
[Linux xstate 文档](https://www.kernel.org/doc/html/latest/arch/x86/xstate.html)。

能力之间的依赖由 CPU 配置统一校验，不满足时拒绝创建：AVX 依赖 XSAVE，AVX2、FMA 和 F16C
依赖 AVX；BMI1、BMI2、LZCNT 和 MOVBE 不依赖 AVX 与 XSAVE，也不受 OS 是否开启 AVX 影响。

基础 XCR0 支持位为 x87[0]、SSE[1]、YMM[2]；复位值为 1。可支持位由 CPU 配置推导：
未开放 AVX 时只有 x87 和 SSE（M2），CPUID.0xD,0 的 EAX 和各大小字段随之变化。XSETBV 检查 ECX、CPL、
保留位、x87 必须保留启用、YMM 对 SSE 的依赖，以及 OSXSAVE 前提。XGETBV(0) 与
XGETBV(1) 分别受对应条件控制；不支持的 index 不能返回伪造零值。

统一 legacy 与 x64 的 CR4 写入校验，修复当前未公布 XSAVE 却接受 OSXSAVE 位的路径；
RSM 恢复的 CR4 走同一套校验。能力关闭、OS 未开启、TS/EM 状态和 XCR0 不完整的测试，
分别记录异常向量与指令位置。

已编译代码必须立即遵守新状态，按变化频率分两种方式处理：

- CR0.TS 在 XP 这类延迟保存 FPU 的系统里切换频繁，沿用 Tier-0 现有的运行时检查（`simd_guard`）。
- CR4.OSXSAVE 和 XCR0 很少变化，走准入版本号失效（`ir_admission_barrier` 及 page tier 的对应机制）。

写入方要逐一覆盖并各有测试：MOV CR0/CR4、CLTS、LMSW、硬件任务切换（会置 TS）、XSETBV、
SMI（CR4 清零，所以 SMM 内 OSXSAVE=0）、RSM、INIT/RESET 和快照恢复。XCR0 不在 SMRAM
保存映像里，跨 SMI/RSM 保持不变。

### 6.2 状态区编解码

基础标准格式按架构分量组织，不直接复制内部 CPU state block：

| 区域 | 偏移 / 大小 | 工作项 |
| --- | --- | --- |
| Legacy region | 0 / 512 字节 | x87/MMX、MXCSR、XMM；遵循模式和 REX.W 对指针字段/寄存器数量的规定 |
| Header | 512 / 64 字节 | XSTATE_BV、XCOMP_BV、保留字段及格式合法性 |
| YMM_Hi128 | 576 / 256 字节 | 16 个寄存器的高半存储；非 long mode 的实际访问范围按规范处理 |

仅支持这些分量时，标准格式全部启用的大小为 832 字节。CPUID 动态大小由分量表和启用位
计算，不能在所有查询中无条件返回 832。compact 格式由对应布局算法处理，即使当前
分量组合恰好与标准格式使用相同偏移，也必须检查格式位。规则依据 SDM Volume 1 第 13 章
（[合订本](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)）。

实现要求：

- 按每条指令计算 requested/enabled mask，区分“未请求保持不变”“请求恢复存储值”
  和“请求但状态位未置位时恢复初始化值”。
- XSAVE/XSAVEOPT 保留未请求分量的 XSTATE_BV 位，新值为
  `(旧 XSTATE_BV & ~RFBM) | (XINUSE & RFBM)`；它们只写 XSTATE_BV，不写 XCOMP_BV 和头部其他字节。
  XSAVEC/XSAVES 按 RFBM/in-use 规则重写位图、清零未请求位并设置 XCOMP_BV。
  各指令未规定写入的保留字节保持不变，不能用统一的 header 清零或合并策略替代。
- MXCSR/MXCSR_MASK 有专门的保存与恢复条件，不能简单归结为复制 SSE 分量：
  - XSAVE 在 RFBM[1] 或 RFBM[2] 为 1 时保存 MXCSR 和 MXCSR_MASK。
  - 标准格式的 XRSTOR 在同样条件下，不管 XSTATE_BV 是什么，都从内存加载 MXCSR，并校验保留位。
  - 压缩格式把 MXCSR 归入分量 1，初始化时置为 1F80H。
  - 特别测试只请求 YMM、SSE 标记为 init、非默认 MXCSR、无效 MXCSR 保留位等组合。
- XRSTOR 是否接受压缩格式取决于 XSAVEC：`XCOMP_BV[63]=1` 而
  CPUID.(EAX=0DH,ECX=1):EAX[1]=0 时 #GP(0)。所以 P2 的 XRSTOR 必须拒绝压缩格式，
  P9 开放 XSAVEC 时在同一能力位下放开。
- 64 字节对齐、CPL/TS、段限制、页权限、canonical 地址以及各异常优先级逐项验证。
- 按实际需要访问的字段/分量访存，不预读/预写完整 832 字节，不触碰未请求区域制造额外 #PF。
- 保存前同步 x87 shadow 与编译器缓存；恢复后更新/失效 x87、XMM/YMM、MXCSR 派生状态。
- 明确多次访存故障后的允许部分效果和恢复策略；不把普通向量“先检查后提交”当作
  所有 xstate 指令的统一架构要求。
- 修复共享到这里的 FXSAVE/FXRSTOR 缺陷；FXSAVE/FXRSTOR 本身不应偷偷保存、清零或恢复 YMM 高半：
  - x64 的 FXSAVE 先构造 512 字节零缓冲区再整块写出，而 SDM 规定处理器不写 464–511 字节
    （Linux 在信号帧里用这一段存放 sw_reserved）。XSAVE 只写所选分量的字段，不能沿用整块写出。
  - x64 的 FXSAVE/FXRSTOR 在非 64 位模式下也存取 XMM8–15，应只存取 XMM0–7。
  - 32 位 FXSAVE/FXRSTOR 未对齐时只有 `dbg_assert`，应产生 #GP。

### 6.3 家族扩展的单独验收

| 扩展 | 独立工作与验收 |
| --- | --- |
| XSAVEOPT | 标准格式及合法 init/modified 优化语义；保守保存可作为正确性阶段实现，跳过写入优化另测 |
| XSAVEC | compacted 格式、XCOMP_BV、分量布局和 init 规则；XRSTOR 随同一能力位开始接受压缩格式（6.2 节） |
| XGETBV(1) | 返回与 XCR0/in-use 语义一致的值，独立 CPUID 门控，不强制将架构允许的保守 in-use 判成错误 |
| XSAVES/XRSTORS（M5 最后一步） | CPL0、IA32_XSS 的 RDMSR/WRMSR、用户/监督状态位图及 compacted 保存恢复；未支持 XSS 位写入 #GP |

优化跟踪必须纳入所有写入来源，包括 legacy SSE、VEX、FXRSTOR、XRSTOR、VZERO*、
复位及快照恢复。首轮可以采用规范允许的保守跟踪；不能漏标 dirty 后错误省略写入。
如果实现 modified 优化，还要验证恢复来源、目标缓冲区、权限/地址上下文等适用条件。

开放这些能力会改变客体实际执行的路径，验收要覆盖这些路径：

- Linux 内核在 XSAVE、XSAVEOPT、XSAVEC、XSAVES 中选最后一个可用的。开放 XSAVEC 后，
  每次上下文切换都用 XSAVEC 加压缩格式的 XRSTOR；开放 XSAVES 后，改用 XSAVES/XRSTORS。
- x86-64 glibc 的 ld.so 做惰性绑定时，有 XSAVEC 就用 xsavec，否则用 xsave。每个尚未解析的
  PLT 调用和 TLS descriptor 都会执行它，属于进程启动的热路径。

### 6.4 快照、复位、多核与迁移

布局改动从 `gen/state_layout.js` 生成，不直接手改 `global_pointers.rs` / `src/state_layout.js`。
新增字段能放入当前 4096 字节状态槽（`x64_mc_banks` 之后到 4096 还有约 1.6 KiB），但仍须
运行布局和 parallel relocation 检查，禁止依赖过时文档中的状态总大小。

`src/cpu.js` 当前快照范围按精确 `CORE_STATE_RANGES` 校验。`core_ranges()` 会跨空隙合并相邻的
core 字段，紧接在 2424 之后追加会把旧区间 [2056,2424] 撑大，旧快照随即校验失败。
YMM_Hi128、XCR0 和 XSS 应单独成为一个区间；建议在 `state_layout.js` 中引入显式分组，
不要靠插入非 core 字段来隔开。以下现有机制可以直接复用：

- 多核快照（版本 2）记录各区间，`set_machine_core_state` 对缺失区间填复位值，SMBASE
  （0x30000）就是这样处理的先例。XCR0=1 照此填写。
- 单核旧快照路径先把 1360 以上的 core 区间清零，再补写 PAT 和 SMBASE；XCR0=1 也要在这里补写。
- 老快照缺少新字段：按旧 CPU 能力恢复，YMM 高半初始化为零，XCR0 初始化为 1，XSS 为零。
  不能让通用“缺失字段填零”生成非法 XCR0。旧的 CR4 写入路径接受 OSXSAVE，旧快照里理论上
  可能出现 CR4.OSXSAVE=1，恢复时要按 CPU 配置校验。
- 新快照保存 CPU feature profile、每核 XCR0/YMM/XSS 及架构可见跟踪状态；恢复前完成
  profile、位图和状态范围验证，失败不能部分修改正在运行的 VM。
- 现在的 CPU 配置只是布尔值 `X64_TEST_CAPABILITIES`，cpu_type 也不进快照。应改为能力位图，
  存入顶层快照状态（做法同记录机器类型的 `state[103]`），并经 `copy_cpu_profile` 分发到并行实例。
- 缺少 feature profile 的旧快照，按恢复时 cpu_type 对应的旧能力集解释；不能因升级模拟器让恢复后的 OS
  突然看到新的 AVX 能力。新状态恢复到不支持的实现应清晰拒绝。
- 区分 reset、INIT、SIPI、软重启的架构状态规则，为 BSP/AP 分别测试，不能全部复用清零：
  - XCR0 和 IA32_XSS 只在 RESET 时复位（XCR0=1、XSS=0），INIT 保持不变；
    [KVM 按 SDM 也是这样实现的](https://patchew.org/linux/20220126034750.2495371-1-xiaoyao.li@intel.com/)。
    两者加入 `INIT_PRESERVED`，与 SMBASE 并列。
  - SDM 规定 INIT 不改变 x87/MMX/XMM/YMM/MXCSR，而 v86 现在的 INIT 会把它们取为复位值。
    YMM 按哪条规则处理由第 13 节 Q6 决定，建议连同 XMM、x87、MXCSR 一起按 SDM 修正。
- 同步 [`src/rust/cpu/context.rs`](../src/rust/cpu/context.rs)、
  [`src/parallel/machine.js`](../src/parallel/machine.js) 和 state streaming 的保存恢复。
- 每核使用不同 XMM/YMM/XCR0 指纹，覆盖单 Worker 调度、parallel Workers、暂停恢复、
  迁移到新 VM、故障重启和浏览器 worker 生命周期。

## 7. P3–P4b：SSSE3 与 SSE4

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

### 7.4 浮点准确性是前置任务（P4a）

这项工作比 SSE4.1 本身更大。32 位引擎现有的 SSE/SSE2 浮点算术不设置 MXCSR 状态位，
不支持 RC/DAZ/FZ，也不产生 #XM（第 2 节）。SSE4.1 的 ROUND/DPPS 和 AVX 都要与旧 SSE
共享同一个正确的 MXCSR，因此必须改造全部现有 SSE/SSE2 浮点热路径，而 3DMark06 和游戏的
性能正取决于这些路径。所以单列为 P4a，并配独立的性能验收。

P0 先确定精度策略（第 13 节 Q2）：像默认开启的 `x87_fast_math` 那样保留一个快速模式，
还是默认精确、另设快路径。

P4a 同时修正 32 位引擎中 legacy SSE 的异常条件（3.3 节），新旧形式共用一个检查：CR4.OSFXSR=0
时 XMM 形式 #UD（现在只记日志）；要求对齐的 16 字节内存操作数未对齐时 #GP(0)（现在只有
ADDSUBPS/PD 和 P3 的 SSSE3 形式检查）。x64 引擎已经这样做，兼容模式下两个引擎因此不同。

抽取 x64 已有 FP 处理（`vector.rs`，基于 SoftFloat）中的可复用部分，补齐所有目标指令用到的
f32/f64 操作、转换、比较、舍入及异常记录。可扩展当前 SoftFloat 接口，但不得通过中间
extF80 转换不经证明地替代所有 f32/f64 操作，避免双重舍入。

必测四种舍入方式、DAZ/FZ、正负零、subnormal、无穷、qNaN/sNaN、NaN 来源选择、
溢出/下溢/精度和未屏蔽异常。ROUND 的立即数控制和精度异常抑制、DPPS/DPPD 的
mask 与加法顺序独立实现。AVX 比较支持 32 种谓词，不能复用现有 `predicate & 7` 截断。

Wasm SIMD 仅在结果、NaN、舍入及 MXCSR 效果等价的条件下走快路径，其余进入公共准确
helper。快路径的准入条件：

- MXCSR 控制位是默认值：RC 为就近舍入，DAZ=FZ=0，异常全部屏蔽。
- 输入或结果出现 NaN、非规格化数、无穷或零时（可能引发 IE/DE/ZE/OE/UE），回退到精确 helper。
  实现（P4a）细化为：非规格化操作数，或者结果为 NaN、无穷时回退；MUL、DIV 和窄化转换的结果
  按舍入后判断为微小（绝对值不超过最小规格化数）时回退，除非它是零因子（被除数）得到的精确零。
  零操作数本身不回退。
- 状态位是粘滞的：PE 已置位时，可以省掉不精确检测；PE 未置位时，要么检测不精确，要么回退
  一次，回退之后 PE 就已置位。

旧 SSE 与新 VEX 混合执行同样需要共享正确的 MXCSR，不保留两套互相矛盾的行为。

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
IR 解码器不知道 CPU 模式，总把寄存器形式的 C4/C5 解成 VEX（P1c）。VEX 行有了语义后，
IR 和 Tier-0 的代码要在运行时检查实模式和虚拟 8086 模式并 #UD，与解释器一致
（BMI1/BMI2 的 P10 同样需要）。
VEX.128 的许多整数形式属于 AVX，256 位整数扩展通常属于 AVX2；每个形式按能力定义
判断，不能仅凭 mnemonic 或目的宽度猜测。并非所有标量、点积和转换都存在 L=1 形式。

所有 source/destination 重叠组合都要测试。输入操作数先快照，之后才清高半或写目的；
标量上部位可能来自第一源，不能沿用 legacy destination-preserving 逻辑。
对 256 位 lane 内操作分别执行两个 128 位半区；跨半区的 insert/extract/permute 另有语义。

VMASKMOV 按活跃 lane 访存，被屏蔽 lane 不触发架构要求抑制的内存异常。
测试全零 mask、页边界、不可访问地址、零填充/保留结果和实际写入范围。
不能用一次整 32 字节 load/store 再做 mask 合并替代。被屏蔽 lane 所在页面是否设置 A/D 位
由实现决定：v86 固定一种行为（建议不设置），测试按允许结果判定；实际读写的页面必须设置 A/D 位。

RCP/RSQRT 等近似指令按规定误差及特殊值要求验收，不要求与某一型号硬件逐位相同；
规范唯一确定的精确结果和状态位采用逐位比较。DPPS 水平运算的部分 NaN 传播/位置等
实现相关结果使用允许结果集或 postcondition；v86 自身各后端仍保持确定且一致的结果。
参考 SDM Volume 2A 的 DPPS 条目（[合订本](https://cdrdv2-public.intel.com/835781/325462-sdm-vol-1-2abcd-3abcd-4.pdf)）。

## 9. P7–P8、P10–P11：AVX2 与 x86-64-v3 的其余指令

### 9.1 AVX2（P7–P8）

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

### 9.2 BMI1、BMI2、LZCNT 与 MOVBE（P10）

| 类别 | 指令 |
| --- | --- |
| BMI1 | ANDN、BEXTR、BLSI、BLSMSK、BLSR（VEX 编码）；TZCNT（`F3 0F BC`） |
| BMI2 | BZHI、MULX、PDEP、PEXT、RORX、SARX、SHLX、SHRX（VEX 编码） |
| LZCNT | LZCNT（`F3 0F BD`），只在 x64 配置开放 |
| MOVBE | MOVBE 加载/存储（`0F 38 F0/F1`，只有内存操作数） |

这些都是通用寄存器指令，只依赖 P1 的 VEX 与 `0F38`/`0F3A` 解码，不涉及 YMM、XSAVE 和 MXCSR：

- **标志位**：ANDN、BEXTR、BLSI、BLSMSK、BLSR、BZHI、TZCNT、LZCNT 写入规定的标志，
  其余标志未定义；MULX、PDEP、PEXT、RORX 和 SARX/SHLX/SHRX 不修改标志。未定义标志由 v86
  固定一种取值，测试按允许结果判定。新指令要接入各引擎现有的惰性标志机制：32 位引擎的
  `flags_changed`/`last_op1`/`last_result`，以及 x64 page tier 的惰性标志记录。
- **操作数宽度**：VEX.W1 在 64 位模式下选 64 位操作数，在非 64 位模式下被忽略。
  SARX/SHLX/SHRX 的移位量按操作数宽度取模；BEXTR 的起点/长度和 BZHI 的位置超出操作数宽度时，
  按 SDM 处理（BZHI 此时置 CF）。
- **MULX**：不修改标志，同时写两个目的寄存器；两个目的相同时，结果取乘积的高半部分。
- **TZCNT/LZCNT**：源为 0 时返回操作数宽度并置 CF。能力关闭时按 BSF/BSR 执行，保留现有
  BSF/BSR 在源为 0 时的行为（5.2 节）。
- **MOVBE**：只有内存形式；按操作数宽度做一次读或写再交换字节，不能拆成逐字节访问，也不能多读多写。
- **参考模型**：独立的位级模型覆盖全部宽度的边界值，包括 PDEP/PEXT 的全零/全一掩码、
  BEXTR/BZHI 的越界参数和 MULX 的最大乘数。

### 9.3 FMA 与 F16C（P11）

| 类别 | 指令 |
| --- | --- |
| FMA | VFMADD、VFMSUB、VFNMADD、VFNMSUB 的 132/213/231 形式（PS、PD、SS、SD）；VFMADDSUB、VFMSUBADD 的 132/213/231 形式（PS、PD） |
| F16C | VCVTPH2PS、VCVTPS2PH |

FMA 和 F16C 是 VEX 编码的 SIMD 指令，门控与 AVX 相同，并依赖 P4a 的精确 FP 核心：

- **FMA 的运算规则**：乘法和加法只舍入一次。VEX.W 区分单精度与双精度；132/213/231 决定
  哪两个操作数相乘、哪个相加，三种排列都要测试全部源/目的别名组合。目的寄存器同时也是源操作数：
  标量形式的 [127:32] 或 [127:64] 保留目的寄存器原值，而不是像其他 VEX 标量指令那样取自
  vvvv 源；[MAXVL-1:128] 清零。异常类型是 Type 2（向量）和 Type 3（标量）。
- **FMA 的精确路径**：复用捆绑的 SoftFloat 中已有的 `f32_mulAdd`/`f64_mulAdd`，DAZ/FZ 和 DE 由外层的
  MXCSR 包装处理（与 x64 `vector.rs` 的做法一致）。NaN 的来源选择、0×∞ 加 QNaN 时是否报 IE 等
  特殊值规则，按 SDM 在 SoftFloat 外层实现并逐条测试，不默认 SoftFloat 的 NaN 传播与 x86 一致。
- **FMA 的快路径**：Wasm 没有确定性的融合乘加，relaxed-simd 的 `madd` 可能融合也可能不融合，
  禁止使用。单精度形式可以在 f64 中算出精确乘积，以“舍入到奇数”求和后再舍入回 f32，理论上
  能给出正确舍入（Boldo–Melquiond）；但必须先在 P0 用穷举和随机对拍验证，才能作为快路径。
  双精度形式走 SoftFloat helper。
- **FMA 的性能**：glibc libm 在 FMA 和 AVX2 都可用时，会把 exp、log、pow、sin、cos、tan、atan
  等改用 `_fma` 变体（`ifunc-fma.h`）。所以 FMA 属于热点形式，性能按 12.2 节在新 profile 下单独测。
- **F16C**：VCVTPH2PS 把半精度转为单精度，结果精确。VCVTPS2PH 按 imm8[1:0] 选择舍入方式，
  imm8[2]=1 时改用 MXCSR.RC；它忽略 MXCSR.FTZ，下溢结果转为半精度非规格化数；DAZ=0 时可能报 DE。
  两者都要覆盖半精度的非规格化数、无穷、NaN（含 SNaN 静默化）和 MXCSR 标志，异常类型是 Type 11。
  精确路径可以复用 SoftFloat 的 `f16_to_f32`/`f32_to_f16`。
- **VCVTPS2PH 的写入宽度**：内存目的形式按 VEX.L 只写 8 或 16 字节；寄存器目的形式清零其余高位。

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

Wasm 快路径的已知陷阱，从 P0 起写进模板审查清单：

- PMULHRSW 不能直接用 `i16x8.q15mulr_sat_s`：-32768×-32768 时 x86 得到 0x8000，Wasm 会饱和为 0x7FFF。
- 禁用 relaxed-simd，它的结果因宿主而异。
- Wasm 浮点运算可能规范化 NaN，NaN 结果按现有做法回退。
- `trunc_sat` 的饱和结果与 x86 的整数不定值（0x80000000）不同。
- `pmin`/`pmax` 的操作数顺序要对应 x86 的规则：相等（含 ±0）或有 NaN 时返回第二操作数。
- 用 `i8x16.swizzle` 实现 PSHUFB 时，索引要先 `& 0x8F`。

x86-64-v3 通用寄存器指令的模板要点：

- Wasm 的 `clz`/`ctz` 在输入为 0 时返回位宽，与 LZCNT/TZCNT 一致，32/64 位形式可以直接映射；
  16 位形式要单独处理。
- PDEP/PEXT 没有对应的 Wasm 指令，用按掩码位循环的实现或 helper。
- 64 位 MULX 的 64×64→128 乘法要拆成部分积，或走 helper。
- MOVBE 的字节交换没有单条 Wasm 指令，用移位与掩码组合实现。

发布报告分别给出“完整语义覆盖”和“原生模板/内联覆盖”，避免所有指令都回退执行却被
误报为性能实现完成。复杂指令保留 helper 是允许的，只要语义、可恢复性和性能预算达标。

## 11. 测试与验收矩阵

### 11.1 独立参考与测试格式

复用 [`tests/rust/sse3.mjs`](../tests/rust/sse3.mjs) 的解释器/Tier-0/region 对照、
[`tests/rust/compiled_arms.mjs`](../tests/rust/compiled_arms.mjs) 的编译执行计数，
以及 [`tests/x64/vector_oracle.mjs`](../tests/x64/vector_oracle.mjs) 的外部客体参考方式。

- 整数/CRC/字符串/BMI 采用独立位级模型，避免直接把实现代码复制进测试。FMA 的参考不能
  与实现共用同一份 SoftFloat：在测试中用大整数或有理数精确算出乘加结果再舍入，作为独立参考。
- 使用可用的 x86 硬件结果、固定 QEMU TCG 版本和 SDM postconditions 交叉验证。
  现有 x64 oracle 已记录 QEMU 在部分 FP 异常/NaN 上的差异，不能单纯以 QEMU 为真值。
  QEMU TCG 支持 FMA、F16C、MOVBE、LZCNT（ABM）、BMI1 和 BMI2，可以作为这部分的参考。
  已知的 QEMU 缺口（2026-10-04 对照 QEMU master 核对）：
  - TCG 不支持 XSAVEC/XSAVES（`TCG_XSAVE_FEATURES` 的注释写明缺失）。这两项以及 XRSTORS
    只能依靠硬件或按 SDM 编写的模型判定。
  - QEMU 的 XSAVE/XRSTOR 只在 `rfbm & XSTATE_SSE_MASK` 时处理 MXCSR，而 SDM 规定的是
    RFBM[1] 或 RFBM[2]。“只请求 YMM”的用例必然与 QEMU 不符，需要预先登记一条 `QEMU_DEVIATIONS`。
  - XCR0 同时启用 SSE 和 YMM 后，QEMU 的寄存器转储从 `XMMnn=` 变为 `YMMnn=`；
    `tests/nasm/qemu_oracle.js` 现在只解析 `XMM0n=`，会直接失败。
  - 现有 oracle 用 `-cpu max`，会顺带开启 AES、PCLMUL、SHA、ADX 等范围外能力。依赖能力位的
    负例和 CPUID 用例，以及 TZCNT/LZCNT 回退为 BSF/BSR 的用例，要固定一个与 v86 CPU 配置一致的
    QEMU CPU 型号。
  - QEMU 对 VEX 编码的 SIMD 指令也检查 CR0.EM，而 SDM 的异常类型表只对传统 SSE 列出 CR0.EM。
    以硬件结果为准，登记后再决定是否加入 `QEMU_DEVIATIONS`。
- Apple Silicon 上可运行 QEMU oracle；没有原生 x86 参考时明确记录缺口，发布前在
  具备相应能力的 x86 测试环境补足需要硬件判定的案例。macOS 15 及以上版本的 Rosetta 2 支持
  AVX/AVX2（CPUID 不报告），可作为用户态整数语义的第三方交叉参考。它不是真值，也测不了
  特权指令、XSETBV 和 CPL0 下的 XSAVE；其余 x86-64-v3 指令在 Rosetta 2 下是否可用，要先探测。
- 规范允许多种结果的情形，一律按允许结果集或 postcondition 判定，并集中登记：
  - DPPS 的部分 NaN 传播、RCP/RSQRT 的近似值（第 8 节）；
  - 开启对齐检查时，XSAVE/FXSAVE 未对齐报 #AC 还是 #GP；
  - CR4.OSFXSR=0 时，FXSAVE 是否写 XMM/MXCSR 区；
  - VMASKMOV 被屏蔽 lane 的 A/D 位；
  - gather 故障时，目的/mask 高位和更高序元素的状态；
  - BMI1/BMI2/LZCNT/TZCNT 未定义的标志位。
- 扩展 NASM fixture/GDB/QEMU stub 或新增版本化 guest record，包含所有可见 YMM、
  MXCSR、XCR0、EFLAGS、异常向量/错误码/IP、内存变化。旧 fixture 保持可读。
- AVX 客体初始化必须设置 CR4.OSXSAVE/XCR0，分别处理 CPL0 boot stub 与宿主用户态测试。
- 随机测试固定 seed，失败保存最小字节序列、初态、路径和预期结果，支持独立重放。

### 11.2 必测维度

| 维度 | 必测内容 |
| --- | --- |
| 模式 | real/protected 16/32、VM86、compatibility 16/32、long64；按各指令合法性验证执行或拒绝 |
| 编码 | legacy、VEX2/3、map、pp、W/L/vvvv、ModRM/SIB/VSIB、REX、imm8、非法组合与长度；能力开、关两种配置下的 TZCNT/LZCNT 与 BSF/BSR |
| 数据 | 全零/全一、符号边界、溢出/饱和、随机 lane、全 imm8；FP 特殊值和控制位组合 |
| 寄存器 | 源/目的全别名、隐式 XMM0、ECX/长度寄存器、0–7/8–15、YMM 高低半 |
| 内存 | 对齐/非对齐、真实访问宽度、跨页/跨段、权限、canonical 地址、高物理地址、MMIO、自修改代码 |
| 状态与异常 | CPUID/CR0/CR4/XCR0 组合、`cpuid_level` 降级、SMI/RSM、MXCSR、#UD/#NM/#XM/#GP/#SS/#AC/#PF、失败后的部分效果 |
| 执行路径 | 32 位解释器、Tier-0、regions、64 位解释器、page tier；有/无 Wasm SIMD；兼容模式下 32 位解释器与 x64 引擎的双引擎差分 |
| 生命周期 | reset/INIT/SIPI、每核切换、IR continuation、快照/流式快照、parallel Worker 恢复 |

全 imm8 测试适用于含立即数的目标形式；各模式按可达规则组织代表性组合，不以不可管理的
全部维度笛卡尔积替代有目的的测试。每项高风险交互仍必须有显式案例。

### 11.3 操作系统验收

- 基于已有 Linux x86/x86_64 客体，验证实际 CPUID→OSXSAVE→XSETBV→XSAVE 路径；
  加入进程/线程切换、signal/sigreturn、系统调用和线程跨核迁移的 YMM 指纹探针。
- 验证开放能力后，客体切换到的路径确实被执行且结果正确。这些路径包括：
  - 内核上下文切换所用的 XSAVE 变体，以及 ld.so 惰性绑定的 xsave/xsavec；
  - glibc IFUNC 选中的 `_sse42`、`_ssse3`、`_avx2` 变体，例如 `__strcmp_sse42`、`__strcspn_sse42`、
    `__memmove_ssse3`、`__strlen_avx2`、`__memmove_avx_unaligned_erms`。`_avx2` 字符串变体要求
    AVX2、BMI1、BMI2、LZCNT 同时可用（`ifunc-avx2.h`）；
  - libm 的 `_fma` 变体，要求 FMA 和 AVX2。

  同一组探针也用于 12.2 节的性能测量。
- x86-64-v3 整体验收：在 x64 Linux 客体中，`ld.so --help` 报告 `x86-64-v3 (supported, searched)`，
  `glibc-hwcaps/x86-64-v3` 下的库被实际加载；以 `-march=x86-64-v3` 编译的程序和要求 v3 的发行版
  用户态（例如 RHEL 10 系）能正常运行。
- 基于已有 Windows 8.1 x64 客体，验证 64 位和 WOW64 AVX 程序、线程/异常上下文保存、
  多核及快照恢复；不把桌面启动成功等同于 AVX 状态正确。
- 用明确编译选项构建 SSSE3/SSE4/AVX/AVX2/FMA/F16C/BMI/LZCNT/MOVBE 小程序，并检查产物
  实际包含目标指令。`-march=x86-64-v3` 只引入范围内的能力，可以使用；`-march=haswell` 这类
  整机配置会引入 AES、PCLMUL 等范围外能力，不能作为唯一探针。
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
`avx2-tests`、`bmi-tests`（含 LZCNT/TZCNT/MOVBE）、`fma-tests`、`f16c-tests`、`simd-xsave-tests`，
并接入 CI；这些名称当前不是可依赖的已有目标。
CI 分为快速确定性语义/解码检查与较长的差分、浏览器、OS 集成任务，合并与发布分别设 gate。
`make all-tests` 不能代替上述专项汇总。发布 gate 按 4.1 节的里程碑，在
[`tools/release_gate.mjs`](../tools/release_gate.mjs) 中增加 `R-SSE4`、`R-XSAVE`、`R-AVX`、
`R-x86-64-v3`、`R-XSAVE-ext` 等级，用法与现有的 `R-x64-UP`、`R-q35` 等等级一致。

## 12. 发布、性能和最终检查表

### 12.1 能力开放与兼容策略

内部开发可使用测试专用 feature mask；公共 CPUID 只在整个 ISA 的合法形式、异常和所有
执行入口通过后开放。SSSE3、SSE4.1、SSE4.2、基础 XSAVE、AVX、AVX2、FMA、F16C、BMI1、
BMI2、LZCNT、MOVBE 以及 XSAVE 家族扩展独立验收，并按 4.1 节的里程碑开放；AVX2、FMA 和
F16C 必须建立在完整 AVX/xstate 上。
开放之前还要满足 12.2 节的热点形式前提。

CPU feature profile 在 VM 创建时固定并保存到快照；不允许运行中从旧能力集升级到新能力集。
保留当前旧 profile 用于快照和回归，新建 VM 是否默认采用扩展 profile 在 P12 按兼容性结果
确定（第 13 节 Q1）。若增加公开配置，应同时更新 `v86.d.ts`、starter、CPU Worker 和文档，并拒绝不满足
依赖的能力组合。宿主 SIMD 快路径不可用不应偷偷缩减客体 profile。

更新并人工审核 [`tests/platform/cpu-contract.json`](../tests/platform/cpu-contract.json)，
包括 CPUID.0xD、OSXSAVE 动态变化、不同核数和两类 CPU profile。不能只刷新基线掩盖变化。
同步 `docs/x86-64.md` 的 CPU 能力表及相关 IR/多核说明。

### 12.2 性能预算

P0 固定旧 profile 的启动、整数、x87、SSE、代码生成大小/时间和多核基线。建议发布预算：
既有客体主要工作负载中位数回退不超过 5%，启动场景不超过 10%；超过时先分析和优化。
预算按 Q2 选定的默认精度策略测量，不能为了通过预算另开不准确路径。阈值和重复次数在 P0
与现有 benchmark 的噪声一起固定。

预算要在旧、新两套 profile 下分别测量。能力位开放后客体会切换代码路径（6.3、11.3 节），
同一工作负载转而执行新指令；这些形式如果在编译路径上只走 helper，开放能力反而会让现有
工作负载变慢。因此 5.1 节热点形式清单中属于某个里程碑的形式，必须先在 Tier-0 和 page tier
上有原生模板，该里程碑才能开放能力位。P4a 改造现有 SSE 浮点之后，也要在旧 profile 下
单独过一遍预算。

新 ISA 增加纯寄存器、访存、跨 lane、字符串比较、gather、FMA、位操作和 XSAVE 上下文切换基准，
分别报告解释器、编译路径、helper 占比、Wasm 大小与无 SIMD 构建。性能比较使用相同工作量，
不预设双 v128 实现的 AVX2 必然比 SSE 快两倍。

### 12.3 最终验收

- [ ] 机器可读 forms 清单完整，所有目标形式具有实现和独立测试归属，无未解释缺口。
- [ ] SSSE3 MMX/XMM、SSE4.1/4.2、AVX/AVX2、FMA、F16C、BMI1、BMI2、LZCNT、MOVBE 的
  全部合法编码、模式和操作数形式完成。
- [ ] x64 配置通过 x86-64-v3 检测：glibc 报告 x86-64-v3 受支持，要求 v3 的用户态正常运行。
- [ ] 能力关闭时（包括 32 位配置中的 LZCNT），TZCNT/LZCNT 按 BSF/BSR 执行，与开放时的行为分别通过测试。
- [ ] 基础 XSAVE 及计划内家族扩展逐项完成；未实现的其他状态组件不被公布。
- [ ] CR0/CR4/XCR0/CPUID 的能力检查和故障顺序在各引擎一致，并符合独立规范测试。
- [ ] FP 舍入、NaN、MXCSR 和未屏蔽异常正确，近似指令按误差要求验收。
- [ ] 普通访存、mask fault suppression、gather 部分完成/重启与 xstate 故障分别通过。
- [ ] 32 位解释器/Tier-0/regions、64 位解释器/page tier 及无 simd128 构建通过。
- [ ] 新旧快照、reset/INIT/SIPI、每核状态和 parallel Worker 生命周期通过。
- [ ] Linux、Windows x64/WOW64 的实际 SIMD 上下文切换探针通过。
- [ ] 强制前缀和未列出前缀的规则在三个解码器中一致，兼容模式双引擎差分无分歧。
- [ ] SMI/RSM、`cpuid_level` 降级和所有 CR0/CR4/XCR0 写入方的 JIT 门控测试通过。
- [ ] 热点形式在编译路径上有原生模板，新旧 profile 下的性能预算都达标。
- [ ] 11.1 节的 QEMU 偏差逐条登记，并由硬件或 SDM 模型判定。
- [ ] CPU contract、公开配置与文档一致，既有客体回归和性能预算达标。

达到以上条件才能将本项目标为“完整实现”；仅完成到某一阶段时，按已验收的 ISA 和
XSAVE 子能力报告进度，不将 AVX 基础、AVX2 普通算术或 XSAVE 指令占位称为全部完成。

## 13. 待决问题

以下问题在 P0 结束前给出结论（Q1 除外，它要等 P12 的兼容性结果），并把结论写回相应章节：

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| Q1 | 新建 VM 默认采用哪个 CPU 配置 | 留到 P12 决定。建议：新能力在新旧 profile 下都达到性能预算之前，默认保持旧配置，由用户显式开启 |
| Q2 | SSE/AVX 浮点的精度策略 | **已定（2026-10-04）**：默认精确，用 7.4 节的快路径准入保住性能；性能预算按这一策略测量。P4a 达不到预算时再重新讨论。P4a 结果（2026-10-05）：全套基准中位数不变，SSE 浮点四项 x0.72–0.89（14 节），待复核 |
| Q3 | 是否实现 XSAVES/XRSTORS | **已定（2026-10-04）**：实现，作为 M5 的最后一步，并对 Linux 的 XSAVES/XRSTORS 路径做完整验收 |
| Q4 | 公开配置的 API 形态 | **P0 采纳建议**：能力位图，外加 `x86-64-v2` 这类预设级别；不满足依赖的组合直接报错 |
| Q5 | 兼容模式由哪个引擎执行 | **P0 采纳建议**：共用解码与语义（3.1 节），并保留双引擎差分作为回归手段 |
| Q6 | INIT 是否保留 x87/XMM/YMM/MXCSR | **P0 采纳建议**：按 SDM 保留，与 XCR0/XSS 一起加入 `INIT_PRESERVED` |
| Q7 | 32 位配置是否开放 x86-64-v3 中的指令 | **已定（2026-10-04）**：开放 BMI1、BMI2、MOVBE、FMA 和 F16C，不开放 LZCNT。32 位配置的 CPUID 0x80000000 继续返回 5，旧系统看到的扩展 leaf 不变，`F3 0F BD` 继续按 BSR 执行。x86-64-v3 是否完整只看 x64 配置 |

### 13.1 风险与工作量初评

以下为初步估计，P0 按清单规模校准：

| 阶段 | 工作量 | 主要风险 |
| --- | --- | --- |
| P4a | 高 | 改动现有 SSE 浮点热路径，直接影响 3DMark06 和游戏的性能 |
| P5–P6 | 高 | 形式数量最多，并引入 YMM 状态 |
| P1 | 中 | 统一前缀规则会改变旧 `0F` 表的行为；需要三个解码器协同修改 |
| P8 | 中 | gather 的部分完成与重启语义，以及它与 RETRY 机制的交互 |
| P2、P9 | 中 | 操作系统上下文切换路径；QEMU 无法作为 XSAVEC/XSAVES 的参考 |
| P11 | 中 | Wasm 没有确定性的 FMA，精确与性能难以兼顾；libm 改用 `_fma` 变体后成为热点 |
| P3、P4b | 中低 | 形式多但语义规整；PCMPxSTRx 和 CRC32 需要独立的位级模型 |
| P10 | 中低 | TZCNT/LZCNT 的解码随能力位变化；要接入两套惰性标志机制；PDEP/PEXT/MULX 在 Wasm 中没有直接对应的指令 |

全部完成后，按项目惯例把本计划压缩进 [`docs/x86-64.md`](x86-64.md) 的 CPU 能力表和一份
新的 SIMD 设计文档，然后删除本计划。

## 14. 实施记录

### P0（2026-10-04，基线 `8d2b7c04`）

- **编码清单**：`tools/isa_forms` 用 iced-x86 1.21.0 生成 `gen/isa_forms.json`；`make isa-forms`
  重新生成，`make isa-forms-check` 校验它是否过期。共 814 个形式：SSSE3 32、SSE4.1 53、
  SSE4.2 12、POPCNT 3、XSAVE 6、XSAVEOPT 2、XSAVEC 2、XSAVES 4、AVX 390、AVX2 172、FMA 96、
  F16C 4、BMI1 13、BMI2 16、LZCNT 3、MOVBE 6。另有 370 个范围外的 VEX、`0F38`、`0F3A` 编码
  （`outside_scope`），只要求稳定地产生 #UD。
- **能力定义**：`gen/cpu_features.js` 记录 17 个能力的 CPUID 位置、依赖、可开放的配置和里程碑，
  并与 `gen/isa_forms.json` 和 CPU contract 交叉校验；目前没有任何计划内能力被报告。
- **热点形式**：`make isa-hot-forms` 用 iced 线性解码 Ubuntu 24.04 glibc 2.39
  （libc6_2.39-0ubuntu8.9_amd64.deb）的 libc、libm 和 ld.so，得到 120 个形式，写入
  `gen/isa_hot_forms.json`。按扩展分：AVX 68、AVX2 15、FMA 11、BMI1 7、BMI2 5、SSE4.1 3、
  XSAVE 3、SSSE3 2、LZCNT 2、MOVBE 2、SSE4.2 1、XSAVEC 1。用量最大的是 libm 的 VEX 标量
  双精度运算（VMOVSD、VMULSD、VADDSD、VSUBSD 各有数百到上千处），以及 libc 的 VPMOVMSKB 和
  VPCMPEQB（ymm）、TZCNT、PALIGNR、PCMPISTRI。
- **SDM**：325462-085US（2024 年 10 月，5237 页），见 1.2 节。
- **测试基线**：`platform-contract-tests`、`x64-decode-tests`、`ir-decoder-tests`、
  `ir-coverage-tests`、`sse3-tests`、`packed-simd-tests`、`ir-sse-fp-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests` 全部通过。
- **性能基线**：`make bench-quick` 在负载约为 5 的机器上运行（只作参考，例如 606.nbody.sse
  1444 MIPS、611.mandel.sse 1532、620.simd.sse 1757、621.simd.int 4460）。基线构建的
  `v86.wasm` 保存在本地的 `build/simd-xsave/p0-baseline/`（SHA-256 `be6b4283…`），后续对比
  用 `--baseline` 交错运行，不比较绝对数值。
- **决定**：Q2、Q3、Q7 已定；Q4、Q5、Q6 采纳建议；Q1 留到 P12。

### P1a：统一强制前缀规则（2026-10-04）

- `decode_rules::mandatory_variant` 成为三个解码器（32 位解释器生成器、IR 解码、x64 解码）共用的
  规则：F2/F3 优先于 66，F2/F3 并存时取最后一个（`apply_prefix` 不再累积两者）。在 SSE 映射中
  （表中有 `sse` 或 `refining` 行的操作码），没有对应行的强制前缀在读完 ModRM 后 #UD，
  不读 SIB、位移和立即数，也不做 CR0 检查；其他操作码里 F2/F3 只是被忽略的重复前缀。
- 行为变化（都与 iced-x86 一致）：`66 F3 0F 10` 等组合改为 MOVSS/MOVSD；`F2 66 0F 10` 由
  MOVUPD 改为 MOVSD；未列出的强制前缀在 32 位解释器、兼容模式中也 #UD（以前 release 构建执行
  无前缀形式，x64 只在 64 位模式 #UD）；`F2 F3` 重复前缀取后者（以前 debug 构建断言失败）。
- 表中新增 `refining` 标志：MOVNTI（`0F C3`）和 `0F 78`–`7B` 是强制前缀族但不是 SSE 指令。
- 测试：`tests/ir/decode/decode.rs` 和 `x64::decode` 的单元测试覆盖新规则；新增
  `make decode-rules-tests`（`tests/rust/decode_rules.mjs`），在解释器、Tier-0 和 regions 上
  验证 10 种 `0F 10` 前缀顺序、4 种 CMPSB 重复前缀顺序、8 个未定义强制前缀的 #UD 位置。
  x64 长模式 opcode 矩阵与 iced 的对拍不变（349888 行，iced 判为合法的 123947 行一致）。

### P1e：能力位图（2026-10-04）

- `gen/cpu_features.js` 生成 `src/rust/cpu/features.rs` 的常量（每个能力一位、依赖、CPUID 位置、
  最低 `cpuid_level`、只属于 x86-64 配置的能力）和 `src/cpu_features.js`（供设置解析）。
- 机器级静态变量 `features::FEATURES` 在创建时固定，并经 `copy_cpu_profile` 复制到并行实例；
  CPUID 的叶 1、7、0x80000001 和 0xD.1 按它报告。叶 7 和 0xD 区分子叶，其他叶忽略 ECX。
- 内部设置 `cpu_features`（`starter.js`、CPU worker 透传）：能力名数组，或预设
  `x86-64-v2`、`x86-64-v3`。未知能力、配置不允许的能力（32 位配置的 LZCNT）和缺少依赖时报错；
  `cpuid_level` 报告不了的能力连同依赖它的能力一起去掉（`cpuid_level` 为 7 时去掉 XSAVE、AVX、
  AVX2、FMA、F16C；为 2 时再去掉 BMI1、BMI2）。
- 测试：`tests/x64/cpu_features.mjs`（并入 `make platform-contract-tests`）；`cargo test
  cpu::features`；默认配置的 CPU contract 不变。

### P1b：三字节映射（2026-10-04）

- `gen/x86_table.js` 新增 88 行 `0F38`/`0F3A`：SSSE3 32 行（无前缀的 MMX 形式和 66 的 XMM 形式，
  含 PALIGNR）、SSE4.1 47 行、SSE4.2 5 行（PCMPGTQ 和四条 PCMPxSTRx）、MOVBE 2 行、CRC32 2 行。
  每行带所属能力（`feature`）；尚未实现的行带 `unimplemented`，在读完 ModRM 后 #UD，不读 SIB、
  位移和立即数。`0F 38`、`0F 3A` 本身是 `escape` 行。`node gen/cpu_features.js --check` 校验这些
  行与 `gen/isa_forms.json` 的 legacy 形式一一对应。
- 三个解码器都读第三个 opcode 字节，编码键为 `0x0F38xx`/`0x0F3Axx`（强制前缀在 24–31 位）：
  32 位解释器由生成器产生 `interpreter0f38.rs`、`interpreter0f3a.rs`，`instr_0F38`/`instr_0F3A`
  按操作码字节分派；IR 解码目录 `encodings.rs` 增至 1021 个编码；x64 解码器和 `base_opcode`
  识别这两个映射。`0F 39`、`0F 3B`–`3F` 仍在第二个字节 #UD。以前 `0F 38`/`0F 3A` 在第二个字节
  #UD；现在先读第三字节和 ModRM，这两个字节上的取指故障优先于 #UD。
- 能力门控：能力未开放的行视为不存在。表中的 `refining` 区分两类映射：SSE 映射里 66/F2/F3
  都选择指令；MOVBE/CRC32 只有 F2/F3 选择指令，66 是操作数大小。因此 `F3 0F 38 F0` #UD，
  `66 0F 38 F1` 是 16 位 MOVBE，`66 F2 0F 38 F1` 是 CRC32 r32, r/m16。
- 测试：IR 解码单元测试 `three_byte_maps_decode_and_stay_undefined_until_implemented` 遍历
  全部三字节编码，在能力全关和全开时检查长度与提前 #UD；x64 单元测试在三种模式下检查同样的
  行为；`decode_rules.mjs` 在解释器、Tier-0 和 regions 上验证 13 个三字节编码在开不开能力时
  都 #UD。回归：`nasmtests` 15629/15629，x64 opcode 矩阵与 iced 对拍不变，P0 列出的其余目标
  和 `make rust-test` 全部通过。P1a 漏改的单元测试 `rep_contract_and_progress_maps`（仍要求
  debug 构建拒绝 `F2 F3` 重复前缀）在此更新。

### P1c：VEX 解码（2026-10-04）

- **VEX 行**：`gen/vex_table.js` 从 `gen/isa_forms.json` 为 688 个 VEX 形式各生成一行，键为
  `0xC4_MM_PP_OO`（map 1–3、pp、opcode）。每行记录接受的 VEX 字段与操作数编码：VEX.L、VEX.W
  （WIG32：W 只在 64 位模式有效）、vvvv 是否为操作数（否则必须为 1111b）、只在 64 位模式、
  is4、VSIB、gather 的寄存器互异要求、GPR 指令（BMI1/BMI2，异常类型 13，不要求 AVX 状态），
  以及只有寄存器或只有内存形式。生成时检查任一编码最多被一行接受。IR 目录增至 1711 个编码；
  测试用的 `FORMS` 表给出每个 VEX 行对应的 iced-x86 形式名。
- **共用规则**（`decode_rules`）：`is_vex`（64 位模式总是 VEX，其他模式看下一字节的 bits 7:6
  是否为 11b）、`Vex` 字段解码、`vex_row`（按 ModRM.reg 组、寄存器/内存形式、L、W、模式选行）、
  `vex_valid`（vvvv、VSIB 要求 SIB 且不能是 16 位寻址）、`vex_prefixes_ud`。三个解码器都调用
  它们：32 位解释器经 LES/LDS 寄存器形式进入 `cpu/vex.rs`；IR 解码器的 `decode_vex`；x64 解码器
  的 `decode_vex`（64 位模式下 VEX.R/X/B 扩展寄存器，W1 行的通用寄存器操作数为 64 位）。
- **#UD 位置**（三个解码器一致）：VEX 前有 66、F2、F3、LOCK 或 REX，在 VEX 第一个字节后 #UD；
  保留 map 和没有行的键，在 opcode 字节后 #UD；没有行接受这些字段、能力缺失或尚无语义，在
  ModRM 后 #UD；gather 的目的、索引、掩码寄存器重复，在 SIB 后 #UD。实模式和虚拟 8086 模式
  没有 VEX，C4/C5 的寄存器形式仍是 LES/LDS 的 #UD；IR 解码器不知道模式，VEX 行有语义后需要
  运行时模式检查（P5）。取指故障先于 #UD，只取解码需要的字节。
- **与 iced 的分歧**：16/32 位模式下三字节 VEX 第 2 字节的 bit 6（vvvv 最高位）按 SDM 2.3.5.6
  忽略，也不参与“必须为 1111b”的检查（QEMU 相同）；iced 仍要求它为 1。P1d 的差分登记这一项。
- **TZCNT/LZCNT**：表中 `F3 0F BC`、`F3 0F BD` 两行分别属于 BMI1 和 LZCNT。没有能力时 F3 被
  忽略，按 BSF/BSR 执行；有能力时在 P10 之前 #UD。
- **测试**：只在 cargo test 中有效的 `TEST_DECODE_UNIMPLEMENTED` 让解码器把尚无语义的行当作已
  实现，用来检查长度、操作数和拒绝条件。IR 解码与 x64 解码的单元测试从每个 VEX 行自己的编码
  解出该行（x64 覆盖三种模式），并检查 L/W/vvvv 改变后的选行、VSIB、prefix 和取指顺序。
  `tests/ir/decode/vex_modes.mjs` 在实模式、虚拟 8086、16/32 位保护模式下单步解释器，覆盖
  LES/LDS、VEX 与取指故障顺序；`decode_rules.mjs` 在解释器、Tier-0 和 regions 上验证 12 个 VEX
  编码、LES/LDS 内存形式以及 TZCNT/LZCNT 的两种行为。IR 的 far-control 夹具去掉了寄存器形式的
  LES/LDS（它们现在是 VEX 前缀），invalid-form 夹具跳过 VEX 行。
- **回归**：`make rust-test`（361 个）、`x64-decode-tests`、opcode 矩阵（不变）、`nasmtests`
  15629/15629、`ir-decode-contract-tests`、`ir-tier0-tests`、`ir-differential-tests` 和
  `decode-rules-tests` 等全部通过。`ir-segment-tests` 的 `segments.mjs:93`（描述符 accessed 位
  写故障应当陷出编译代码）失败，在本计划开始前的 `8d2b7c04` 上同样失败，与本计划无关，另行
  处理。P1a–P1b 留下的 rustfmt 差异一并修正，`gen/cpu_features.js` 生成的数组加
  `#[rustfmt::skip]`。

### P1d：与 iced-x86 的解码差分（2026-10-04）

- `tests/decode/simd_corpus.rs`（`cargo test simd_corpus`，并入 `make x64-decode-tests`）在
  16、32、64 位模式下生成 1705444 个编码：map 1–3 的每个 C4 opcode 配合各 pp，以及 VEX.L、W、
  vvvv（低位和最高位）、R/X/B 的组合；C5 形式；保留 map；VEX 前的 66/F2/F3/LOCK/段/67/REX；
  `0F 38`、`0F 3A` 和 `0F BC/BD` 的强制前缀顺序（64 位模式另加 REX.W）。每个编码配 8 个
  ModRM（各 ModRM.reg 的寄存器和内存形式，内存形式带 VSIB 可用的 SIB）。
- 打开全部能力、把尚无语义的行当作已实现时，x64 解码器认可其中 133550 个。16/32 位模式下 IR
  解码器对全部 1082120 个编码给出相同的行和长度，#UD 时与 x64 解码器取到的字节数相同（提前
  #UD 的位置一致）。关闭能力，或打开能力但没有语义（发布时的情形）时，VEX 和三字节映射的
  编码全部 #UD，`F3 0F BC/BD` 在没有 BMI1/LZCNT 时执行 BSF/BSR。
- `tests/x64/oracle` 用 iced-x86 1.21.0 解码同一批编码，比较有效性（iced 有效且所需 CPUID
  能力都在本计划或基线之内）、长度和 VEX 形式名，全部一致。唯一登记的分歧是 2916 个 16/32 位
  三字节 VEX 编码：vvvv 最高位为 0，SDM 2.3.5.6 说忽略，iced 判为无效；把这一位改成 1 后，
  iced 解出的形式和长度与 v86 相同。
- 兼容模式下两个引擎的执行差分（第 2 节末）随各阶段的语义一起做：目前所有新形式都在两边
  #UD，位置由上面的解码一致性保证。

### P2：XCR0、YMM 高半与基础 XSAVE/XRSTOR（2026-10-04）

- **状态**：`gen/state_layout.js` 新增每核 `xcr0`、`xss` 和 `ymm_hi`（16 个 128 位），自成快照区间
  [2432, 2704]。字段可以声明 `range`，不同 range 的字段不合并成一个区间。旧快照缺这一区间时，
  XCR0 填 1、其余为 0，多核快照和单核旧快照两条路径都这样处理。字段还可标 `init: "keep"`，由此生成
  `INIT_PRESERVED`：INIT 保留 x87、MMX/XMM、MXCSR、YMM 高半、XCR0 和 XSS（Q6），以及原有的
  PAT、MTRR、机器检查寄存器和 SMBASE。`cpu.js` 与并行 vCPU worker 共用这份列表（worker 以前
  漏了 SMBASE）。RESET 时 XCR0 为 1。
- **CPUID**：叶 1 ECX[26] 报告 XSAVE，[27] 的 OSXSAVE 随 CR4。叶 0xD 子叶 0 报告支持的 XCR0
  （没有 AVX 时为 3，有时为 7）、当前 XCR0 和全部支持分量各自所需的标准格式大小（576 或 832）；
  子叶 2 报告 YMM_Hi128 的大小和偏移；其他子叶为零。
- **CR4**：legacy 和 x64 的 MOV CR4 以及 RSM 共用 `cr4_valid_bits()`：VME 至 OSXMMEXCPT，
  OSXSAVE 只在有 XSAVE 时允许。legacy 路径不再接受 CPUID 没有报告的 VMXE、SMXE、PCIDE、SMEP、
  SMAP 等位。RSM 恢复到带保留位的 CR4 时进入 shutdown。
- **XGETBV/XSETBV**（`0F 01 D0/D1`）在三条执行路径都已实现。没有 CR4.OSXSAVE 或带 66/F2/F3 前缀时
  #UD。XSETBV 只接受 XCR0，值必须包含 x87、只含支持的分量、YMM 必须同时有 SSE，CPL>0 时 #GP。
  XGETBV(1) 在 P9 之前 #GP。XSETBV 会推进 IR 的准入版本。
- **XSAVE/XRSTOR**（`0F AE /4`、`/5`；64 位模式下带 REX.W 为 XSAVE64/XRSTOR64）使用共用的
  编解码 `cpu/xstate.rs`，只支持标准格式：
  - 按所请求的分量逐字段存取，不写保留字节和 464–511 字节；64 位模式外不碰 XMM8–15 和
    YMM8_H–15_H。
  - XINUSE 按 SDM 13.6 定义的初始配置精确计算；RFBM[1] 或 [2] 为 1 时存取 MXCSR。
  - XRSTOR 检查 XCOMP_BV[63]、头部字节 8–23、XSTATE_BV 是否超出 XCR0，以及 MXCSR 保留位。
  - 每个执行引擎实现 `Area`：32 位解释器和 IR helper（`ir_xsave`、`ir_xrstor`）按线性地址访存，
    x64 引擎用自己的访存函数。所有字段先检查页故障再搬运数据，故障时内存和状态都不变。
  - 异常顺序：#UD（OSXSAVE），#NM（CR0.TS），然后才是操作数的段检查，接着 #GP（64 字节对齐），
    最后 #PF。32 位解释器为此让 XSAVE/XRSTOR 自己解析操作数地址（`custom_modrm_resolve`）；
    IR 的 coverage 差分发现过这一顺序与 IR helper 不一致。
- **`0F AE` 改为 refining**：66/F2/F3 在这一组选择 CLFLUSHOPT、RDFSBASE、PTWRITE、INCSSP 等
  本机没有的指令，所以都在 ModRM 后 #UD，与 iced 一致。
- **FXSAVE/FXRSTOR** 也改用共用编解码。32 位执行路径未对齐时 #GP，以前只有 `dbg_assert`。
  x64 的 FXSAVE 不再写 464–511 字节（以前写出整个 512 字节零缓冲区）。64 位模式外只存取 XMM0–7。
- **快照**：顶层 `state[106]` 记录 CPU 能力位图。恢复到能力不同的机器时，在修改任何状态之前报错；
  旧快照按没有计划内能力处理。同时修复 `set_state` 的一个旧缺陷：它把 `last_result`、
  `fpu_status_word`、`mxcsr` 的内存视图换成了快照里的数组，恢复后 JS 读到的是过期值。
- **测试**：
  - `make xsave-tests`：
    - `tests/rust/xsave.mjs` 在解释器、Tier-0 和 regions 上覆盖 CPUID、CR4、XGETBV/XSETBV、
      往返、部分保存、初始化、各种异常、页故障无部分效果，以及不访问未请求分量的位置。
    - `tests/x64/xsave.mjs` 覆盖 64 位模式和兼容模式下的格式，以及 x64 引擎的 9 种异常，
      解释执行和 page tier 各跑一遍。
    - `tests/smp/xstate_lifecycle.mjs` 覆盖快照、INIT、RESET、旧快照和能力校验。
  - `cargo test cpu::xstate`。
  - IR fp_state 差分扩展到 XSAVE/XRSTOR，共 392 个用例：OSXSAVE、TS、空段的先后顺序，MMIO，
    以及跨页 #PF。
  - `tests/devices/smm.js` 新增 SMI/RSM 用例。
  - `make kvm-unit-test-xsave`：kvm-unit-tests 的 x86/xsave（x86_64 构建）在无能力、XSAVE、
    XSAVE+AVX 三种配置下分别通过 4、15、17 项。为此，构建脚本不再把 clang 对该库的 format 和
    constant-conversion 警告当作错误。
- **客体**：Alpine x86_64（virt 内核，单核，page tier）在 `cpu_features: ["XSAVE"]` 下启动到 shell，
  并通过 64 位和 32 位探针。内核报告 "Enabled xstate features 0x3, context size is 576 bytes,
  using 'standard' format"，上下文切换使用 XSAVE/XRSTOR。
- **回归**：`make rust-test`、`x64-decode-tests`、opcode 矩阵、`nasmtests`、`ir-decode-contract-tests`、
  `ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、`sse3-tests`、
  `packed-simd-tests`、`ir-sse-fp-tests`、`x64-system-tests`、`smp-tests`、`api-tests`、
  `q35-device-tests`、`kvm-unit-test`、`decode-rules-tests` 和 `platform-contract-tests` 全部通过。
- **事后修正（P3 期间）**：P2 的回归没有包括 `x64-differential-tests` 和 `x64-page-tier-tests`。
  它们发现 x64 引擎的 FXSAVE/FXRSTOR（与 XSAVE 共用 `Area`）在保存区跨入缺页时，#PF 的 CR2
  指向越界字段的最后一个字节，而不是缺页的第一个字节。现已与 32 位路径和 QEMU 一致，修正单独提交。

### P3：SSSE3（2026-10-04）

- **语义**：`src/rust/cpu/simd_int.rs` 是公共的打包整数语义：输入输出都是字节向量，不读写 CPU
  状态。MMX 形式为 8 字节，XMM 形式为 16 字节，VEX.256 以后按 128 位 lane 复用。覆盖 16 条指令：
  PSHUFB、PHADDW/D/SW、PMADDUBSW、PHSUBW/D/SW、PSIGNB/W/D、PMULHRSW、PABSB/W/D、PALIGNR。
  单元测试覆盖：PSHUFB 的 bit 7 清零和索引截断（MMX 取低 3 位，XMM 取低 4 位）、饱和边界、
  最小负数的取反和绝对值、PMULHRSW 的舍入、PMADDUBSW 的无符号×有符号组合，以及 PALIGNR 的
  全部 imm8。
- **32 位解释器**：`instructions_0f38.rs`、`instructions_0f3a.rs` 按生成器的命名提供各形式。
  32 行 SSSE3 去掉 `unimplemented` 和 `skip`（后者让它们进入 nasm 测试）。
  - 没有 SSSE3 时 #UD，先于 #NM；F2/F3 前缀 #UD。
  - XMM 形式的内存操作数未按 16 字节对齐时 #GP(0)（异常类型 4），与已有的 ADDSUBPS/PD 相同，
    新增 `safe_read128s_aligned`。MMX 形式没有对齐要求。
  - MMX 形式按 MMX 规则改写 x87 状态：目的寄存器的指数为全 1，TOP 为 0，标记全有效；内存故障时
    x87 状态不变。
- **IR**：
  - Tier-0 对 PSHUFB 和 PALIGNR 有原生模板（`i8x16.swizzle`、`i8x16.shuffle`），覆盖 MMX 和
    XMM、寄存器源和内存源。XMM 内存操作数未对齐时重试，由解释器产生 #GP。其余 SSSE3 形式
    逐条交给解释器执行（`ir_t0_step`）。
  - regions 对 PSHUFB、PALIGNR 的寄存器形式原生翻译：PSHUFB 是 `PackedOp::ShuffleBytes`，
    PALIGNR 是 `VectorShuffle`，移出源寄存器时与零向量 shuffle。其余形式以及这两条的内存形式经
    helper：MMX 形式走 `ir_mmx_*`；XMM 形式走 SSE helper（`ir_sse_fp_*`），寄存器形式在审计
    名单内，调用后只重新载入目的 XMM。
  - Tier-0、regions 和 page tier 的 PALIGNR shuffle lane 都来自 `simd_int::palignr_lanes`。
- **x64**：`x64/vector.rs` 执行全部 MMX/XMM 形式；64 位模式下可用 XMM8–15，MMX 寄存器忽略
  REX。page tier 对 PSHUFB、PALIGNR 的 XMM 形式有原生模板，其他形式逐条解释（Step）。兼容
  模式下两个引擎都执行 SSSE3，测试中与 QEMU 一致，包括编译后的兼容模式代码。
- **热点形式（5.1 节）**：SSSE3 的两个热点形式 PALIGNR xmm、PSHUFB xmm 在 Tier-0、regions
  （寄存器形式）和 page tier 上都是原生代码。一个 PSHUFB+PALIGNR 循环的速度：解释器 32 MIPS，
  Tier-0 531 MIPS，regions 381 MIPS。只走 helper 的 PMADDUBSW+PHADDW 循环为 20–33 MIPS，
  它们的性能留到 P12。
- **测试**：
  - `make ssse3-tests`：
    - `tests/rust/ssse3.mjs` 以 `tests/rust/ssse3_model.mjs` 为准。该模型按 SDM 伪代码独立
      编写，不调用 `simd_int.rs`。在解释器、Tier-0、regions 上运行全部 32 个形式，共 2432 例：
      寄存器源和内存源、目的即源、PALIGNR 全部 256 个 imm8。另外覆盖 MMX 的 x87 转换，
      #UD/#NM/#GP/#PF 及故障时目的寄存器不变，并检查 Tier-0 确实执行了 PSHUFB/PALIGNR 模板。
      分别在 Wasm SIMD、debug 和无 SIMD 构建上运行。
    - `tests/x64/ssse3.mjs` 覆盖 64 位模式和兼容模式下的 285 例和 8 种故障，结果与 QEMU 和模型
      都一致。分别以解释执行、page tier、page tier 加兼容模式 JIT 运行，并检查 page tier 模板
      确实执行（热循环中 69.8 万条指令原生退休，只有 3 次 step）。
  - nasm：`create_tests.js` 支持三字节映射，新增 320 个 SSSE3 测试，QEMU fixture 全部通过；
    `run.js` 打开 SSSE3。
  - IR：MMX 和 SSE helper 的 fixture 差分包含 SSSE3 形式，差分所用机器打开了 SSSE3。
    `mir_value` 检查 PSHUFB/PALIGNR 的寄存器形式原生、内存形式走 helper。Tier-0 fuzz 新增
    SSSE3 类别（`FUZZ_KIND=s10`）。
  - 解码：x64 和 IR 的解码测试改用 SSE4.1 行作为“未实现”的例子，并新增 SSSE3 行的解码测试。
    `decode_rules.mjs` 中 SSSE3 只在没有能力时 #UD。P1d 语料的约定改为：有能力时，只有已实现
    的行可以解出。
- **回归**：`ssse3-tests`、`rust-test`、`x64-decode-tests`、`ir-decoder-tests`、
  `ir-decode-contract-tests`、`decode-rules-tests`、`ir-mmx-tests`、`ir-sse-fp-tests`、
  `ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests`、`packed-simd-tests`、`sse3-tests`、`xsave-tests`、
  `x64-system-tests`、opcode 矩阵、`x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、
  `nasmtests-force-jit`、`kvm-unit-test`、`smp-tests`、`api-tests` 和 `platform-contract-tests`
  全部通过。`q35-device-tests` 中 `tests/devices/smm.js` 的两个 x86-64 用例偶发失败；计划开始前的
  `8d2b7c04` 上同样如此（6 次中失败 2 次），与本计划无关，已另立任务。
- **遗留**：
  - 32 位路径的 legacy SSE 在 CR4.OSFXSR=0 时仍只记日志，旧形式也不查对齐（3.3 节）。SSSE3
    与旧形式共用前一项检查，两项一并在 P4a 修正（7.4 节）。
  - MMX 形式不因 x87 未决异常产生 #MF，与现有 MMX 形式一致。

### P4a：精确的 SSE 浮点（2026-10-05）

本节记录 P4a 的第一部分：32 位引擎的 SSE/SSE2/SSE3 浮点改为精确实现。legacy SSE 的
OSFXSR 和对齐检查（3.3 节）是第二部分，单独提交。

- **公共核心**：`src/rust/cpu/simd_fp.rs` 实现全部 SSE 浮点形式的精确语义，32 位解释器、
  regions 的 helper 和 x64 解释器（`x64/vector.rs`，删去了它自己的一份）共用：
  - SoftFloat 的 8086-SSE 规则：x86 的 NaN 选择，舍入后判断微小。
  - MXCSR：RC，DAZ，FZ（只在 UM 屏蔽时），粘滞的状态位。异常顺序按 SDM 第 1 卷 11.5.3 节：
    运算前的异常（IE、DE、ZE）未屏蔽时直接产生故障，不再置运算后的状态位；然后才是 OE、UE、PE。
    产生故障时目的寄存器不变。同一 lane 中，QNaN 操作数、无效运算和 ZE 优先于 DE。UE 未屏蔽时，
    任何微小结果都产生异常，即使结果精确。
  - 微小按舍入后判断，取 SoftFloat 的 underflow 标志：不精确且舍入后进到最小规格化数的乘积
    或商也算微小（UE；FZ 时清零）。测试新加的边界值发现了这个问题，同时修正了核心和两条快路径。
  - 未屏蔽的异常：CR4.OSXMMEXCPT=1 时 #XM（向量 19），否则 #UD。
  - 覆盖 ADD/SUB/MUL/DIV/MIN/MAX/SQRT/CMP 的 PS/PD/SS/SD 形式、HADD/HSUB/ADDSUB、
    (U)COMISS/SD 和全部转换。RCP/RSQRT 不产生异常：返回正确舍入的近似值，非规格化输入
    视为零，微小结果为零。
  - x64 page tier 原本就是精确的（TwoSum/TwoProduct 检测不精确），未改动。
- **快路径准入**（7.4 节，`src/rust/ir/native_fp.rs`）：
  - MXCSR 条件为 `(mxcsr & 0xFFE0) == 0x1FA0`。
  - lane 条件：操作数不是非规格化数；结果有限。MUL、DIV 和窄化转换的结果按舍入后判断不是微小
    （绝对值大于最小规格化数），零因子（被除数）得到的精确零除外。MIN/MAX、比较和扩宽转换只要求
    操作数既不是 NaN 也不是非规格化数。RCP/RSQRT 要求源是有限的规格化数（RSQRT 还要为正），
    结果不低于最小规格化数。
  - 解释器的快路径（`simd_fp::fast_lane`）采用同一条件。
  - 掩码的实现方式：有限值用 `x - x == 0`；非规格化数用 2|x| - 1 的范围；双精度只比较高半部分，
    最小规格化数本身也会被拒绝。常量在每个 32 位 lane 中取同一个值，在 ARM64 上各是一条立即数
    指令。任意 v128 常量每次使用都要经过一次通用寄存器和一次传送，代价比检查本身还大。
- **Tier-0**：
  - MXCSR 条件每个块只算一次。
  - 被拒绝的指令通过 `ir_t0_sse_fp`（操作数块上的 helper）在原地精确执行，不再交给解释器重试。
    原先的重试会留下入口点，把热循环切成许多小块：每两条浮点指令之间都要把 XMM 缓存写回再读回。
    只有在指令产生故障，或 lane 检查失败而本指令要记录寄存器事实时，才重试。
  - `Page::xmm_clean` 记录块内寄存器中已知既不是 NaN 也不是非规格化数的 lane，这些操作数不再
    检查。来源有：被准入的 MUL/DIV/SQRT/MIN/MAX 和转换的结果、已检查过的操作数、寄存器复制、
    搬动整个 lane 的 shuffle、`XORPS x, x`。ADD/SUB 的结果不算在内，它可能是精确的非规格化数。
  - 标量 MUL/DIV 先做一次廉价检查，指数为零或结果微小时才做完整检查，零只能在完整检查中放过。
    打包形式直接做完整检查，因为向量和矩阵数据常含零，廉价检查每次都会失败。
- **regions**：ADD/SUB/MUL/DIV 的寄存器形式仍是原生代码，按同样的条件准入；其他形式走 helper。
- **性能**（12.2 节）：`tests/bench` 全套 36 项与 P3 交错比较（M1 Pro，负载约 3–4；
  `build/simd-xsave/p4a-bench-full.json`），warm 几何平均 x0.975，cold x0.971，中位数约 x1.00，
  在 5% 的中位数预算之内。SSE 浮点四项回退：601.matmul.sse x0.72、606.nbody.sse x0.83、
  611.mandel.sse x0.89、620.simd.sse x0.72。其余各项（整数、x87、MMX、SSE2 整数）在 x0.94–x1.06
  之间，属于噪声。最初的精确版本在这四项上只有 x0.42–0.58。
  - 剩余开销主要有两项，都按指令逐条计算：一是还未确认干净的操作数要做非规格化检查，每对约 6 条
    指令；二是乘积要做带零例外的微小检查，约 6 条指令。检查分支和 MXCSR 的代价很小。
  - 可继续的方向：块间传递寄存器事实（循环中不变的寄存器每轮都要重新检查），以及按指令位置
    自适应地选择一级或两级检查。
  - 这一回退记录在第 13 节 Q2，供复核。
- **测试**：
  - `make sse-fp-tests`：
    - `tests/rust/sse_fp.mjs` 以 `tests/rust/sse_fp_model.mjs` 为准。该模型用 BigInt 做精确的
      有理数运算，不依赖 SoftFloat 和 `simd_fp.rs`。测试覆盖 68 个形式、寄存器源和内存源、
      11 种 MXCSR，以及 #XM 和 #UD，共 117744 例，在解释器、Tier-0 和 regions 上运行；
      分别用 release、无 SIMD 和 debug 构建。
    - `tests/ir/differential/sse_fp_tracking.mjs` 用 15 个序列检查 Tier-0 记录的寄存器事实，
      逐条验证过：故意写错的三条规则（ADD 结果算作干净、shuffle 只要部分 lane 干净就算干净、
      标量检查推出整个寄存器干净）都会被对应序列发现。
  - Tier-0 fuzz 比较 MXCSR，并新增两类：`s11` 用特殊值和 9 种屏蔽的 MXCSR；`s12` 针对寄存器
    事实。两类程序每轮开头都用 LDMXCSR 和 MOVAPS 重置状态，因为 MXCSR 的状态位是粘滞的，
    之后的轮次会把漏掉的状态位补上。
  - x64 的 vector oracle 在共用核心上解释执行和 page tier 下都通过。`ir-sse-fp-tests` 检查
    helper 和原生路径的约定（原生路径要求 PE 已置位）。
- **回归**：`sse-fp-tests`、`ssse3-tests`、`rust-test`、`x64-decode-tests`、`ir-decoder-tests`、
  `ir-decode-contract-tests`、`decode-rules-tests`、`ir-mmx-tests`、`ir-sse-fp-tests`、
  `ir-coverage-tests`、`ir-fp-state-tests`、`ir-tier0-tests`、`ir-differential-tests`、
  `ir-simd-integer-tests`、`ir-simd-shuffle-tests`、`packed-simd-tests`、`sse3-tests`、`xsave-tests`、
  `x64-system-tests`、opcode 矩阵、`x64-differential-tests`、`x64-page-tier-tests`、`nasmtests`、
  `nasmtests-force-jit`、`kvm-unit-test`、`smp-tests`、`api-tests`、`platform-contract-tests`、
  rustfmt 和 state layout 检查全部通过。
