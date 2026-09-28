# X3：整数解释器与独立客户机 oracle

`src/rust/x64/execute.rs` 使用 X1 单一架构 bank 与 shared decoder，X2 memory fault 返回值。访存成功后才提交 GPR、FLAGS、RIP；RMW 先整操作数验证写权限；CMPXCHG8B/16B 失败比较保留必需内存 writeback；原子操作内部没有 scheduler yield。REP 每次执行一个可重启元素，只有最后一个元素退休整条指令，已提交元素计入独立 ledger。

整数实现范围包括：MOV/扩展/LEA/16 GPR 字节别名、ALU/ADC/SBB/比较/标志、位操作、旋转和移位、SHLD/SHRD、MUL/IMUL/DIV/IDIV、条件跳转/CMOV/SETcc/LOOP、栈/CALL/RET/ENTER/LEAVE、字符串、XCHG/XADD/CMPXCHG/CMPXCHG8B/CMPXCHG16B。系统指令交由 `system::execute`，向量/FPU 由专门 helper 接入；未实现 opcode 返回 #UD，不伪装成已退休的空操作。

验证命令：

```sh
cargo test x64::
node tests/x64/integer_oracle.mjs
X64_CORES=2 node tests/x64/integer_oracle.mjs
TEST_RELEASE_BUILD=1 node tests/x64/integer_oracle.mjs
```

`tests/x64/integer_oracle.mjs` 用 NASM 生成同一 multiboot 客户机，真实执行 CR4.PAE、CR3、EFER.LME、CR0.PG、far jump，进入 Long64 后跳到 `0xFFFF800000...` 高 RIP。QEMU TCG 独立执行，通过 QMP `pmemsave` 提取输出；v86 不注入 CPU 寄存器/模式，执行同一二进制并逐项比较 6 个完整 GPR、明确标志位与 16-byte 内存输出。当前 corpus 为 1540 cases，包含 8/16/32/64 位边界、全部条件码、AH/REX 顺序、address32 截断、RIP relative、FS/GS 高基址、负数及双宽乘除、REP 0-count/forward/backward/address32/early comparison termination、64 位原子及 CX16 成功/失败。未定义 FLAGS 不纳入比较。

独立测试实际发现并修正的差异：

- 默认段寻址 R12/R13 使用 DS，仅 RSP/RBP 默认 SS（X1 decoder oracle）。
- legacy PG=0 时设置 CR3/CR4 不应提前按 legacy PAE 读取 PML4 为 PDPTE（root CPU integration）。
- prefix catalog 的 `F3A5` 需还原为基 opcode A5 再执行 REP MOVSQ。
- false CMOV r32 仍清目的高 32 位；失败 CMPXCHG r32 则不写目的，保留目的高 32 位。
- ROL8/16 的 masked count 为完整宽度时数据不变，但 CF 仍取结果低位。
- SHLD/SHRD r32 count=0 也会清目的高 32 位。
- ALU 内部 FLAGS 提交不能借用旧 POPF privilege filter；raw commit 与 POPF 的 CPL/IOPL/RF/VM/VIF/VIP 规则已分开。

纯测试另外穷举 655,360 组 8-bit ADD/ADC/SUB/SBB/CMP 输入，检查数值、CF、OF；覆盖 8/16/32/64 移位全部 count byte、POPF privilege masks 和模式/宽状态边界。

2026-09-27 19:23 debug Wasm：1 / 2 / 4 / 8 核配置均通过全部 1540 cases（此 fixture 仅 BSP 执行，AP 未 SIPI；多核配置用于覆盖 cooperative scheduler 路径，不能作为 AP 同时执行 wide code 的证据）。QEMU 10.2.0 TCG、NASM 3.01。artifact hashes 见 `integer-oracle-manifest.json`。Release 待统一构建后复验。本记录不代替 X3 的系统/异常/向量/FPU 完整 gate，更不代替 X4 编译和 XC OS qualification。

后续普通编译器/启动路径指令补充：MOVNTI 32/64、PREFETCHT0/T1/T2/NTA/W 对 noncanonical 地址的无 fault hint，以真实 guest 加入同一独立 QEMU 对照。debug 19:51 产物上全部 **1547** 个 case 通过。PREFETCHW 的共享旧 catalog 未标记 ModRM，因此 wide decoder 显式消费完整 ModRM/SIB/位移，并有独立长度测试；不会把后续位移误执行为 opcode。

在 debug 19:56 产物上进一步加入 RDRAND16/32/64 的 FLAGS/宽度执行，以及无 CET 时 ENDBR32/64 的 NOP 语义，全部 **1552** 个真实 guest case 通过；随机数值不与独立随机源比较，读取后用不修改 FLAGS 的 MOV 清除目标，仅比较架构 FLAGS 和未受影响状态。

2026-09-28：`X64_JIT=1` 时整组 1552 个用例重复执行 `X64_REPEAT`（默认 10）遍，后续各遍由 X4 页层的页函数执行（本轮 317 万条原生退休、63 次编译、6,427 次解释步），结果仍与 QEMU 逐字段一致。REP MOVS/STOS 改为按页批量执行后（见 [opcode 矩阵记录](opcode-matrix.zh-CN.md)），全部 REP 用例在两种模式下通过。
