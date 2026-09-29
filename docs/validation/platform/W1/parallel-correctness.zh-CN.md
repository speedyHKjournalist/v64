# W1：宿主 Worker 并行的正确性

W1 让客户机的应用处理器（AP）在各自的 Worker 线程里真正并发执行，同时保持 C3/A3 已验收的全部语义。基线：`8af0560e + 未提交修改`（2026-09-28/29，用户自行提交）。并行模式目前是内部选项（`parallel: true` 强制，`"auto"` 自动选择并可回退），默认仍为轮转执行；公开配置仍只有 `cpu_cores`。

## 结构

- **机器线程**（主线程或 CPU Worker）运行 BSP（核 0，机器实例，基址 0）和所有设备；**vCPU Worker** 各运行一个 AP，实例由 [`src/parallel/relocate.js`](../../../../src/parallel/relocate.js) 重定位到同一 shared memory 中（见 [W0](../W0/context-abi.zh-CN.md)）。Worker 自己的 Wasm.Table、JIT 运行时和代码缓存互不共享函数索引。
- **控制块**（[`src/parallel/control.js`](../../../../src/parallel/control.js)，独立 SharedArrayBuffer）：STOP/RESUME/ACK 纪元的 stop-the-world、每核 I/O 请求槽、每核状态与计数、机器时钟偏移、PM timer 的共享数据。
- **I/O**：Worker 的端口与设备 MMIO 访问写入请求槽后等待，机器线程在 `run_parallel` 与主循环中服务（`machine.service()`）；Worker 为此踢醒核 0。两类端口在 Worker 本地处理：ACPI PM timer（由共享的机器时钟、PM 基址、快照连续的 timer offset 计算，并与所有线程共享一个单调最大值，[`ACPI.prototype.share_timer`](../../../../src/acpi.js)），以及只写的 POST 端口 0x80。本地 APIC 与 IOAPIC 是机器实例内存中的共享状态，IOAPIC 由自旋锁保护。
- **stop-the-world**：暂停、快照、复位、S3、上电、销毁前，机器递增 STOP 纪元并踢醒各核；各核在安全点（切片之间，或 HLT 等待中）写 ACK 后停泊，机器可读写其状态块，再以 RESUME 纪元放行并附带命令（RESET 回到等待 SIPI、RELOAD 丢弃由状态导出的缓存、FLUSH 刷新翻译）。
- **内存模型**：并行构建中每个对齐的客户机 RAM 访问都是顺序一致的 Wasm 原子操作（x86 TSO 在弱序宿主上需要有序的读和写），非对齐访问两侧加 fence；LOCK 读改写与 XCHG-mem 以 compare-exchange 提交，冲突时从保存的寄存器重新执行指令；跨页/非对齐的锁操作与 CMPXCHG16B 走全局 split lock；页表 A/D 位用原子 OR 置位。JIT（IR 区域、Tier-0、x64 页层）用同样的原子访存模板（`WasmBuilder::ATOMIC_GUEST_MEMORY`），RAM guard 同时检查对齐；锁操作由 IR lift、Tier-0 分类与页层分类拒绝，交给解释器的 CAS 路径；会缓存 RAM 不变量的 `ram_loop` pass 在 Worker 活动时禁用。
- **跨核代码一致性**（[`crate::parallel::code`](../../../../src/rust/parallel.rs)）：每个后备页一个 OWNERS 字节（每核一位）。核开始缓存某页代码时声明该页并把它放入发布环；其他核在安全点（`poll`：每次分发、CPUID、IRET、中断交付、切片开始）把该页的翻译标记为写慢路径并确认。安装代码前等待所有非空闲核确认（最多 0.5 ms，超时则放弃本次安装并计数），再次校验源字节。经慢路径写到他核所有的页时，页进入失效环，拥有者在下次 `poll` 退役代码。
- **故障**：Worker 捕获异常（含 Wasm trap）时先经 `parallel_fail` 释放本核持有的机器锁（IOAPIC、split lock、扩展 RAM 锁都记录持有者）并标记为空闲，再报告；Node 中 Worker 意外退出同样被检测。机器停止、发出 `emulator-error`，诊断给出原因，此后 `run()` 与快照都被拒绝，`destroy()` 正常清理。
- **后端选择**：`parallel: "auto"` 在宿主满足条件（SharedArrayBuffer/Atomics、shared WebAssembly.Memory、Worker、浏览器中 `crossOriginIsolated`；非确定性时钟）且 `v86-parallel.wasm` 可用时使用 Worker，否则保持所请求的核数以轮转方式运行，`get_diagnostics().execution` 给出 `{mode, fallback}`；`parallel: true` 用于测试，条件不满足时报错而不回退。
- **bundle**：`make parallel` 生成 `build/v86-parallel.wasm` 与 `build/vcpu-worker.js`；源码树下 Worker 入口由 `import.meta.url` 定位（只在 `src/parallel/entry_url.js` 中），bundle 默认使用 bundle 旁的 `vcpu-worker.js`（浏览器中相对页面为 `build/vcpu-worker.js`，可用 `vcpu_worker_url` 指定）。

## 本阶段发现并修正的问题

| 问题 | 现象 | 修正 |
| --- | --- | --- |
| 解释器内存 `BTS/BTR/BTC` 为普通读后写 | 真并发下丢失 SeaBIOS SMP 锁的释放，4 核 S3 恢复挂起 | 经 `safe_read_write8` 原子读改写 |
| 便携 TLB 带 `TLB_HAS_CODE` | 停机时差异 | 便携 TLB 去掉该位 |
| Worker 从未编译 | 循环中未调用 `begin_cpu_frame` | 每切片开始编译预算帧 |
| 并行构建的区域编译全部 `Unsupported` | 状态布局地址超过 4 MiB 的边界检查 | 原子访存构建中放宽该检查 |
| 状态块在高地址 | arm64 上生成代码的寄存器访问慢 1.4 倍 | 低地址状态槽位（W0） |
| 多核下 PAUSE 与有界 REP 结束切片 | 每个 Worker 大部分时间在循环开销里；机器线程每 256 个元素回一次事件循环，2 核内存负载比 1 核慢 12 倍 | 只有同一线程上有其他核时才让出（`yield_to_other_cores`），否则只结束当前编译块 |
| x64 CPU profile 只在附加时复制 | 测试在加载后启用 x64 时 AP 看不到长模式 | Worker 每个切片从机器实例同步 CPUID 级别与 x64 能力 |
| “未发布”计数在 0.5 ms 自旋内每次都累加 | 把正常等待误报为大量拒绝 | 只统计真正放弃的安装；分发循环中增加 `poll`，真实拒绝降到每核数十次 |
| Worker 的 PM timer 与 0x80 往返机器线程 | I/O 负载 2 核比 1 核慢 80 倍 | Worker 本地计算（见上） |
| 失败的 Worker 可能持有 IOAPIC 锁 | 机器线程在锁上永远自旋 | 锁记录持有者，失败时释放 |
| 不同宽度的锁操作作用于同一字节时不互斥（2026-09-29） | 非对齐/跨边界的锁操作与 CMPXCHG16B 在 split lock 下“读—比较—写”，而对齐的锁操作只做一次 CAS、不看 split lock：前者读后、写前被后者提交的更新丢失。新 litmus 项（跨 dword 边界的 `LOCK ADD dword` 与其中对齐的 `LOCK ADD word` 并发）在 2 核并行下 16000 次丢 25 次 | 无单一宿主原子指令可覆盖的锁操作改为“独占”执行，对齐 CAS 以“共享”方式提交（机器内存中一个计数字，最高位为独占标志），二者不再交错；CMPXCHG16B 在独占下以两次 8 字节 CAS 提交，其间对任一半的普通写入使其失败并重做而不是被覆盖；Worker 故障时一并清除独占标志。修正后 litmus 2/4/8 核 × 解释器/JIT 全部精确 |
| 图形模式下 `ImageData` 拒绝共享内存（2026-09-29） | VGA 把 wasm 内存中的像素缓冲区直接包成 `ImageData`；并行构建的内存是 SharedArrayBuffer，进入图形模式即报 “The provided Uint8ClampedArray value must not be shared”（index.html 启动 Windows 时发现；此前的浏览器测试只用文本模式） | 内存共享时 `ImageData` 使用自己的缓冲区，每次刷新前复制脏行（`VGAScreen.create_image_data`/`sync_image_data`）；新增 `tests/parallel/browser_graphics.html`（VBE 640×480×32，源码树与 bundle），去掉修正后该测试失败 |
| 代码发布等待以机器时钟计时（2026-09-29） | `wait_published` 的 0.5 ms 上限用 `microtick`（机器时钟），机器暂停（stop、快照）时它不走；此时完成的异步 IR 安装若遇到“页已不再声明但仍有 owner”（`published` 恒为假），主线程永久自旋：90 min soak 在启动后几轮卡死（客户机指令计数不变，各 Worker 停泊，主线程停在 `ir_cache_validate`；经检查器附加确认） | 等待另以检查次数（2^14 次）封顶 |

## 验证结果（2026-09-29，Apple M1 Pro 8P+2E，Node 25.6.0）

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| [`litmus.mjs`](../../../../tests/parallel/litmus.mjs)（[`litmus.asm`](../../../../tests/parallel/litmus.asm)） | 2/4/8 核 × 轮转/轮转 JIT/并行/并行 JIT，每项 5000–20000 轮：LOCK INC/XADD/CMPXCHG/CMPXCHG8B 与 XCHG、LOCK BTS/BTR 自旋锁计数精确；环形消息传递（TSO 顺序）；MFENCE 的 store buffering 从不双旧；跨核改写代码（CPUID 串行化后总见新代码）；**IPI 唤醒环**（每核在 STI;HLT 中等待定向 fixed IPI 后转发给下一核，丢失唤醒即挂起）；共享页表上的并发 A/D 位 | 全部通过 |
| [`lifecycle.mjs`](../../../../tests/parallel/lifecycle.mjs) | 运行中 300–400 次 stop/run（每次断言所有 Worker 已停泊）且结果精确；运行中快照在另一台机器恢复后精确完成；运行中 destroy 后没有 Worker 继续执行；三种故障（异常、持有 IOAPIC 与 split lock 时 trap、Worker 退出）：机器停止、`emulator-error`、锁已释放、拒绝继续运行与快照；`"auto"` 的回退与原因；`DISABLE_JIT=1` 同样通过 | 通过 |
| [`relocation.mjs`](../../../../tests/parallel/relocation.mjs) | 见 W0 | 通过 |
| [`linux_boot.mjs`](../../../../tests/parallel/linux_boot.mjs) | linux4 2/4 核启动（JIT，4 核约 5–8 s），每核执行负载；release bundle 同样通过 | 通过 |
| `PARALLEL=1 tests/smp/os_stress.mjs`（C3 OS 压力） | 4 核 × 解释器/Tier-0/区域 × 种子 1–10：fork 共享发布、信号、迁移、IDE 扇区与 NE2K 帧、整机快照回放；每个后端之后 reboot 重新上线 4 核并 S5 | 30/30 通过；改动后复测种子 1–5 共 15/15 |
| `PARALLEL=1 GUEST=linux4 tests/devices/acpi_guest.js` | 4 核 20 × S3 + 20 × S4 + reboot + S5 上电（见 [A3](../A3/sleep-hibernate.zh-CN.md)） | 通过 |
| `X64_PARALLEL=1 tests/x64/linux_boot.mjs` | Alpine 3.24 x86_64，2 核与 4 核页层：64/32 位探针、XC 矩阵、virtio-net；4 核时各 Worker 运行页函数（4.4–6.1 万次入口），真实拒绝 292–455 次 | 通过 |
| [`browser.mjs`](../../../../tests/parallel/browser.mjs) | 无头 Chrome：带 COOP/COEP 时源码树与 bundle 各以 4 个 vCPU module Worker 运行 litmus；不带时 `"auto"` 回退为 2 核轮转并给出原因 | 通过 |
| 轮转测试套件于并行构建 | 见 W0 | 11/11 通过 |
| [`soak.mjs`](../../../../tests/parallel/soak.mjs)（S3 加压） | linux4 4 核 Worker、JIT，20 min，`SOAK_SLEEP_EVERY=1`：每轮各核跑可校验的计算、管道与 tmpfs 文件校验和，同时 3 次随机 stop/run 与一次快照原地恢复，然后 S3 并由 RTC 闹钟唤醒；每轮检查内核日志（oops、soft lockup、RCU stall、hung task）、全部核在线、各核 LOC 中断递增、uptime 不倒退 | **通过**：101 轮、303 次 stop/run、101 次快照恢复、101 次 S3/RTC 唤醒、0 次挂起被中止（[日志](logs/soak-4core-s3-every-iteration-20min-2026-09-29.log)） |
| `soak.mjs`（长期，90 min，每 5 轮一次 S3） | 同上 | 见下方“长期 soak” |

## Windows 8.1 x64（宿主并行，2 核）

`WIN_PARALLEL=1 WIN_CORES=2 X64_JIT=1 tests/x64/windows_boot.mjs`（镜像只读，每次运行后核对 mtime 未变）。

| 运行 | 构建 | 结果 |
| --- | --- | --- |
| 1 | 修正混合宽度锁操作之前 | 约 8 min 到登录界面、登录成功；约 13 min 时内核在 `lock bts qword [rsi], 0`（rsi = 0x50，空指针加偏移）处写缺页，随后经 0xCF9 自动重启（蓝屏后重启）；第二次启动后 64 位与 WOW64 探针均通过（`processors=2 packages=1 cores=2 smt_cores=0 progress=128 failures=0 apic_ids=3`）。**记为未通过**：出现了轮转模式下多次运行从未出现的内核崩溃。[log](logs/windows81-2core-parallel-run1-2026-09-29.log)、[result](logs/windows81-2core-parallel-run1-2026-09-29.result.json) |
| 2 | 修正之后 | 无结论：运行到 12 min 时宿主（电池供电的笔记本）合盖睡眠约 1 h（`pmset` 日志 12:03–13:03），醒来后剩余时间不足以完成登录 |
| 3 | 修正之后 | **通过**：执行模式 `parallel`（AP 在 Worker 中，Worker 共执行 38.6 亿步），无复位；约 16 min 到登录（宿主同时运行 4 核 soak 与 poweroff 循环，负载约 40–60/10 核），64 位与 WOW64 探针均 `processors=2 packages=1 cores=2 smt_cores=0 progress=128 failures=0 apic_ids=3`，`high_block=0x7ff780ad0000`；墙钟 32 min；镜像 mtime 未变。[log](logs/windows81-2core-parallel-run3-2026-09-29.log)、[result](logs/windows81-2core-parallel-run3-2026-09-29.result.json) |

崩溃处的 `lock bts` 是 Windows 推锁（push lock）的典型获取序列，被访问对象的指针为空，符合“并发更新丢失”的表现。同期发现并修正的 CMPXCHG16B 原子性缺陷（见上表：旧实现下 CMPXCHG16B 与同一 qword 上的 8 字节锁操作互相覆盖，litmus 中 2 核丢 58/16000）与此一致——Windows x64 的互锁单链表（SList）等结构使用 CMPXCHG16B——但单次崩溃不足以证明因果：修正后完整通过的只有 1 次，4 核与更多次数的运行尚未进行。

## 长期 soak

第一次 90 min 尝试（宿主同时运行 6 进程的 nasm 测试与 X6 的 6.5 GiB Alpine，负载很高）在 3.9 min、第 5 次 S3 时停止：120 s 内没有 `acpi-wake`。当时测试只等待唤醒事件，没有记录客户机是否真的进入了 S3，而闹钟只提前 2 s 设置——宿主慢时，闹钟可能在内核完成挂起之前就触发，内核随即中止挂起（这是正确的客户机行为），测试却继续等待唤醒。原因未能从该次记录中证实。测试随后改为：闹钟提前 `SOAK_ALARM_SECONDS`（默认 5 s）；分别等待唤醒与 `echo mem` 返回，内核中止挂起时计数（上限为 S3 次数的 1/4）并记录 dmesg，进入 S3 却未唤醒时给出 ACPI 诊断与串口尾部。之后的 S3 加压运行连续 101 次 S3 无一中止或失败。

90 min 常规运行结果：（运行中，完成后补记）

## 限制

- LOCK 读改写与 XCHG-mem 在 Worker 中由解释器执行（正确，但锁密集负载扩展性差，见 W2）。
- 扩展 RAM（X6）在 Worker 活动时只走慢路径（编译代码的访问缓存不缓存其帧）。
- `cpu_worker`（整个 emulator 在一个 Worker 里）与并行模式的组合：headless Chrome 中 index.html 以 linux4 2 核验证可用（vCPU Worker 由 CPU Worker 创建，需在 Worker 中转发 `parallel`、`parallel_wasm_path` 与 `vcpu_worker_url`）；Claude 应用内置浏览器面板不允许 Worker 内以 URL 再创建 Worker，该环境中不可用。
- 并行模式与确定性时钟互斥（`cpu_clock: {mode: "deterministic"}` 时 `"auto"` 回退）。

## 复现

```sh
make parallel                          # v86-parallel.wasm + vcpu-worker.js
make multicore-parallel-tests          # 上表中 Node 部分（源码树）
make multicore-parallel-tests-release  # bundle
make multicore-parallel-browser-tests  # 需要 Chrome
X64_PARALLEL=1 X64_JIT=1 X64_CORES=4 X64_LINUX_TIMEOUT=2400000 node tests/x64/linux_boot.mjs
```
