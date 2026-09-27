# C3 Linux SMP 与设备、生命周期压力

入口是 [`tests/smp/os_stress.mjs`](../../../../tests/smp/os_stress.mjs)，客户机程序为 [`os_stress_guest.c`](../../../../tests/smp/os_stress_guest.c)。它启动仓库的 `images/linux4.iso`（32 位 SMP Linux），经 SeaBIOS/INIT/SIPI/Linux 正常启动所有 AP，不写客户机上下文或替换内核调度器。

客户机测试程序用 Clang 编译并用 Rust 工具链自带的 LLD 链接为静态 i386 ELF，不需要客户机 libc、编译器、网络服务或联网。以下负载在同一个进程组中交错执行：

- `fork` 出其余工作进程，在 `MAP_SHARED` 区域使用普通 x86 loads/stores 发布 `(sequence, payload, inverse)`，消费者校验后确认。每轮的每个进程都必须完成指定次数；共享进度用 `LOCK INC` 计数。
- 所有进程每 8 轮通过 `sched_setaffinity` 迁移到不同核心，每一轮由 `getcpu` 验证实际执行位置。`cpu_checks` 统计逐轮校验次数；它不把对相同核心重设 affinity 的调用错误计为一次实际迁移。每个核心每轮都必须有一个有效位置校验。
- 消费者向父进程发送 `SIGUSR1`，父进程通过 `SA_SIGINFO` handler 和 `rt_sigreturn` 返回中断现场。标准信号可以合并，因而验证实际收到且工作未损坏，不错误要求发送次数等于接收次数。
- 使用独立的 4 MiB 零填充 IDE 磁盘。在 `1 MiB + (seed & 31) * 8192` 的偏移以 `O_DIRECT` 写入/读取对齐的 4096 字节，逐字节核对固定种子生成的内容。`fsync` 和 host IDE 读写事件共同确认没有把 guest 页缓存命中算作磁盘 I/O。
- 使用 NE2K 的 Linux `AF_PACKET/SOCK_RAW` 驱动发送 EtherType `0x88B5` 的帧。测试 host 只在 `net0-send` 端收到完整 Ethernet 帧后经 `net0-receive` 回送，客户机核对有效载荷。该回环确实经过 NE2K 的寄存器、内存环及 IRQ，不使用 9p 文件传递代替网卡 I/O。

`9p` 仅负责将测试可执行文件复制进 guest。磁盘介质完全由测试新建，不写用户镜像；网络没有外部服务器依赖。

每种后端在首次 workload 的负载中执行 stop/save/resume/restore。stop 后验证所有核心和虚拟时钟冻结；恢复后重新完成同一个 guest 工作，发布、迁移、磁盘、网络的结果必须相同。非确定性合并信号数不参与逐字节相等比较。矩阵结束后通过公开 `restart` 重启整机，再检查全部核心在线，并由 Linux `poweroff -f` 走 ACPI S5，验证机器停止且时钟暂停。

验收矩阵：4 核，interpreter/Tier-0/region，10 个 seeds，quantum 257/4096，每场景每进程 256 轮。所有 JIT 场景逐核记录 workload 期间实际编译代码激活，防止以纯解释执行冒充后端验收。完整命令：

```sh
C3_LOG_DIR=build/c3-os-debug node tests/smp/os_stress.mjs
TEST_RELEASE_BUILD=1 C3_LOG_DIR=build/c3-os-release node tests/smp/os_stress.mjs
```

`SMP_MODES`、`SMP_SEEDS`、`SMP_QUANTUMS`、`SMP_ROUNDS`、`CPU_CORES` 可缩小排错场景或延长单次负载。`C3_BOOT_CACHE` 是 fixture 开发时可选的启动快照缓存，不应在新构建的完整验收中使用。输出 JSON 保存镜像/客户机 SHA-256、种子、量子、逐核激活和设备字节数，serial 日志保留实际 guest 结果。

本门槛与 [`coherence.zh-CN.md`](coherence.zh-CN.md) 的原子/TLB/SMC 微矩阵、[`lifecycle.zh-CN.md`](lifecycle.zh-CN.md) 的 pending IRQ、HLT、REP 精确状态回放互补。它不代替 S3（依赖 A3）、x86-64/XC、宿主 Worker 并发或 Windows 镜像验收。

## 负向控制与帧边界

`SMP_OS_MUTATION=network-corruption` 会只修改回送帧中一个有效载荷字节。已验证客户机立即报告 `C3_FAIL network payload`，harness 非零退出；该变异不改生产代码。

Linux4/NE2K 组合在 64 字节 raw frame 的尾部额外传送 14 字节，发送/接收记录中观察到 78 字节；这不是吞掉错误长度断言。测试的自定义 EtherType 消息携带明确的 50 字节有效载荷长度，核对整个消息（帧前 64 字节）并允许链路尾部填充。负向控制确认有效载荷损坏仍会失败；harness 记录实际帧长度以保持该现象可见。

## 实际检出的整机复位缺陷

第一次完整运行的 60 个工作负载场景均通过，但 region 后端最后一次 `restart` 卡在 Linux 的 LAPIC/PIT 校准：BSP 在比较一个初值为 `-1` 的计数器是否大于 100 的循环里，AP 仍停在 SeaBIOS，LAPIC 的 IRR 和 ISR 同为 vector 48。该失败可缩小为单个 seed 10、quantum 4096 的负载后重启。

失败快照恢复后禁止 JIT 再运行 30 秒仍不前进；保持 region 执行，仅向 LAPIC 发一次 EOI，就在约 12.7 秒继续启动 Linux 并上线所有 AP。根因是整机 reset 没有清空共享 IOAPIC 的旧重定向/PIC 状态，上一轮 OS 的 IRQ0 路由能在新内核安装处理程序前提前产生中断，留下无法完成的 in-service vector。修复为仅在整机 reset 时重置 PIC/IOAPIC；AP INIT 不重置其他核心共享的控制器。

修复后，固定 JS bundle 和 debug/release Wasm 均通过各自完整 60 场景、6 次负载快照重放、三个后端的重启/S5。固定产物用于避免并行开发生成状态布局时，一个测试进程无意混用不同版本 JS/Wasm。原始失败日志与快照保留在 `build/c3-os-debug.log`、`build/c3-os-region-repro/`；禁 JIT/EOI 的对照记录是 `build/c3-os-recovery-interpreter.log` 和 `build/c3-os-recovery-eoi.log`。失败快照碰到开发期间的 schema 版本标记竞态，诊断使用的副本只修正 schema/ranges 元数据，原始 RAM/设备字节保持原样；这不是对旧快照兼容性的验收。

## 本次验收结果

2026-09-27 的可核对结果在 [`os-stress-manifest.json`](os-stress-manifest.json)，含固定 JS/Wasm、Linux 介质、guest ELF、初始磁盘和原始 JSON 的 SHA-256。每行均通过 20 个场景及 2 次快照回放，完成 22,528 次实际 CPU 位置校验、704 次 NE2K 回环、2.75 MiB IDE 读取及同量写入，并通过整机重启后 4 核上线和 ACPI S5。

| 构建 | 后端 | 含启动/重启的时间 | workload 编译代码激活 |
| --- | --- | ---: | ---: |
| debug | interpreter | 162.299 秒 | 0 |
| debug | Tier-0 | 64.213 秒 | 8,218,436 |
| debug | region | 154.933 秒 | 55,577,188 |
| release | interpreter | 214.485 秒 | 0 |
| release | Tier-0 | 66.461 秒 | 8,120,148 |
| release | region | 110.409 秒 | 57,859,706 |

这些运行与其他开发任务同机并行，时间只用于说明压力持续量，不作为性能比较。两构建合计 120 个场景、12 次回放、135,168 次 CPU 位置校验、4,224 次网络回环，以及各 16.5 MiB 的实际磁盘读写。所有 JIT 场景均逐核证明确实进入对应后端；这是一轮完整压力矩阵，不把它描述为持续数小时的 soak test。
