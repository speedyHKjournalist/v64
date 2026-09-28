# X1：宽状态与共享解码证据

2026-09-27。该门槛建立 long64 执行基础，不单独声明完整 x86-64 OS 支持。

`gen/state_layout.js` 将所有新宽状态登记为 core（解码 REX 临时槽为 scratch）。GPR 是单一分 bank 状态：前 8 寄存器保留原低 DWORD 地址，新高 DWORD bank 与 R8–R15 低 DWORD bank 组成 16×64 位。16/8 位写保留其余位；Long64 的 32 位写清高 DWORD。16 个 XMM、宽 RIP/CR/DR、描述符表与段基址、EFER/STAR/LSTAR/CSTAR/SFMASK/KERNEL_GS_BASE/SYSENTER 高位、PAT、TSC_AUX纳入生成布局；原 JIT 低地址 ABI 不移动。新增 core payload 424 bytes，总计 1568 bytes/core。快照版本转换由 `cpu.js` 的 v2/importer 单独测试。

`state::{GuestIp,LinearAddress,PhysicalAddress,HostOffset}` 显式区分地址域。7 种模式独立建模；EFER.LMA、CS.L、CS.D、CR0.PE、VM 决定 live mode。X2 负责检查非法控制转换。

`decode_with` 接受按需取指闭包，解释器 runtime 与编译快照可共用；不访问数据内存。支持 REX 顺序、REX 后 legacy prefix 失效、AH 与 SPL 字节别名、R8–R15、16/32/64 地址、SIB、RIP-relative、moffs、imm64 与 sign-extended imm32、64 位默认栈宽、15 字节限制以及 #UD/取指 fault 的顺序。既有生成 encoding catalog 保持单一 opcode 来源；不支持的 opcode 显式返回错误。

验证：

```sh
cargo test x64::
CARGO_TARGET_DIR=build/x64-oracle-target cargo run --manifest-path tests/x64/oracle/Cargo.toml --release
node gen/state_layout.js --check
```

- 独立 iced-x86 1.21.0 Rust oracle：33,088 个 mode/66/67/REX/全 ModRM/SIB MOV 行，比较长度、操作数宽、寄存器、寻址基址/索引/scale、默认段和完整有效偏移，全部通过。
- 独立 oracle 曾抓出 R12/R13 错当默认 SS；已改为 DS，只有 RSP/RBP 默认 SS。该差异会影响非 canonical 地址的 #GP/#SS 选择，不能仅凭偏移值测试代替。
- 纯单测覆盖全部 7 modes、32 位清高规则、16/8 位别名、布局不重叠、canonical 边界、前缀顺序、imm64/sign-extension、跨页取指 fault、15-byte 超长与非法 LOCK 不投机读取位移/操作数。

范围限制：当前独立 corpus 广泛覆盖 MOV 地址形式，其他 opcode 的 mode/立即数规则由定向单测验证；它不是整个 opcode 集的独立语义 oracle。X3/X4/X5/XC 分别需要执行、编译、平台与 OS 门槛，不能因本记录而勾选。

架构依据：[Intel SDM Volume 1](https://cdrdv2-public.intel.com/874241/253665-090-sdm-vol-1.pdf) 的 64 位寄存器与零扩展规则，以及 [Volume 2A](https://cdrdv2-public.intel.com/858446/253666-088-sdm-vol-2a.pdf) 的 REX、地址与各指令编码。独立实现：[iced-x86 1.21.0](https://github.com/icedland/iced/releases/tag/v1.21.0)。

## 2026-09-28 续：整个长模式 opcode map 的独立对照

上文 MOV corpus 只覆盖地址形式。现在 `cargo test x64::decode::tests::opcode_map_corpus` 生成整个长模式 opcode 空间：一字节表（除前缀与 0F）、0F、0F38、0F3A 各 256 项 × 11 组前缀（无、66、F2、F3、REX.W、66+REX.W、67、F3+REX.W、REX.B、REX.R、LOCK）× ModRM.reg 0–7 × 4 种 r/m（寄存器、SIB [rsp]、RIP+disp32、SIB+disp8），共 **349,888 行**，写入 `build/x64-decode/opcodes.json`。独立 oracle（`tests/x64/oracle`，iced-x86 1.21.0）逐行比较“是否有效”和指令长度，有效性按 v86 x64 qualification profile 公布的 CPUID 特性过滤（`advertised()`：FPU、MMX、SSE–SSE3、CX8/CX16、CMOV、POPCNT、RDRAND、SYSCALL、RDTSCP、CLFSH、CET_IBT 的 ENDBR 等）。

```sh
cargo test x64::decode::tests::opcode_map_corpus
CARGO_TARGET_DIR=build/x64-oracle-target cargo run --manifest-path tests/x64/oracle/Cargo.toml --release
```

结果：123,947 行在 iced-x86 与该 profile 下有效，v86 解码器对每一行给出相同的有效性和长度；另有 173,771 行是未定义或未公布的 opcode，共享解码器照常给出长度，交由执行器报告 #UD（这一点由 X3 的 opcode 执行矩阵在 CPL3 下逐行验证）。oracle 同时写出 `build/x64-decode/expected.json` 供 X3 矩阵使用。

该对照发现并修正的解码缺陷：

- 0F0D、0F1A、0F1B（hint NOP 空间）、0FB9（UD1）、0FFF（UD0）缺少 ModRM，长度少算。
- 带不匹配强制前缀的 SSE 表项（0F10–17、0F28–2F、0F50–7F、0FC2–C6、0FD0–FE、0FAE 中未定义的 66/F2/F3 组合）必须是 #UD，而旧 catalog 按无前缀形式执行；现由 `mandatory_prefix_map` 统一判定。

范围：本对照验证解码层面的有效性与长度，不验证语义；语义由 X3 的 QEMU 差分与执行矩阵负责。VEX/EVEX（C4/C5/62）编码在本 profile 中不公布 AVX，均按 #UD 对照。
