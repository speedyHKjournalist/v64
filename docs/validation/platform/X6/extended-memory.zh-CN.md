# X6：超过 wasm32 后备的 RAM 容量（扩展 RAM）

X5 的 RAM 全部位于 wasm32 memory 内（`memory_size` 上限约 2 GiB，其中一部分可经 `high_memory_size` 重映射到 4 GiB 以上）。X6 增加“扩展 RAM”：在客户机物理地址 `4 GiB + high_memory_size` 之后再提供 `extended_memory_size` 字节，后备不在 wasm memory 里，因此总量不受 wasm32 限制（受 36 位物理地址与宿主可分配内存限制）。基线：`8af0560e + 未提交修改`（2026-09-29，用户自行提交）。

## 方案评估（计划 X6 第一项）

- **Memory64 / 多 memory**：Rust 的 `wasm32-unknown-unknown` 与 v86 的全部 helper、TLB、JIT 都以单个 32 位 memory 中的宿主指针为前提；改为 Memory64 需要整个 CPU 核心换目标，多 memory 则要求 Rust 侧每次 RAM 访问都经额外的 wasm helper。两者都是全局重写，且 Safari 等目标浏览器对 Memory64 的支持仍不一致，本轮不采用。
- **驻留帧缓存（采用）**：扩展 RAM 的页保存在宿主存储（JS 的 ArrayBuffer；有 SharedArrayBuffer 时用它，以便 vCPU Worker 共享），CPU 在 wasm 堆中的帧池里缓存 4 KiB 页；物理总线把该范围解码为第三种类型 `WindowKind::Extended`。对 CPU、JIT、快照与设备都只是物理总线的一个新区域，不改变低 RAM 的任何快路径。

## 设计

- **配置**：`extended_memory_size`（2 MiB 的倍数），`extended_memory_cache`（帧池大小，默认 512 MiB，≥ 1 MiB）。客户机物理区间 `[4 GiB + high_memory_size, … + extended_memory_size)`，与 X5 的重映射 RAM 连续；CMOS 0x5B–0x5D 报告 4 GiB 以上的 RAM 总量（改为三字节全部写入，以支持 ≥ 4 GiB），SeaBIOS 据此生成 E820；multiboot 内存图同样报告 64 位长度。超出 36 位物理地址或宿主无法分配时在启动前报错。
- **存储与帧**（[`src/extended_memory.js`](../../../../src/extended_memory.js)、[`src/rust/x64/extended.rs`](../../../../src/rust/x64/extended.rs)）：页按 1 GiB 分块存放；“touched” 位图记录写过的页，上电清零与快照只处理这些页。帧池按 FIFO 队列加“第二次机会”（clock 的环形队列形式，容量固定、Worker 中不分配内存）换出：未用帧优先，被引用过的帧清除引用位后重新排队，被固定或 CACHED 的帧跳过；脏帧写回存储（`extended_store`），缺页时读入（`extended_load`）。
- **访问路径**：
  - 解释器与 helper：`physical::read*/write*` 对扩展区直接调用 `extended::read/write`（窗口搜索之前短路），每次访问都查帧，因此帧可以在任意一次这种访问时被换出。
  - x64 页层编译代码的访问缓存（jac）：`x64_page_access` 在轮转模式下可以把扩展页映射到其帧（`cache_frame`），这样 OS 自己放在扩展 RAM 里的数据（例如 Linux 自顶向下分配的 `struct page` 数组）也能按内存速度访问。这种帧标记为 CACHED，执行中从不被换出；CACHED 超过帧池一半或无帧可换时，下一个安全点（无编译代码活动：单核的 `do_many_cycles_native` 与多核轮转的 `run_cpu_slice` 每次分发之前）使所有核的访问缓存失效并清除标记。写入项在建立时就把帧记为脏。宿主（DMA、快照）访问前 pin 住帧；无帧可换时一次访问经单独的 bounce 帧完成。
  - 代码：扩展页从不作为 RAM 页交给编译器（`ram_page` 拒绝），其中的代码总是解释执行；x64 取指经物理总线。
  - 兼容模式（32 位 helper 使用 32 位总线地址）：扩展页经每核 32 个槽位的“孔径”（`0xFED00000` 起 1 MiB，平台保留、PCI 窗口之外）映射到 32 位总线的 mapped 路径，按 FIFO 复用，一条指令涉及的页保持各自的槽位；在长模式之外，或作为客户机物理地址直接访问时，孔径是空洞（open bus / 未映射），不会暴露扩展页。
  - LOCK 读改写：x64 路径中操作数在扩展 RAM 时，指令从读操作数到提交一直持有扩展 RAM 的（可重入）锁，因此在 Worker 并发下对其他核的所有扩展访问原子。
  - 宿主并行（W1）：模块状态经 `machine()` 共享，一个可重入锁串行化；Worker 的导入函数使用同一组共享存储；编译代码的访问缓存不缓存扩展帧（无法在一个安全点撤销所有 Worker 的缓存）。
- **快照**：V7 流在 RAM 记录之后追加 kind 3 记录（非零扩展页），位图在状态 `state[99]`，页数在 manifest；恢复前与本机的扩展 RAM 大小核对（`state[98]`）。V6 单缓冲格式在扩展 RAM 有数据时拒绝保存（需使用 `save_state_stream`）。
- **生命周期**：暖复位保留扩展 RAM；ACPI S4/S5 之后的上电与低 RAM 一样清零。

## 验证

### 合成 fixture：[`tests/x64/extended_memory.mjs`](../../../../tests/x64/extended_memory.mjs)

64 MiB RAM（16 MiB 重映射到 4 GiB），**6 GiB 扩展 RAM，帧池只有 4 MiB**（1024 帧，几乎每次访问都换页）。长模式客户机：

1. 每 64 KiB 写一个与地址相关的 qword，覆盖全部 6 GiB，再全部校验；
2. 32 MiB 连续区写入 `i × K` 并校验（反复换出/换入），`REP MOVSQ` 在扩展 RAM 内复制 1 MiB、再复制 8 KiB 到低 RAM；
3. 把代码复制到扩展 RAM 并调用；
4. 把 PML4/PDPT/PD 复制到扩展 RAM、改为互相指向后切换 CR3，经它们访问新页，核对扩展 RAM 中 PD 项的 A/D 位；
5. 兼容模式：32 位代码段在线性 1 GiB（映射到扩展 RAM）执行，读写、`LOCK ADD`、`REP MOVSD` 都在扩展 RAM（经孔径）；
6. 宿主以 DMA 写入一个扩展 RAM 块，客户机求和；客户机写一块，宿主读取。

宿主再抽样核对内容，然后 V7 快照流（424 MiB）恢复进另一台同配置机器后再次核对。解释器与页层的结果逐字节一致（页层 pass 中 jac 直接命中帧，helper 命中从 864 万次降到 27 万次；21 万次换出，10.6 万次写回）。

### 真实 OS：Alpine x86_64 + 6 GiB 扩展 RAM

`X64_EXTENDED_MEMORY=6442450944 X64_LINUX_MEMTEST=5120 X64_JIT=1 X64_CORES=2 tests/x64/linux_boot.mjs`：512 MiB RAM + 6 GiB 扩展 RAM（共 6.5 GiB，默认 512 MiB 帧池；`X64_EXTENDED_CACHE` 可改）。客户机 `/proc/iomem` 必须报告 `100000000-27fffffff : System RAM`；探针 `linux_probe64 memtest 5120` 以 64 MiB 为单位映射 5 GiB 匿名内存，每页写入两个与地址相关的字并全部校验，经 `/proc/self/pagemap` 统计位于扩展 RAM 的页数（必须超过四分之一）；随后照常运行 64/32 位探针与 XC 矩阵。

结果：**通过**，见下方“运行记录”。

## 限制

- 扩展 RAM 中的代码只解释执行；兼容模式对扩展 RAM 的访问经孔径，比 RAM 慢。
- 宿主并行模式下扩展 RAM 只走慢路径。
- 仅长模式可寻址扩展 RAM；32 位 PAE 客户机沿用 X5 的限制（旧路径不支持 4 GiB 以上的页表项）。
- 浏览器能否分配所需的 ArrayBuffer 取决于宿主；分配失败在启动前报错，不把“不能分配”解释为架构不支持。

## 复现

```sh
node tests/x64/extended_memory.mjs                      # EXTENDED_GIB=6（默认）
X64_CORES=2 node tests/x64/extended_memory.mjs          # 多核轮转的分发循环
TEST_RELEASE_BUILD=1 X64_JIT=1 X64_CORES=2 X64_EXTENDED_MEMORY=6442450944 X64_LINUX_MEMTEST=5120 \
    X64_LINUX_TIMEOUT=10800000 node tests/x64/linux_boot.mjs
```

## 运行记录

### 2026-09-29：多核轮转下帧池“卡死”（已修正）

第一次 6.5 GiB Alpine 运行（2 核轮转、页层）在 `memtest` 期间近乎停滞：帧池（当时 512 MiB，131072 帧）装满后 `evictions` 始终为 0，每次访问都走 bounce 帧（35 min 内 bounce 11 亿次，串口不再增长）。新增诊断字段（`x64_ext_stat` 10–13：排队帧、计为 CACHED 的帧、实际带 CACHED 标记的帧、被固定的帧）用 32 MiB 帧池 2 分钟内复现：排队 0、CACHED 8192/8192、释放 0 次。原因是多核轮转执行走 `run_cpu_slice`，它的分发循环没有调用 `extended::safe_point()`（只有单核的 `do_many_cycles_native` 有），页层访问缓存持有的帧因此从不释放，最终所有帧都被标为 CACHED、无帧可换。修正：`run_cpu_slice` 每次分发前同样经过安全点。回归：合成 fixture 增加 2 核运行（`make extended-memory-tests` 两次运行），并断言页层轮次发生过释放、bounce 访问少于载入的 1/10；去掉修正后该断言失败（页层轮次只换出 23 次、bounce 885 万次）。

| 运行 | 结果 | 日志 |
| --- | --- | --- |
| fixture，1 核 | 通过：解释器 / 页层各换出 212522 次、bounce 0，页层释放 296 次；快照流 424 MiB 恢复 | [log](logs/extended-memory-fixture-1c-2026-09-29.log) |
| fixture，2 核轮转 | 通过：页层释放 296 次、bounce 0，页层与解释器结果逐字节一致 | [log](logs/extended-memory-fixture-2c-2026-09-29.log) |
| Alpine 3.24 x86_64，2 核页层，512 MiB RAM + 6 GiB 扩展 RAM（512 MiB 帧池） | **通过**：`/proc/iomem` 报告 `100000000-27fffffff : System RAM`，`MemTotal: 6578636 kB`；`X64_MEMTEST mib=5120 pages=1310720 errors=0 extended_pages=1310720`（5 GiB 全部落在扩展 RAM）；64/32 位探针、XC 矩阵与 virtio-net 通过；扩展 RAM 统计：载入 270 万页、写回 137 万页、换出 257 万次、释放 21 次、bounce 0；墙钟约 22.5 min（宿主同时运行 3 个其他长测试） | [串口](logs/alpine-2core-extended-6gib-2026-09-29.serial)、[result](logs/alpine-2core-extended-6gib-2026-09-29.result.json) |

退出条件（6–8 GiB 实际配置、跨低/高 RAM 写入校验、高地址代码执行、I/O 与快照恢复）：合成 fixture 覆盖代码执行与快照恢复，真实 OS 覆盖 6.5 GiB 的写入校验与 I/O；真实 OS 上的整机快照在该配置下未单独运行。

