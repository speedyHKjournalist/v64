# W0：可重定位的 CPU 实例（宿主并行的上下文 ABI）

W0 的目标是让“同一 Wasm 模块可以在两个独立状态基址上交替运行而无串扰”，为 W1 的每个 vCPU Worker 提供私有的 CPU 状态、Rust 静态数据、栈和 JIT 运行时，同时共享客户机 RAM。基线：`8af0560e + 未提交修改`（2026-09-28/29，用户自行提交）。

## 选择的方案：每实例重定位，而不是 `ctx_ptr` 参数

原计划 §3.1 第二步是把所有状态访问改成 `ctx_ptr + field_offset` 并改动每个 helper 与生成代码的签名。实现前的原型表明，稳定版 Rust 的 `wasm32-unknown-unknown` 可以用另一种方式达到同一退出条件，且不改单线程构建：

- `make build/v86-parallel.wasm`：`--features parallel`，只对 v86 自身的 crate 开启 `+atomics`（预编译的 std 保持单线程，每个实例有自己的一份），链接参数 `--import-memory --export-memory --emit-relocs --no-check-features --max-memory=4294967296 --global-base=32768`。
- [`tools/parallel_wasm.mjs`](../../../../tools/parallel_wasm.mjs) 把输出转换为 `build/v86-parallel.wasm`：导入的 memory 标记为 shared（最大 4 GiB）；每个保存静态数据地址的位置（代码中的 i32.const 和 load/store offset、数据段里的指针、数据段起址、`__stack_pointer`/`__data_end`/`__heap_base`）改写成定宽字段并列入自定义段 `v86.relocs`（第 2 版）；全零 `.bss` 段删去；链接器的 reloc/linking 段删去。
- [`src/parallel/relocate.js`](../../../../src/parallel/relocate.js) 的 `relocate(bytes, base, slot)` 把这些字段加上实例基址：每个 vCPU Worker 在同一个 shared memory 里得到新增长（因而全零）的页，放它自己的一份 Rust 静态数据、栈和堆。
- **CPU 状态块放在低地址槽位。** `global_pointers.rs` 的 98 个 `state!` 字段在并行构建里是静态数组 `STATE_BLOCK` 内的偏移。转换工具从 linking 段的符号表找到 `STATE_BLOCK` 的链接地址并写入 `v86.relocs`；`relocate` 把落在它内部的地址改写到槽位 `slot × 4096`（机器实例是 0 号槽位，因此其状态地址与 `v86.wasm` 完全相同；核 c 的 Worker 用 c 号槽位），其余地址加实例基址。原因见下文性能部分。
- Rust 侧 `crate::parallel::machine(ptr)` 把本实例的某个静态映射到机器实例（基址 0）中的同一静态（减去本实例基址），`machine_state(ptr)` 对状态块字段做同样的事（减去本实例的状态槽位）。本地 APIC、IOAPIC、INIT/SIPI/NMI 锁存、物理总线、代码页归属等机器级状态只经这两个函数访问。
- JS 侧 `CPU.state_base`（导出函数 `state_base()`，返回重定位后的槽位地址）用于所有状态视图、`save_core_state`/`load_core_state` 与诊断。

普通构建 `build/v86.wasm` 不受影响：`state!` 在非 parallel 构建中仍是固定常量地址，`crate::parallel` 的所有 helper 编译为普通访存。

## 为什么要低地址槽位（arm64 实测）

第一版把状态块留在各实例镜像内（地址约 1.8 MiB 起，Worker 的更高）。在 Apple M1 Pro 上，同一 Tier-0 页函数在并行构建里比普通构建慢 1.4 倍，剖析显示差别全部在生成代码内部。手写的 wasm 微基准给出原因：V8 在 arm64 上只有当完整地址是小常量时才把它编码进一条 `ldr/str` 的立即数；地址是大常量（0x120000）时耗时 681–776 ms，对照小常量 393–416 ms；把基址放在 local 里加小偏移同样是 688 ms（`add` + 寄存器寻址）。x86-64 宿主有 32 位位移寻址，没有这个问题。把每个实例的状态块放在 `[0, 32 KiB)` 内的槽位之后，1 核轮转下并行构建与普通构建的计算负载持平（0.67 s 对 0.66 s，见 [W2 记录](../W2/performance.zh-CN.md)）。

## 验证

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| [`tests/parallel/relocation.mjs`](../../../../tests/parallel/relocation.mjs) | 同一 shared memory 里两台独立机器：A 是基址 0 的 `v86-parallel.wasm`（槽位 0），B 是重定位到新页的实例（槽位 1）；两者交替运行 linux4 负载三轮，各自得到参考结果；B 的快照（49 MiB）在 A 运行时恢复进 B | 通过 |
| C1–C3、XC 的轮转测试套件在并行构建上（`V86_WASM=build/v86-parallel.wasm`）：`ap_startup`、`core_swap`、`apic_routing`、`lifecycle`、`scheduler`、`coherence`（101 例）、`atomic_boundaries`（三后端各 107 例）、`memory_order`（96 例）、`exception_lifecycle`、`topology`、`tests/x64/multicore.mjs` | 新 ABI 上的全部多核行为 | 11/11 通过（2026-09-29） |
| `make all`、`make all-debug` | Closure（ADVANCED/SIMPLE）编译 bundle，含 `src/parallel/*.js` 与 `build/vcpu-worker.js` | 0 error |
| API 冒烟（release bundle）：`clean-shutdown`、`reset`、`state` | 普通构建不受影响 | 通过 |

## 单线程性能门槛

W0 的门槛是“单线程下固定工作量基准相对 W0 前退化不超过 P0 阈值”。普通构建 `v86.wasm` 的生成代码与状态地址没有变化（W0 的改动在 `cfg(feature = "parallel")` 之后）；并行构建在 1 核轮转下的计算负载与普通构建持平，内存负载慢 15%（每次客户机访存都是顺序一致原子操作），这是并行构建自身的代价，不影响默认构建。

## 复现

```sh
make build/v86-parallel.wasm
node tests/parallel/relocation.mjs
for t in tests/smp/{ap_startup,core_swap,apic_routing,lifecycle,scheduler,coherence,atomic_boundaries,memory_order,exception_lifecycle,topology}.mjs tests/x64/multicore.mjs; do V86_WASM=build/v86-parallel.wasm node $t || break; done
```
