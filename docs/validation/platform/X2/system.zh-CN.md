# X2 长模式系统状态与异常验证

2026-09-27，当前工作树；尚未代表完整 X2 或 x64 OS 验收。

`node tests/x64/system_oracle.mjs` 使用 NASM multiboot 平坦镜像，由 guest 自行建立四级页表、开启 PAE/LME/PG，并跳转到 `0xFFFF800000...`。不从宿主注入长模式寄存器。

通过 33 个独立 QEMU TCG / v86 系统用例，逐字段比较结果缓冲：64 位 GDTR/IDTR/TSS、FS/GS/KERNEL_GS_BASE、SWAPGS、TSC_AUX、PAT、#GP/#PF/#UD/#DE、非法/忙 TSS、同级中断完整栈帧、IST 切栈及 IRETQ、SYSCALL，以及 CPL3 IRETQ→SYSCALL→SYSRETQ→SYSCALL 往返。另覆盖 RETFQ→compat32→RETF32→long64、兼容模式 SYSENTER 高 RIP、调试寄存器/GD/TF、FS/GS 栈、LAR/LSL/VERR/VERW、NX/CR0.WP、跨页写入提交边界和 INVLPG 前的陈旧 TLB。

另有 7 个真实 v86 guest 用例以 Intel SDM 明确断言向量/错误码：非规范 LSTAR、CR3 的超物理位、LMA 下清 PAE、PG 下切换 LME、64 位 CS 下清 PG、非规范 SS 寻址、36 位物理地址保留位页故障。它们不计入 QEMU 差分数。QEMU 10.2 的控制寄存器/MSR helper 对其中若干非法写入未实现同样异常，不能作为此处的参考结果；其非规范 SS 访问结果也与本 profile 的 #SS 契约不同。QEMU 的保留位页故障返回 error=8，而 Intel Vol.3A §4.7 要求 RSVD=1 时 P=1（error=9），因此该项明确使用 SDM 断言。

参考：[Intel SDM Vol.2B](https://cdrdv2-public.intel.com/782151/253667-sdm-vol-2b.pdf)、[Intel SDM Vol.3A](https://cdrdv2-public.intel.com/819714/253668-sdm-vol-3a.pdf)、[QEMU 10.2 misc_helper.c](https://github.com/qemu/qemu/blob/v10.2.0/target/i386/tcg/system/misc_helper.c)。

原始 guest、QEMU/v86 结果保存在 `build/x64-system/` 与 `build/x64-system-control-faults/`。独立 runner 固定 QEMU 为 Intel vendor、36 物理位，禁用 LA57/1GiB 页以匹配本 profile。

仍需完成：完整权限/跨页异常优先级矩阵、兼容模式系统路径、调试异常、长模式任务与远转移边界、真实 64 位 OS 和兼容进程。CPUID 尚未公开 LM 能力。
