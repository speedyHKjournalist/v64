# X2 长模式系统状态与异常验证

2026-09-27，当前工作树；尚未代表完整 X2 或 x64 OS 验收。

`node tests/x64/system_oracle.mjs` 使用 NASM multiboot 平坦镜像，由 guest 自行建立四级页表、开启 PAE/LME/PG，并跳转到 `0xFFFF800000...`。不从宿主注入长模式寄存器。

通过 33 个（本轮扩充后为 46 个，见文末）独立 QEMU TCG / v86 系统用例，逐字段比较结果缓冲：64 位 GDTR/IDTR/TSS、FS/GS/KERNEL_GS_BASE、SWAPGS、TSC_AUX、PAT、#GP/#PF/#UD/#DE、非法/忙 TSS、同级中断完整栈帧、IST 切栈及 IRETQ、SYSCALL，以及 CPL3 IRETQ→SYSCALL→SYSRETQ→SYSCALL 往返。另覆盖 RETFQ→compat32→RETF32→long64、兼容模式 SYSENTER 高 RIP、调试寄存器/GD/TF、FS/GS 栈、LAR/LSL/VERR/VERW、NX/CR0.WP、跨页写入提交边界和 INVLPG 前的陈旧 TLB。

另有 7 个真实 v86 guest 用例以 Intel SDM 明确断言向量/错误码：非规范 LSTAR、CR3 的超物理位、LMA 下清 PAE、PG 下切换 LME、64 位 CS 下清 PG、非规范 SS 寻址、36 位物理地址保留位页故障。它们不计入 QEMU 差分数。QEMU 10.2 的控制寄存器/MSR helper 对其中若干非法写入未实现同样异常，不能作为此处的参考结果；其非规范 SS 访问结果也与本 profile 的 #SS 契约不同。QEMU 的保留位页故障返回 error=8，而 Intel Vol.3A §4.7 要求 RSVD=1 时 P=1（error=9），因此该项明确使用 SDM 断言。

参考：[Intel SDM Vol.2B](https://cdrdv2-public.intel.com/782151/253667-sdm-vol-2b.pdf)、[Intel SDM Vol.3A](https://cdrdv2-public.intel.com/819714/253668-sdm-vol-3a.pdf)、[QEMU 10.2 misc_helper.c](https://github.com/qemu/qemu/blob/v10.2.0/target/i386/tcg/system/misc_helper.c)。

原始 guest、QEMU/v86 结果保存在 `build/x64-system/` 与 `build/x64-system-control-faults/`。独立 runner 固定 QEMU 为 Intel vendor、36 物理位，禁用 LA57/1GiB 页以匹配本 profile。

## 2026-09-27 续：远转移与调用门

此前 64 位模式下 `FF /3`、`FF /5`（间接远 CALL/JMP）未实现，统一 #UD。现按 SDM Vol.2A JMP/CALL 与 Vol.3A §5.8.3 实现：m16:16/32/64（默认 32 位，REX.W 为 64 位）；目标为代码段时按一致/非一致规则检查 CPL/RPL/DPL，允许转入兼容模式代码（偏移受段界限约束）或 64 位代码（偏移须规范）；目标为 16 字节 64 位调用门时检查门 DPL、GDT 界限覆盖第二个 8 字节、上半类型字段为 0、目标必须是 64 位代码段，CALL 可经门进入更高特权级：从 64 位 TSS 取 RSPn，SS 置为 RPL=新 CPL 的空选择子，依次压入旧 SS、RSP、CS、RIP（调用门不做 16 字节对齐）。任务门/TSS 选择子在 IA-32e 模式下 #GP。全部检查和栈探测先于第一处架构修改。

新增 12 个 QEMU 差分用例（现共 46 个）：远 JMP m16:32 进入兼容模式再 RETF 回 64 位、m16:64 远 CALL + RETFQ、m16:32 远 CALL 压入 32 位 CS:EIP、CPL3 经 64 位调用门进入 CPL0（核对压入的 SS/RSP/CS、切换后的 RSP 与空 SS）、同特权级调用门保持当前栈，以及 TSS 选择子、数据段、空选择子、寄存器形式（#UD）、CPL0 跳 DPL3 代码、调用门指向 32 位代码、调用门超出 GDT 界限。另有一例只按 SDM 断言：非规范 64 位远 CALL 目标为 #GP(0) 且 RSP 不变——QEMU 10.2 的 lcall helper 在抛出 #GP 前已把 RSP 下移了压栈的 16 字节，与 Vol.3A §6.5 "故障恢复到指令执行前状态" 不符。

编写用例时注意：NASM 在 64 位代码中 `jmp far [mem]` 默认生成 REX.W（m16:64），需用 `jmp far dword`/`qword` 显式指定。

仍需完成：完整权限/跨页异常优先级矩阵、调试异常的剩余组合。长模式真实 OS 与兼容进程已在 XC 记录中通过（1 核解释器）。CPUID 仍只在内部 qualification 开关下公开 LM 能力。

## 2026-09-28 续：异常优先级、#DF 与离开长模式

QEMU 差分用例由 46 个增至 **61 个**，SDM 断言由 7 个增至 **14 个**（11 个控制写入/模式/SYSRET、3 个数据断点）。新增用例：

- 离开长模式：经兼容模式代码清 CR0.PG、清 EFER.LME，回到 32 位保护模式后重新开启分页和 LME 并回到 64 位高 RIP（完整往返）。
- 异常优先级：MOVAPS 未对齐 #GP 先于缺页；CR4.OSFXSR=0 时 SSE 指令 #UD 先于 CR0.TS 的 #NM；OSFXSR=1 + TS 为 #NM；x87 在 TS 下 #NM，WAIT 仅在 CR0.MP 时 #NM；跨页读在第二页产生 #PF 且 CR2 为第二页；PUSH 跨入不存在页时 RSP 不变；取指跨入不存在页的 #PF。
- 调试：代码断点先于取指缺页（SDM Vol.3A 表 6-2 优先级 7 在 8 之前）；MOV SS 使单步陷阱延迟一条指令；产生故障的指令不触发单步陷阱；单步与数据断点在同一个 #DB 中同时报告 BS 与 B0（SDM 断言，QEMU 在高线性地址的数据观察点上不再到达结果标记）。
- #DF：交付 #PF 时再次缺页（栈不存在）成为 #DF，经 IST1 切栈交付，错误码 0。
- NMI 阻塞：经 ICR 向自身发 NMI；处理程序内再发一次，第二个 NMI 在处理程序中保持挂起，IRETQ 后才交付（共 2 次、处理程序内观察到 1 次）。
- CR8：`MOV CR8` 写入后 APIC TPR 为 CR8<<4；经 MMIO 写 TPR=0x3F 后读 CR8 得 3。另以 SDM 断言：CR8 保留位（bit 4 及以上）写入 #GP（QEMU 10.2 不检查）。
- SYSRET 返回兼容模式：不带 REX.W 的 SYSRET 以 CS=STAR[63:48]|3、SS=+8 进入 CPL3 兼容模式，EIP 取 ECX（RCX 高位垃圾被忽略），RFLAGS 取自 R11；兼容模式下 0x40 是 INC EAX（64 位下是 REX 前缀），再经 SYSENTER 回到 64 位内核。
- SYSRETQ 到非规范 RIP：Intel 在离开 ring 0 前 #GP(0)，CS 与 RSP 不变（SDM 断言；QEMU 10.2 按 AMD 行为先返回 CPL3 再在 RSP0 栈上交付 #GP）。
- 兼容模式 SYSCALL：Intel 下 CS.L=0 时 #UD（SDM 断言；QEMU 10.2 TCG 只检查 EFER.LMA，会从 CSTAR 进入）。此用例在 debug 构建中暴露宿主 panic：兼容模式代码由 legacy 解释器执行，其 0F05/0F07 走“未定义指令”路径并触发 debug 断言；现在两者在非 64 位模式下直接 #UD（这是 Intel 的架构结果，不是缺失的指令）。

实际修正：读 CR8 原先返回上次写入 CR8 的副本，经 APIC MMIO 改写的 TPR 不可见；现从 APIC TPR[7:4] 读取（SDM Vol.3A §10.8.6.1）。代码断点匹配前不应先翻译取指地址（旧实现让取指 #PF 抢在代码断点之前）；MOV CR 对不存在的控制寄存器先 #UD 再检查 CPL；IRETD/IRETW 按操作数宽度弹出帧；INT1（F1）；LSS/LFS/LGS；0F00/0F01 中未定义的寄存器形式 #UD。

`X64_JIT=1`（长模式代码由 X4 页层执行）以及再加 `X64_IR_TIER0=0` 时，全部用例同样通过（`make x64-page-tier-tests`）。

仍未覆盖：长模式三重故障（QEMU 在 `-no-reboot` 下直接退出，无法作参考）、完整权限矩阵、SMM、VMX。
