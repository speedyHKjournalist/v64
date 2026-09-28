# X4：x64 页层（长模式 page tier）

2026-09-28。本记录说明长模式（Long64）代码的编译执行路径、正确性证据与性能数据。它取代 [原生寄存器块](native-register-blocks.zh-CN.md) 在 CPU 主循环中的位置（`x64/compiler.rs`、`cache.rs` 仍保留供 `native_oracle.mjs` 单测，但不再从 `cpu.rs` 调用）。

## 设计

与 32 位 Tier-0 同形：**每个 4 KiB 长模式代码页一个 Wasm 函数**，入口处 `br_table` 按页内偏移分派到基本块，块之间直接延续，不回 CPU 主循环。

| 部件 | 文件 | 要点 |
| --- | --- | --- |
| 编译器 | [`src/rust/x64/pagegen.rs`](../../../../src/rust/x64/pagegen.rs) | 用 X1 共享解码器发现块起点（入口、页内分支目标、返回地址、每个解释步之后），模板覆盖常见整数、栈、控制流、字符串、原子与部分系统指令；其余由解释器“就地步进” |
| 运行时 | [`src/rust/x64/pages.rs`](../../../../src/rust/x64/pages.rs) | 热度（每页解释 2000 条后编译）、入口记录与重编译、共享 Wasm 表发布、入口校验、代码页失效、辅助函数 |
| 访问缓存 | [`src/rust/x64/jac.rs`](../../../../src/rust/x64/jac.rs) | 每核 × 读/写 × CPL0/CPL3 的直接映射线性页 → 宿主页表，生成代码内联查表；tag 高位含 epoch |
| 发布 | [`src/cpu.js`](../../../../src/cpu.js) `x64_page_publish` | 宿主允许时同步实例化（`ir_sync_publication`），否则异步；按 id+slot 校验后 `table.set` |

关键契约：

- **与位置无关**：函数按“后备物理页”而非线性页索引，运行时由 `gp::x64_page_linear` 给出所在线性页；RIP 相对地址、返回地址、页外目标都在运行时加基址。同一共享库/可执行页在不同进程（ASLR）中复用同一函数。页外直接分支在运行时检查规范地址，非规范目标按 SDM 在分支指令处 #GP。
- **寄存器与 RIP**：16 个 GPR、EFLAGS、RIP 在局部变量中；每次出口、每次解释步前后写回/重载，因此任何 Rust 代码运行时内存状态总是权威的。
- **三种出口**：正常（RIP 已设）、RETRY（某访问不能在本地完成——缺页/保护故障、设备或 VGA 内存、写入含编译代码的页、跨页访问——此时本指令尚无任何效果，运行时用解释器执行这一条）、UNKNOWN（分派到本函数未服务的页内偏移，运行时记录入口，累计后重编译）。
- **解释步**：非模板指令写回状态后调用 `x64_page_step`（执行一条，含设备、中断延迟规则），若执行上下文（CPL、CS、模式、CR0/3/4、EFER、IF/TF/AC/RF/IOPL、DR7、访问缓存 epoch、代码写入计数）变化、进入 HLT、中断影子或出现可交付中断/NMI，则退出激活；否则回到分派。
- **EFLAGS 惰性记录**：全标志生产者只按页内活跃性即时计算部分位，其余位留在局部记录（种类 | 宽度 | 进位输入 | 待算位掩码，操作数 FA/FB）；读者、解释步、所有出口只在需要的位仍待算时调用 `x64_page_flags`（复用解释器 `execute::alu`）物化。活跃性因而只是性能估计，不决定正确性。同块内 CMP/SUB/TEST/AND 类生产者后的 Jcc/SETcc/CMOVcc 直接比较操作数。
- **访问缓存失效**：每次该核 x64 TLB 失效（CR 写、INVLPG、EFER、物理窗口变更、快照恢复 TLB）都推进该核 epoch；任一页新增编译代码（`jit::ir_reserve_slot`）使所有核的写表失效，所以本地存储从不写入含编译代码的页，写代码页必然经解释器并触发 `jit_dirty_page` 失效。
- **SMC**：代码页写入（CPU、DMA、宿主）经 `jit::jit_dirty_page` 通知 `pages::dirty_page`，所在函数退役、槽位在下一个冷点释放；解释步若使代码写入计数变化则立即退出激活。
- **STI**：模板置 IF 并按解释器语义留一条影子指令（`interrupt_shadow = 1`），随即退出，影子指令由解释器执行后再交付中断。
- **REP MOVS/STOS**：前向、每个操作数都在一页内、均为 RAM（宽 STOS 需存 0）时用 `memory.copy`/`memory.fill` 一次完成，重叠的前向 MOVS 保留逐元素语义；其他情况就地解释步（解释器每步最多处理一页 RAM 数据）。
- **容量**：最多 1500 个活动函数（Wasm 表 2400 项，与 32 位 IR 共享），超出时淘汰最久未用者；每页最多重编译 12 次（反复自修改的页随后留在解释器）。

长模式代码在 `ir_tier0` 为真或为假时都使用本层（32 位代码仍按该选项走 Tier-0 或区域管线）；x64 的区域（Tier-1/2）优化管线尚未实现，兼容模式代码目前仍由解释器执行。

## 正确性证据

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| `X64_JIT=1 tests/x64/integer_oracle.mjs` | 1552 个 QEMU 参考整数/标志/原子用例，整组重复 10 遍，后续各遍在页函数中执行 | 通过（页函数退休 317 万条指令，解释步 6,427 次）|
| `X64_JIT=tier0 tests/x64/vector_oracle.mjs` | 958 个向量/x87 用例 + 与 SIMD 步进混合的热循环 | 通过（页函数退休 400 万条）|
| [`tests/x64/page_fuzz.mjs`](../../../../tests/x64/page_fuzz.mjs) | 随机长模式程序（全部宽度、SIB/RIP/FS 基址、LOCK RMW、栈、调用、前向分支、解释步、跨页访问、DIV/IDIV 含宽被除数、MOVS/STOS（含重叠/DF/跨页）、SWAPGS、CMPXCHG8B/16B、SHLD/SHRD、MOV Sreg、每轮 50% 概率清空 TLB 与访问缓存），循环到被编译后与纯解释器逐字节比较全部 GPR、RFLAGS 与两页数据 | 见下 |
| [`tests/x64/page_system.mjs`](../../../../tests/x64/page_system.mjs) | 与 QEMU 和解释器三方比较：CPL3 循环与用户访问监督页、缺页/写保护/NX 取指故障在热循环中经 RETRY 交付、自修改另一已编译页、自修改正在运行的页、同一后备页经两个线性别名执行（位置无关）、STI 影子后自 IPI 恰在一条指令后交付 | 8 个场景全部一致 |
| `tests/x64/multicore.mjs` | 四核长模式 INIT/SIPI、状态/TLB 隔离、CX16、IPI/NMI、快照重放；两种 JIT 配置各 4 组 | 12 组全部通过，每核都有原生退休 |
| `X64_JIT=1 tests/x64/system_oracle.mjs`（含 `X64_IR_TIER0=0`） | 61 个 QEMU 系统/异常用例 + 14 个 SDM 断言 | 通过 |
| `tests/x64/high_memory.mjs` | 位于 4 GiB 以上的热代码被编译，再经 4 GiB 映射改写后重新执行；CR3 位于 4 GiB 以上 | 解释器与页层结果一致，页函数被写入退役 |
| `make ir-tests ir-tier0-tests api-tests` | 32 位 IR/Tier-0 全套与 API 测试 | 通过（API 测试暴露并修复了一个旧缺陷：`with_wide_state_buffer` 把 2 GiB 以上的 `v86_malloc` 结果当作负数）|
| `tests/x64/cache_oracle.mjs` | 经低别名改写高 RIP 代码 | 通过 |

随机差分：本轮在最终构建上跑 30 个种子 × 48 个程序（`PAGE_FUZZ_SEED=101..130`），全部与解释器一致，每个种子 75–98 万条页函数指令，见 [日志](logs/page-fuzz-final-2026-09-28.txt)；开发期间另跑了种子 11–71 共约 60 组。开发过程中差分共发现并修复 4 个编译器缺陷，均有回归用例：

1. CMOV 源值与融合 OF 条件共用临时局部变量（最小化为 5 条指令）。
2. 仅按活跃性省略标志：RETRY 出口落在融合的 CMP 与 Jcc 之间时写回了未计算的标志（促成惰性标志记录设计）。
3. REP MOVS 中目的地址慢路径覆盖了保存源宿主地址的局部变量（Linux `prepare_creds` 空指针 Oops 暴露）。为此模糊器改为每轮混入循环计数器并常态清空访问缓存；用变异验证：重新引入该缺陷后 4 个种子中 3 个报告差异。
4. 编译超过指令上限时截断块的收尾（`End::Retry`）。

另外发现一个 X5 层缺陷：`jac::ram_backing` 把重映射到 4 GiB 以上 RAM 的后备页当作低端空洞，导致高 RAM 代码从不编译、所有高 RAM 本地访问走慢路径（已修复，`high_memory.mjs` 覆盖）。

## 真实 OS 与性能

Alpine 3.24 x86_64（Linux 6.18，官方 ISO）登录并通过全部 64/32 位探针（含 XC 矩阵）的墙钟时间（10 核 macOS 主机，负载约 6–9，debug Wasm）：

| 配置 | 解释器 | 页层 |
| --- | --- | --- |
| 1 核 | 约 15.7 min | 1 min 16 s |
| 2 核 | 约 85 min | 1 min 52 s |
| 4 核 | 约 140 min（多次 soft lockup 告警） | 2 min 08 s（无告警） |
| 1 核，`ir_tier0:false` | — | 1 min 08 s |
| 1 核，128 MiB RAM 位于 4 GiB 以上 | 约 25 min | 1 min 31 s（两种进程各 4096 页落在 4 GiB 以上）|

启动时间包含客户机真实时间等待（设备探测、initramfs 脚本），不是纯 CPU 吞吐。1 核启动的 CPU 剖析（V8 `--cpu-prof`）中，生成的页函数约占 30%，其余为入口/翻译/解释步开销；主要优化步骤与效果：

1. 首版按线性页索引、400 个函数上限：2.9 万次编译、2.3 万次淘汰（`note_entry` 在页表满时每次 O(n) 清理占 29%）。改为按后备页索引、位置无关、直接映射入口缓存、有界入口位图后：约 3.9 千次编译、0 次淘汰，1 核 5:50 → 1:18。
2. x64 物理写入只在页含编译代码时通知 JIT（无锁位图），RIP 页翻译缓存：1:18 → 1:08。
3. 新模板（CLI/STI、SWAPGS、RDTSC、DIV/IDIV 快路径、MOVS/STOS、MOV Sreg、SHLD/SHRD 立即数、CMPXCHG8B/16B）：解释步 2680 万 → 1350 万。
4. x64 profile 公布 `IA32_ARCH_CAPABILITIES`（RDCL_NO、MDS_NO、ITS_NO 等，见 X3 记录）：客户机不再启用 PTI（每次系统调用两次 CR3 切换并清空 TLB/访问缓存）、VERW 与 ITS 返回 thunk。

仍以解释步执行的主要指令：SSE/MMX（用户态字符串函数）、MOV CR3、SYSCALL/SYSRET/IRETQ、VERW 等系统指令；retpoline（Spectre v2，只能由 CPU 型号或 eIBRS 解除）使间接调用经 thunk 页往返。

## 尚未完成

- x64 区域（Tier-1/2）优化管线；本层在 `ir_tier0:false` 下同样用于长模式。
- 兼容模式（LMA=1、32 位 CS）代码的编译：需要 32 位 IR 快照读取改用 x64 四级页表规则，目前解释执行。
- SSE/x87 模板、页函数之间的直接链接、跨页指令的本地执行。
