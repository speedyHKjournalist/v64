# nasm 指令测试：无 gdb 宿主上的 QEMU 参考

`make nasmtests` 原本用 gdb 在 x86 Linux 上原生运行每个测试二进制，记录最终状态作参考（fixture）。macOS/arm64 宿主不能这样做，所以此前 R1 把 nasm 测试列为“需要 Linux 容器”。本记录说明新增的 QEMU 参考路径、它与硬件的已知差别，以及借此发现并修正的 v86 问题。基线：`7a281f34 + 未提交修改`（2026-09-29，用户自行提交）。

## 方法

- [`tests/nasm/create_tests.js`](../../../../tests/nasm/create_tests.js)：没有 GNU `ld`（elf_i386）时用 Rust 自带的 `rust-lld`（`-flavor gnu --image-base=0x1F000 -z max-page-size=4096 -e 0x80000`），生成与 GNU ld 相同布局的镜像。
- [`tests/nasm/gen_fixtures.js`](../../../../tests/nasm/gen_fixtures.js)：没有 gdb 或 `NASM_ORACLE=qemu` 时调用 [`qemu_oracle.js`](../../../../tests/nasm/qemu_oracle.js)。测试 ELF 转成扁平 multiboot 内核，由 `qemu-system-i386 -cpu max`（TCG）运行到最后的 HLT，经 QMP 的 `info registers` 与 `pmemsave` 取状态，异常取自 `-d int` 日志，然后按 gdb 版 fixture 的格式写出（`run.js` 两种格式都能读）。QEMU fixture 首行为 `Reference: QEMU`。
- 入口桩模拟 Linux 进程的初始 FPU/SSE 状态：CR0.MP/NE、CR4.OSFXSR/OSXMMEXCPT、FNINIT，并把 1 MiB 以上的段复制到位（避免 QEMU 加载器覆盖 BIOS 区）。
- 与硬件对齐的处理：
  - **MMX 写寄存器的指数**：硬件在 MMX 写入时把 x87 寄存器的符号/指数置为 0xFFFF，QEMU 只写低 64 位。桩在 FNINIT 前用哨兵值填满 8 个物理寄存器（FNINIT 不清内容）；测试结束后仍带哨兵指数的寄存器，尾数未变视为未写（新进程的 0），否则视为 MMX 写入（指数 0xFFFF）。标记字按 gdb 的 `i387_tag` 规则计算（空为 3）。FSAVE/FXSAVE 存到内存的哨兵也还原为 0。
  - **QEMU 10.2 的 RCL/RCR bug**：立即数计数是“操作数位宽 + 1”的非零倍数（如 `rcl byte [m], 18`）时，QEMU 把操作数清零；按 SDM，掩码后的计数 (COUNT AND 1FH) MOD 9/17 为 0，操作数与 CF 不变、OF 未定义。参考生成时，这些指令在交给 QEMU 的镜像中被替换为等长 NOP（位置取自 nasm 列表文件）。100 个 arith 测试中 72 个含此类指令，38 个因此出现差异，替换后全部一致。
- [`tests/nasm/run.js`](../../../../tests/nasm/run.js)：以 `x87_fast_math: false`（兼容模式）运行——参考值是硬件结果，而默认的 fast-math 性能策略不合成完整的 x87 异常标志。对 QEMU fixture 应用 `QEMU_DEVIATIONS` 表（见下），被规则解释的差异不算失败，但在汇总中按规则列出次数和样例。

## 结果

宿主：Apple M1 Pro，macOS，Node v25.6.0，NASM 3.01，QEMU 10.2.0。

| 运行 | 结果 | 日志 |
| --- | --- | --- |
| `node tests/nasm/run.js` | 15629/15629 通过 | [nasmtests](logs/nasmtests-qemu-2026-09-29.log) |
| `node tests/nasm/run.js --force-jit` | 15629/15629 通过 | [nasmtests-force-jit](logs/nasmtests-force-jit-qemu-2026-09-29.log) |

改进前（仅有 QEMU 路径、未处理上述差别）为 1285/15629 失败。

## QEMU 与硬件的已知差别（`QEMU_DEVIATIONS`）

| 规则 | 依据 | 适用测试数 |
| --- | --- | --- |
| x87 栈错误：v86 检测到栈下溢/上溢（FSW.SF）时不比较 st0–7 与 FSW | 硬件返回不定 NaN 并置 IE/SF；QEMU 不看标记字，用陈旧寄存器内容计算 | 920 |
| 同上情形下 FCOMI/FUCOMI 的 ZF/PF/CF | 与空寄存器比较在硬件上为“无序” | 78 |
| FCOMI/FUCOMI(P) 清 OF/SF/AF | SDM 明确清零；QEMU 保留原值 | 56 |
| BT/BTS/BTR/BTC 的 OF/SF/AF/PF | SDM：未定义 | 31 |
| MOVLPD/MOVHPD/MOVNTQ/MOVNTDQ 的寄存器形式 #UD | SDM 只定义内存形式；QEMU 执行寄存器形式 | 20 |
| 带 66 前缀的 CMPXCHG8B、F6/F7 /1（TEST 别名）可执行 | 硬件执行（原 gdb fixture 即如此）；QEMU 报 #UD | 35 |
| FSAVE/FSTENV 32 位映像保留高 16 位 | 硬件与 v86 写 0xFFFF，QEMU 写 0 | 1 |
| FYL2XP1 超出定义域时的 IE | SDM：结果未定义且不定义异常；QEMU 置 IE | 1 |
| FPREM/FPREM1 在 0/0（无效）后的 C3/C1/C0 | QEMU 清零，Bochs 与 v86 保留前值；SDM 未说明，**尚无硬件参考** | 2 |

规则只在 QEMU fixture 上生效；在 Linux + gdb 宿主上生成的 fixture 仍按原方式逐项比较。最后一条是唯一没有 SDM 或硬件依据的规则，待有 gdb fixture 时复核。

## 借此发现并修正的 v86 问题

1. **SSE 算术与开方的 NaN 依赖宿主**：解释器用 Rust/Wasm 浮点运算实现 ADD/SUB/MUL/DIV/SQRT（PS/PD/SS/SD）。Wasm 不规定 NaN 的符号与载荷，arm64 宿主给出其默认 NaN 0x7FC00000，而 x86 对无效运算返回 QNaN 不定值 0xFFC00000，有 NaN 操作数时返回第一个源操作数的 NaN（静默化）。新增 `sse_nan_f32/f64`、`sse_sqrt_f32/f64`（[`sse_instr.rs`](../../../../src/rust/cpu/sse_instr.rs)），按 SDM 4.8.3.5 与表 4-7 规则产生结果。Tier-0 与 x64 页层模板在结果为 NaN 时本来就回退到解释器，所以只需改解释器。在 x86 宿主上，V8 生成的原生 SSE 指令本身就给出 x86 的 NaN，这很可能是原 gdb fixture（在 x86 Linux 上运行）没有暴露该问题的原因。
2. **nasm 测试运行在 x87 fast-math 模式下**：默认的 `x87_fast_math` 性能策略不合成完整的 x87 异常标志（设计如此，见 `performance_recorder.js` 的说明），但 nasm 测试以硬件结果为参考，应在兼容模式下运行（如 `fdiv-zero` 的 ZE）。

## 仍需注意

- QEMU 路径依赖 `qemu-system-i386`（可用 `QEMU_I386` 指定）与 `nasm`；Linux 宿主有 gdb 时仍默认使用 gdb。
- 仅在 QEMU fixture 下，x87 栈错误类测试（920 个）只比较通用寄存器、内存、XMM、标志和异常，不比较 st/FSW。
