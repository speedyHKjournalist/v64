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
