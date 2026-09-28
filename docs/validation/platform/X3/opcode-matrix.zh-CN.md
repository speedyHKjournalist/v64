# X3：长模式 opcode 执行矩阵与 CPUID profile

2026-09-28。本记录补充 [整数](integer-oracle.zh-CN.md) 与 [向量](vector-oracle.zh-CN.md) 两个 QEMU 差分：那两者比较语义，但只覆盖挑选的指令；这里在执行层面覆盖**整个**长模式 opcode 空间，检查“哪些编码执行、哪些 #UD、执行了多长”。

## 方法

[`tests/x64/opcode_matrix.mjs`](../../../../tests/x64/opcode_matrix.mjs) 读取 X1 opcode map 对照产生的 `build/x64-decode/expected.json`（349,888 行；每行的有效性由 iced-x86 1.21.0 按本 profile 公布的 CPUID 特性判定，长度取 iced-x86 的解码长度），在 v86 中以 CPL3 **逐行执行一次**：

- 代码槽为用户只读页，数据与栈为用户不可执行页，harness 与其余内存为监督页或不存在；
- 每个槽是被测指令后接 INT3，完成的指令因而报告自己的执行长度；
- 每个用例前重置 FPU/MXCSR 与 GPR；所有异常向量、SYSCALL、SYSENTER 都回到 harness 记录结果。

判定：v86 恰在 iced-x86 + profile 判为无效时产生 #UD；完成的指令消费的字节数等于 iced-x86 长度（相对分支与 INT3 本身除外）。例外表只有两类，均有 SDM 依据：UD0/UD1/UD2 总是 #UD；不具备某扩展的处理器按旧形式执行的编码（TZCNT/LZCNT 执行为 REP BSF/BSR、WBNOINVD 执行为 WBINVD、0F0D/0F18/0F19–0F1F 的 prefetch/hint 空间与 CET RDSSP 为 NOP）。

```sh
cargo test x64::decode::tests::opcode_map_corpus
CARGO_TARGET_DIR=build/x64-oracle-target cargo run --manifest-path tests/x64/oracle/Cargo.toml --release
node tests/x64/opcode_matrix.mjs        # make x64-opcode-matrix-tests
```

## 结果

debug 构建（2026-09-28）：349,888 个编码全部执行，226,392 个 #UD、84,991 个以预期长度完成，其余为预期内的其他异常（CPL3 下的特权指令 #GP、沙箱数据页 #PF、#NM 等）；**0 个不一致形式**。不一致明细（若有）写入 `build/x64-opcode-matrix/mismatches.json` 与 `mismatch-rows.json`。

该矩阵首次运行时报告了若干不一致，均已修复：

| 类别 | 修正 |
| --- | --- |
| 漏实现的有效指令 | XLAT（D7）；INT1（F1）；IRETD/IRETW（按操作数宽度弹帧）；LSS/LFS/LGS；F6/F7 /1（TEST 别名）；0F19–0F1F 全部 hint NOP；LFENCE/MFENCE/SFENCE 接受任意 r/m 低 3 位 |
| 应 #UD 却执行 | 带不匹配强制前缀的 SSE 表项；F2/F3 前缀的 RDRAND；66 0FAE /7（CLFLUSHOPT，未公布）；F2/F3 0F2B（AMD SSE4a MOVNTSD/SS）；0F01 中未定义的寄存器形式（含 XSETBV，profile 不公布 XSAVE）；MOV CR 对不存在的 CR 先 #UD 再查 CPL；0FB9/0FFF |
| 已实现但未公布 | RDTSCP 与 CLFLUSH：解释器早已实现，现在 x64 profile 中公布（CPUID 0x80000001 EDX[27]、leaf 1 EDX[19]） |

## CPUID x64 qualification profile

profile 仍只在内部开关 `set_x64_test_capabilities` 下公开，公开 CPU 继续是 legacy profile。本轮变更：

- **RDTSCP**、**CLFSH**：见上。
- **IA32_ARCH_CAPABILITIES**（CPUID.7:EDX[29]，MSR 0x10A）：报告 RDCL_NO、SKIP_L1DFL_VMENTRY、SSB_NO、MDS_NO、PSCHANGE_MC_NO、TAA_NO、SBDR_SSDP_NO、FBSDP_NO、PSDP_NO、BHI_NO、PBRSB_NO、GDS_NO、RFDS_NO、ITS_NO。仿真核心不做任何推测执行，这些“不受影响”声明是真实的。客户机因此不启用 PTI（Linux 每次系统调用两次 CR3 切换）、VERW 缓冲清除与 ITS 返回 thunk，对 X4 性能影响很大。仍不声明 eIBRS，Linux 继续使用 retpoline。`X64_ARCH_CAPABILITIES=0 tests/x64/linux_boot.mjs` 可关闭该项复现旧 profile。

## 解释器其他改动

- REP MOVS/STOS 在源和目的都是普通 RAM 时按最多 4096 字节一块批量执行（`execute::bulk_string`），每块仍是可重启边界：RCX/RSI/RDI 在块间提交，中断与故障只在块边界观察。整数 oracle 的全部 REP 用例（0 计数、前向/后向、address32、提前终止）通过。
- 整数 oracle 可用 `X64_JIT=1 X64_REPEAT=n` 把整组用例重复执行，使后续各遍由 X4 页函数执行；向量 oracle 的 `X64_JIT` 热循环同样改由页层执行。

## 范围

矩阵证明的是“有效/无效/长度”在整个 opcode 空间上与独立解码器 + CPUID profile 一致，而不是每条有效指令的语义。语义证据仍是整数（1552）与向量（958）QEMU 差分、系统用例与真实 OS。VEX/EVEX 编码全部 #UD（不公布 AVX）。
