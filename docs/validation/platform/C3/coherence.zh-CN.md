# C3 跨核一致性微测试

日期：2026-09-27。本门槛验证同一 Wasm 实例内的协作轮转多核，不代表宿主 Worker 并行；完整 C3 还包含独立的全机快照、OS/设备压力和故障矩阵。

## 夹具与验收

[`tests/smp/coherence.asm`](../../../../tests/smp/coherence.asm) 是真实 32 位客户机指令夹具；[`coherence.mjs`](../../../../tests/smp/coherence.mjs) 为各核设置独立保护模式入口/栈并运行正常 `run_cores()`。INIT/SIPI 由 C1 的 AP 启动夹具独立验收，此处没有声称再次通过固件启动 AP。

所有共享写入、原子事务、页表修改、SMC、IPI 和 INVLPG 均由客户机执行。DMA 变体只通过设备也使用的 `CPU.write_blob()` 物理写屏障注入一次代码修改；该变体不等于验证某个真实磁盘或网卡设备的队列协议。

每个场景同时检查：

- 各核 `LOCK XADD` 返回 ticket 的总和为 `N×iterations` 个连续整数的和；共享计数无丢失。
- 隐式锁定 `XCHG` 保护非原子计数，所有核均完成自己的工作量。
- 跨 4 KiB 边界的非对齐 `LOCK INC`、`LOCK CMPXCHG8B` 产生正确的 32/64 位结果；CMPXCHG8B 起始低位接近溢出，覆盖向非零高位的进位。
- 客户机在共享 flag 上忙等，另一核写入后能继续，覆盖跨切片的共享 load 可见性。
- core 0 将独立代码页上的函数运行至编译执行；core 1 提前缓存该物理页的另一条 4 KiB 虚拟映射，随后经别名修改函数立即数。core 0 在序列化后必须执行新指令值。
- SMC 开始前，JIT 变体必须观察到热函数已发布且被编译代码执行。Tier-0 快路径使用 `ir_t0_entries/chains` 作为执行证据；区域后端使用对应 cache record 的 hits。不会把全程解释执行写成 JIT 通过。
- core 1 修改 core 0 的 PDE 后，core 0 在未 INVLPG 时仍读到旧物理页；core 1 随后发 IPI，core 0 handler 执行 INVLPG、EOI 后再读到新物理页。
- BSP/AP 均使用独立页目录，timer/PIC 不参与夹具的 IPI 结果。

## 矩阵和结果

每种构建的完整命令是 `node tests/smp/coherence.mjs`。release 加 `TEST_RELEASE_BUILD=1`。

| 维度 | 内容 |
|---|---|
| 后端 | interpreter、Tier-0 页函数、明确关闭 page mode 的优化区域后端 |
| 主矩阵 | 2 核 × seeds 1..10 × quantum 17/257/4096 × 三种后端，共 90 场景 |
| 多核扩展 | 三种后端各 4/8 核，seed 1、quantum 257，共 6 场景 |
| 物理写屏障 | 三种后端各一次 DMA `write_blob` 修改热代码，共 3 场景 |
| 发布时序 | 两种 JIT 各一次异步 Wasm 编译/发布，其余使用同步发布，共 2 场景 |
| 合计 | 每种构建 101 场景 |

工具链、源夹具与构建产物 SHA-256 见 [manifest.json](manifest.json)。Debug 与 release 均 101/101 通过；本地日志分别为 `build/c3-coherence-debug.log`、`build/c3-coherence-release.log`。完整执行中 interpreter 没有 JIT 激活；Tier-0 和区域后端均有真实编译执行，最终 debug 日志中分别观察到 89,555 与 750,137 次激活（异步发布时序会影响计数，激活总数不是确定性输出）。

每轮按核检查执行量上界。解释器允许 `quantum+1`（STI shadow）；本夹具的两种 JIT 允许 `quantum+256`，因为它们在 block/activation 边界返回。Debug/release 最大观测 slice 均分别为 interpreter 4096、Tier-0 4251、region 4182。JIT 不承诺 exact quantum，也没有从本夹具推断所有可能直线块的普遍超额上界。

本夹具首次要求实际 JIT 激活时检出了集成缺口：SMP `run_cpu_slice` 调用了编译 scheduler 的 `visit()`，却没有给新的 Machine round 调用 `begin_frame()` 提供编译额度，导致配置显示 enabled 但全程只解释执行。现在 `begin_cpu_frame(now)` 从 `run_cores()` 每轮调用一次，并由激活断言持续保护。

## 负向控制

下面命令应非零退出；这两个变异是测试选项，不改生产代码，也不覆盖正常的 `coherence.bin`。

```sh
SMP_MUTATION=flush-on-switch SMP_SEEDS=1 SMP_QUANTUMS=257 SMP_MODES=interpreter node tests/smp/coherence.mjs
SMP_MUTATION=no-shootdown SMP_SEEDS=1 SMP_QUANTUMS=257 SMP_MODES=interpreter node tests/smp/coherence.mjs
```

两项均被检出：第一项模拟原“换核就清 TLB”的实现，尚未 shootdown 已读到新值；第二项移除 handler 的 INVLPG，IPI 后仍读到旧值。预期值分别是旧页 `A5A51111`、新页 `5A5A2222`，不会因为双方都没有缓存翻译而误通过。

## 未由本门槛证明的内容

- 跨页第二页缺页、写保护、MMIO 副作用和异常部分提交下的 LOCK/CMPXCHG8B；本夹具仅覆盖合法 RAM。
- CMPXCHG16B、x86-64、真实宿主并行和内存序 litmus 测试。
- 快照发生在未完成异步发布时的取消/epoch 验证、旧快照导入、全部设备状态恢复；由另一个 C3 状态门槛负责。
- 真实 DMA 设备队列、磁盘/网络长期压力、恶意输入、完整 load 优化差分矩阵。
- S3/S4/热插拔等未公开的平台能力。

因此这里是 C3 的最小一致性/JIT 微测试门槛，不将整个 C3 或 `R-SMP32` 标为完成。默认多核 JIT 的开放策略由主计划的完整验收决定。
