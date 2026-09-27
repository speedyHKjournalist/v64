# XC：真实 x86_64 Linux 启动链路与多核集成

`tests/x64/linux_boot.mjs` 下载并校验官方 Alpine virt 3.24.0 x86_64 ISO，提取原始 `vmlinuz-virt` 和 `initramfs-virt`，通过 Linux boot protocol、SeaBIOS 和原始 ISO 启动。测试不写 CPU 上下文，不修改 kernel/initrd，也不把 synthetic guest 通过视作 OS 已通过。

来源：[官方 ISO](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.0-x86_64.iso) 与 [官方 SHA-256](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.0-x86_64.iso.sha256)。固定 SHA-256：

- ISO：`6cd1a38ae05cf96a5d0cbb2ddd6c630834babfeca1ecc5d1f05ec0b06b886102`
- kernel：`1e6bf9027720c75c3ed0d79171f21b5791ee40ca9795d07c7c6e04dc5ea2ae90`（Linux 6.18.35-0-virt）
- initrd：`e7f4d0ab8a434f70317392610303c2dfac59bd66c4452a8b80024d83beac3802`

内部 qualification 开关 `set_x64_test_capabilities(bool)` 在每个新 Wasm machine 默认关闭；测试显式启用后，仅在既有 32 位 profile 上添加 CMPXCHG16B、SYSCALL、NX、LM、LAHF/SAHF 和 48 位线性/36 位物理地址报告。没有新增公开 `cpu_profile` / `cpu_execution` 配置，没有宣告未实现的 AVX/XSAVE/BMI/LA57/1GiB page。

## 用户态探针

[`linux_probe.c`](../../../../tests/x64/linux_probe.c) 是无 libc 的单一源码，分别编译为 x86_64 与 i386 静态 ELF（clang + Rust 自带 `rust-lld`，与 C3 的 i386 压力程序同一工具链）。两者打包为 ustar 镜像挂在 IDE 主盘上，登录后由客户机 shell `tar -xf /dev/sda` 解出执行，因此：

- 64 位进程经 `SYSCALL`，32 位进程经 vDSO `__kernel_vsyscall`（Intel profile 下为兼容模式 `SYSENTER`，由内核经 SYSRETL/IRET 返回），两者结果与 `int 0x80` 交叉比对；
- `uname`、`sched_getaffinity` 得到的 CPU 数必须等于配置核数；
- `mmap` + `mprotect(PROT_READ)` 后写入，SIGSEGV 处理程序看到精确的故障地址并恢复写权限，故障 store 重新执行后可见；
- `fork` + `pipe` + `wait4`（子进程 pid 与退出码 7）；
- 每个在线 CPU 一个 `CLONE_THREAD` 线程，`sched_setaffinity` 绑核后 `getcpu` 必须一致，各做 20000 次 `LOCK ADD`，总数必须精确；
- 跨核 TLB shootdown：各线程在自己的 CPU 上持续读取同一页，主线程用 `MAP_FIXED` 换成新页并写入新值；`mmap` 返回后任何 CPU 都不得再读到旧页（`tlb_stale=0`）；
- tmpfs 文件写、读、校验、删除；
- 16 MiB 触碰页的物理位置：经 `/proc/self/pagemap` 统计帧号 ≥ 4 GiB 的页数（`high_pages`），同时校验内容。

同一套探针先在独立 QEMU 10.2 TCG（`qemu64,phys-bits=36,-pdpe1gb`）上跑通 1/2/4 核与高位内存配置，作为探针本身的参考；v86 结果只与这些架构后置条件比较，不与 QEMU 输出逐字节比较。

## 2026-09-27 本轮修复

首次运行时内核在 130 s 处 `Oops: invalid opcode`（`ioread32_rep` 中的 `rep insd`，`kworker exited with irqs disabled`），此前 ATAPI IDENTIFY 已超时。根因：`device_raise_irq`、PIC 端口写和 LAPIC/IOAPIC MMIO 写都会同步调用 `handle_irqs()`。32 位解释器在设备回调前已推进 EIP，而宽解释器只在最后一次访存成功后才提交 RIP；于是 IDE 数据口读取中途拉起的 IRQ 在指令中途交付，返回地址是本指令起点，随后 `write_rip(next)` 覆盖了处理程序 RIP，留下 IF=0 和一个游离的中断帧。修复：宽指令执行期间延迟外部中断交付（`execution::set_irq_deferral`），指令提交或故障后在边界处统一 `handle_irqs()`。32 位路径保持原有即时交付，不改变其延迟特性。

[`irq_boundary.mjs`](../../../../tests/x64/irq_boundary.mjs) 按 SDM Vol.3A §6.6 断言：8042 在 `OUT` 内拉起 IRQ1、以及 `OUT` 解除 PIC 屏蔽使挂起 IRQ 生效，两种情况下处理程序各执行一次、看到的返回 RIP 是下一条指令、IRETQ 后 RSP 与 IF 恢复。去掉延迟的负向控制会失败（RSP 相差 40 字节，正好一个泄漏的中断帧）。修复后 CD-ROM 正常识别（`ata2.00: ATAPI: v86 ATAPI CD-ROM`），内核在约 94 s（客户机时间）运行 `/init`。

多核下另发现宽解释器缺少 legacy 解释器已有的 `PAUSE`（`F3 90`）让出：自旋等待锁或 IPI 应答的核会用满整个 quantum。已补上：核数大于 1 时 `PAUSE` 结束当前核的切片。

宽解释器吞吐（debug Wasm，同一 NASM 长模式热循环，含内存/栈操作）从 1.78 提升到 12.6 MIPS，纯寄存器循环约 14 MIPS：

- 物理总线：低于首个重映射 RAM 字节且不在 VGA 洞内的访问直接读写后备，不再对每个字节扫描 16 个窗口（原占 45% 时间）；`ram_page`、`resolve_backing` 同样短路；
- `preflight` 按页整体探测，不再逐字节 `probe`；返回两页区间而不是 16 项地址数组；
- 取指：每条指令只翻译一次 RIP 所在页；
- 宽 TLB：读/写/取指三种访问的同一页不再落入同一直接映射槽互相驱逐；
- 解码缓存：以完整 RIP、物理地址和执行模式为键，每次命中都重新翻译 RIP 并逐字节比较当前代码字节，SMC/DMA/重映射只会造成未命中。

`X64_JIT=1` 的原生寄存器块路径由每条指令线性扫描 1024 项改为按 RIP 直接映射（token 自带槽号），入口校验只由 guard 执行，6.1 → 8.7 MIPS。原生块仍只覆盖寄存器指令，整体仍慢于解释器；这是 X4 需要解决的问题，不据此宣称 x64 JIT 加速。

## 结果

| 配置 | 结果 | 证据 |
| --- | --- | --- |
| 1 核，解释器 | **通过**：登录 root shell，`uname -m` = `x86_64`；64 位与 32 位兼容探针全部通过（此次运行的探针尚无 TLB/vDSO/pagemap 项，单核下前两者无意义） | [串口](logs/alpine-1core-interpreter-probes-2026-09-27.serial)、[result](logs/alpine-1core-interpreter-probes-2026-09-27.result.json) |
| 1 核，解释器，512 MiB 中 128 MiB 位于 4 GiB 以上（X5） | **通过**：`/proc/iomem` 含 `100000000-107ffffff : System RAM`；64 位（`SYSCALL`）与 32 位（vDSO `SYSENTER`）探针各自 4096 个触碰页的物理帧全部 ≥ 4 GiB 且内容正确 | [串口](logs/alpine-1core-interpreter-high-memory-2026-09-27.serial)、[result](logs/alpine-1core-interpreter-high-memory-2026-09-27.result.json)、[QEMU 参考](logs/qemu-1core-high-memory-reference-2026-09-27.serial) |

（多核与 JIT 配置的结果见下文补充。）

合成 fixture：[`multicore.mjs`](../../../../tests/x64/multicore.mjs) 的四核长模式 guest 在原有 INIT/SIPI、状态/TLB 隔离、CX16、XMM8–15 与快照重放之外，新增 IPI 阶段——每核以 UC 2 MiB 页映射本地 APIC，BSP 建 64 位 IDT 后依次向各 AP 发定向 fixed IPI（vector 0x41）和 NMI，再发 all-excluding-self 广播；AP 以 IF=1 停在 HLT。断言每个 AP 恰好 2 次 fixed、1 次 NMI，NMI 帧中的返回 RIP 是该核自身高位别名下的空闲循环，BSP 未收到任何一次。解释器、Tier-0、region 各 4 组（种子 1/7，quantum 17/257）全部通过，快照恢复后的重放结果逐字节一致。

## 复现

```sh
make x64-guest-tests                       # QEMU 参考 + v86 1 核
make x64-multicore-guest-tests             # QEMU 4 核参考 + v86 2/4 核
X64_CORES=4 node tests/x64/linux_boot.mjs  # 单独配置
X64_HIGH_MEMORY=$((128<<20)) node tests/x64/linux_boot.mjs
X64_LINUX_QEMU=1 node tests/x64/linux_boot.mjs   # 独立参考
```

每个配置的产物按 `<后端>-<核数>c[-high]` 命名：`build/x64-linux/image-*.json`（镜像/探针哈希与命令行）、`result-*.json`（通过或失败、完整 RIP/EFER/GPR/只读页表解析的指令字节/机器诊断）及串口记录。
