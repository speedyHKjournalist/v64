# C2：单 socket 拓扑与真实 Linux SMP 验收

## 平台与 CPUID 契约

`src/platform.js` 保留原来的 `cores`，新增 `topology`：一个 socket、N 个 core、每 core 一个 thread、N 个 logical processor；`package_shift=ceil(log2(N))`。APIC ID 连续为 `0..N-1`。

为避免改变既有单核客户机的识别结果，`cpu_cores:1` 使用 `legacy` CPUID profile，所有既有 leaf 保持不变；`cpu_cores:2..8` 使用 `smp32` profile。`src/rust/cpu/topology.rs` 在原 CPUID 输出后覆盖以下字段：

| Leaf | 多核输出 |
| --- | --- |
| 0 | 最大 basic leaf 至少为 `0x1F`；显式 `cpuid_level<0x1F` 的多核配置会拒绝初始化 |
| 1 | EBX logical count=N、initial APIC ID=core ID，EDX.HTT=1；HTT 不等于声明每核有多个 thread |
| 4 | 保留既有 cache 容量/几何，L1 data/instruction cache 每核独享，unified L2 在 package 内共享；EAX 核数与 sharing 字段一致 |
| `0xB` / `0x1F`, subleaf 0 | SMT domain：shift=0、logical count=1、type=1、EDX=current APIC ID |
| `0xB` / `0x1F`, subleaf 1 | Core domain：shift=`ceil(log2(N))`、logical count=N、type=2 |
| `0xB` / `0x1F`, subleaf >=2 | type=0/count=0 终止；保留输入 level number 与 current APIC ID |

三个核使用 shift=2，五至八核使用 shift=3；不能直接以 N 作为 shift。所有 APIC ID 右移 package shift 后均为零。拓扑 leaf 提供 x2APIC ID 格式的编号，不据此开启 x2APIC 硬件能力。

参考：[Intel SDM，CPUID](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf)、[Linux x86 topology](https://www.kernel.org/doc/html/latest/arch/x86/topology.html)。

## 测试入口

```sh
make multicore-topology-tests
make multicore-linux-tests
# 独立运行指定矩阵并保存原始串口输出：
CPU_COUNTS=1,2,3,4,8 C2_LOG_DIR=docs/validation/platform/C2/logs node tests/smp/linux_topology.mjs
```

`topology.mjs` 在每个 1..8 核配置上逐核执行真实 CPUID 指令，逐项比较 leaf/subleaf 结果及只有 APIC ID 可以随核变化的字段；同时检查 platform、fw_cfg NB_CPUS/MAX_CPUS、CMOS additional CPUs 与 MADT processor/APIC IDs，以及 DSDT AML Processor 名称/ProcID。单核用既有值作兼容基准。

`linux_topology.mjs` 使用真实 SeaBIOS 从 `linux4.iso` 启动，不通过 host 写 AP CPU 状态或篡改固件核数。客户机需要同时满足：

1. `uname` 标明 SMP，`/sys/devices/system/cpu/online` 与配置一致。
2. 每核 sysfs `physical_package_id=0`、`core_id=CPU ID`、`thread_siblings_list=自身`、`core_siblings_list=整个 package`。
3. 启动 N 个并发 ELF32 进程，分别调用 `sched_setaffinity` 固定至对应 CPU，在计算前后通过 `getcpu` 校验绑定，在该核上完成 100000 次求和并校验结果；每核必须输出一个独立完成记录。

`affinity_probe.asm` 可由 NASM 直接生成 374 字节 ELF32，无需镜像包含 taskset、C 编译器或 libc；通过标准 host9p 文件接口传入客户机，随后由 Linux 作为正常用户进程加载。所有加载、启动和进度等待都有超时，并在失败时打印串口与每核诊断。

## 镜像选择与负向控制

| 镜像 | 观察 | 用途 |
| --- | --- | --- |
| `images/buildroot-bzimage68.bin` | Linux 6.8.12，uname 无 SMP 标记，2 核配置下只 online CPU 0；没有可读内置 IKCONFIG | 不作为 SMP 验收镜像 |
| `images/linux4.iso` | Linux 4.16.13 `#13 SMP`，32 位，真实启动两核；没有 taskset | 本 gate 的固定镜像 |
| `images/TinyCore-11.0.iso` | 解压内核 banner 为 Linux 5.4.3-tinycore SMP | 仅完成静态检查，未计入 OS gate |

在改动前的 `bb8979f3` 隔离副本上运行同一 OS 检查，两核都能运行绑定进程，但 Linux 报告两个 package（CPU 0 package=0，CPU 1 package=1，各只有一个 core）。新 gate 因 package membership 不一致失败，证明测试能够识别原有拓扑问题，不能仅凭 online 条目数通过。

镜像 SHA-256：

- linux4.iso：`a8ea434ab3b177c55f01275dcc1d35f52cfbee9bd44a32e74765c975b58bcc73`
- buildroot-bzimage68.bin：`507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c`
- TinyCore-11.0.iso：`778fc3788d9df3de72970827968b2b195aca827401db6f6f9cbdb737d4300bda`
- seabios.bin：`73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98`

## 固件范围

MADT/fw_cfg/CMOS 已使用相同的 N。仓库 `bios/seabios.config` 与 `bios/seabios-debug.config` 均禁用 `CONFIG_SMBIOS`；因此当前 bundled BIOS 不以 Type 4 宣称 N 个 socket。本 OS gate 还扫描实际客户机内存中的 SMBIOS 2.x entry；若 BIOS 生成 Type 4，必须只有一个 processor package，且 core/enabled-core/thread count 都为 N。未实现或宣称通用 SMBIOS 生成器。

## 本轮验证记录

- 独立纯 Rust helper：3 项通过（legacy 单核不变、非二次幂 shift、leaf1/cache domain 一致）。
- 当前 debug Wasm：`node tests/smp/topology.mjs` 的 1..8 核全部通过。
- 真实 Linux 1/2/3/4/8 核矩阵全部通过：一个 package、每核独立 core ID、所有核 online、每核绑定进程完成 100000 次计算。
- 实际启动矩阵使用固定 debug Wasm，SHA-256：`ddfcb05a26712ce89027e7d34ed379ef15426f136f4546cc488581f088a34a8f`，解释器、默认正常时钟、正式 `emulator.run()/stop()` 生命周期。
- 调度轮数：1 核 5115、2 核 211404、3 核 212860、4 核 217311、8 核 254402；轮数仅为运行记录，不是性能基准（单核与多核的轮次执行路径不同）。
- 五种配置扫描实际客户机内存均未发现 SMBIOS 2.x entry，符合 bundled BIOS 的禁用配置。
- 原始串口：[1 核](logs/linux4-1cpu.log)、[2 核](logs/linux4-2cpu.log)、[3 核](logs/linux4-3cpu.log)、[4 核](logs/linux4-4cpu.log)、[8 核](logs/linux4-8cpu.log)；[旧基线负向控制](logs/baseline-linux4-2cpu.log)。
- 汇总：[CPUID/固件输入测试](logs/topology.txt)、[OS 矩阵](logs/linux-matrix.txt)。

单核/多核测试不能在 stopped 状态直接循环 `cpu.run_cores()` 而绕过 MachineClock 生命周期：异步 IRQ 唤醒回调会让停止的 runner 重新执行 pause。最终 OS gate 使用公共 runner；它不通过手动修改时钟或 AP 状态维持客户机进度。

## C3 编译后端的同一 OS gate

`SMP_JIT_MODE` 可选 `tier0` 或 `region`，默认仍是 `interpreter`。编译模式显式启用 `experimental_smp_jit`；region 关闭 Tier-0 和 page mode，防止以其他 generator 的命中代替目标后端。

```sh
make multicore-linux-jit-tests
# 保存单独后端的原始串口与每核命中证据：
SMP_JIT_MODE=tier0 C2_LOG_DIR=docs/validation/platform/C2/logs/tier0 node tests/smp/linux_topology.mjs
SMP_JIT_MODE=region C2_LOG_DIR=docs/validation/platform/C2/logs/region node tests/smp/linux_topology.mjs
```

测试除原有 Linux topology/affinity 条件外，还要求每核目标 generator 的 activations/cache hits 大于零，并要求到达 shell 后运行绑定工作负载阶段仍产生每核新增命中。计数通过实际 scheduler slice 边界的只读前后差值归属，既不强制编译指定客户机地址，也不跳过客户机执行。region gate 同时断言 Tier-0 activations 为零，interpreter gate 断言两种 compiled counters 均为零。

每配置 JSON 记录 `per_core_jit`、`workload_jit`、`boot_wall_ms` 与 `total_wall_ms`。宿主耗时仅作为验收记录；本次两个后端可并行执行，不是受控性能对比。

本轮 Tier-0 与 region 的 1/2/3/4/8 核 OS 矩阵均全部通过；每核在 shell 后工作阶段的目标 generator 命中都大于零。region 的所有配置中 Tier-0 activations 均为零。

| 核数 | 全机 Tier-0 activations（Tier-0 arm） | 全机 region hits（region arm） | 工作阶段最少单核命中（Tier-0 / region） |
| --- | --- | --- | --- |
| 1 | 1310700 | 15160596 | 75165 / 180760 |
| 2 | 1621766 | 21754590 | 34545 / 391224 |
| 3 | 1843884 | 24394211 | 35353 / 344015 |
| 4 | 2069368 | 27085428 | 24954 / 338817 |
| 8 | 2626613 | 45724638 | 8633 / 234429 |

原始串口与逐核 JSON 分别在 [Tier-0 日志目录](logs/tier0/) 与 [region 日志目录](logs/region/)；完整汇总：[Tier-0](logs/tier0/matrix.txt)、[region](logs/region/matrix.txt)。三个执行模式合计完成 15 个真实 Linux 配置，使用前述同一个固定 debug Wasm。编译模式沿用正式 runner 与相同客户机工作负载；未将微测试通过当作 OS 成功的替代证据。
