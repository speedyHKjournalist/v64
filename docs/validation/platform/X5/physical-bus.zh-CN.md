# X5：36 位物理总线与 VirtIO DMA 进展

本记录只覆盖物理总线基础与 VirtIO 传输层，不表示 x64 OS、所有设备、固件内存图和完整快照验收已经完成。实际 RAM 容量仍受 wasm32 后备存储限制；高窗口是已有 RAM 的重映射，不增加容量。

## 物理总线

`src/rust/x64/physical.rs` 将 36 位客户物理地址与旧 32 位 RAM/MMIO 后备地址分开。最多 16 个页对齐窗口，RAM 窗口必须映射现有 RAM，不能覆盖 VGA 洞，不能与另一 RAM 窗口重复占用后备区域；迁走的原低物理范围在新总线中成为洞。MMIO 窗口显式译码到旧设备地址，不改变设备 DMA 地址宽度。

8/16/32/64 位读写先验证完整范围，再执行后备访问。跨窗口访问允许逐字节译码，绝不把高地址截成低 DWORD；36 位边界溢出和未映射高地址返回错误。16 字节 `probe` 为 SIMD/原子写的提交前检查提供无副作用入口。所有写入使用原 RAM/MMIO helper，继承代码页失效通知。

`PageTables` 实现公共 walker 接口：运行时使用总线读写，编译快照 `peek64` 在执行任何后备读之前拒绝 MMIO。代码页见证包含完整客户物理页、实际后备页、窗口 generation；缓存同时须记录后备页的 SMC 依赖，不能仅用高客户物理页监听旧失效通知。

窗口变更只允许机器安全点：清各核 TLB 和共享编译代码，递增不会回绕的 generation。恢复窗口重新验证完整集合并分配新 generation，不能把快照中的旧 epoch 当成当前有效期。`x64_phys_resolve/read8/read16/read32/write8/write16/write32/probe` 给 JS 提供可区分地址错误与 `0xFFFFFFFF` 数据的接口。

验证：`cargo test x64::` 的 24 个基础测试中，物理总线 9 个测试通过；单独 `cargo test x64::physical::tests` 亦为 9 通过。覆盖 RAM 重映射低洞、36 位/整数溢出、4 GiB 边界、跨窗口、MMIO 别名、映射更新原子性、generation、防止 16 字节写第二半失效、代码页见证。测试是纯译码单测，真实 CPU/设备集成需另外执行。

## VirtIO 传输层

`src/virtio.js` 现在保留 desc/avail/used 六个原始 DWORD，支持高低字任意写入顺序，完整地址用于访问。即使写入超过 JS 精确整数范围的 64 位值，寄存器读回和快照仍保存原始 DWORD；启用队列时拒绝超出 36 位或未映射范围，不会别名到低 RAM。队列启用后地址写入不再修改活动队列。

主描述符表、间接表、数据 buffer 和 used/avail ring 均使用 CPU 统一物理方法。描述符长度按无符号 DWORD 读取；非法范围或间接描述符循环进入 `DEVICE_NEEDS_RESET`，无效链不会发布 used completion。新快照附加原始地址字；旧快照的有符号 32 位地址按无符号地址恢复。

可重跑测试：

```sh
node tests/smp/virtio_high_dma.mjs
```

该测试使用稀疏 36 位总线 fixture，直接执行真实 VirtIO 类和 capability 读写处理。5 组通过：高 direct ring/分段 blob/used completion/低 DWORD 哨兵不变；高 indirect table/混合低高 payload/36 位末字节；高地址快照和 reset/旧 signed32 快照；非法高 DWORD 精确读回并拒绝；越界 DMA/未映射范围/间接循环不完成请求。fixture 不提供旧 32 位访问方法，因此传输层残留旧 helper 会直接失败。

真实 Wasm 集成测试 `node tests/smp/physical_bus.mjs` 在 2026-09-27 debug 构建中 7 组通过：

- 高 RAM 重映射低洞、跨窗口、blob 全范围提交前检查、36 位边界。
- 高 MMIO 经完整 32 位设备 callback 访问；无效第二半不产生第一半 MMIO 副作用；跨 4 GiB 的 MMIO/RAM 混合标量读写。
- 真实 PCI I/O 寄存器配置高 VirtIO ring、间接表、payload，used completion 正确且同低 DWORD 哨兵不变。
- 8237 DMA 正常双向传输、低洞拒绝、32 位地址上限，以及异步数据返回前发生 RAM 重映射时重新拒绝访问。
- IDE PRDT 全段预检、低洞和 32 位边界；后段无效时前段 RAM 不变；ATA DMA 写盘/读回、ATAPI DMA、设备 BM error/ATA abort。
- VirtIO balloon free-page hint 使用高 descriptor 地址清零，仅改变正确后备 RAM。
- 16 个物理窗口的事务恢复：无效集合不改变任何映射或 generation；合法集合一次提交并刷新 generation。

全部改动 JS 与上述测试通过仓库 ESLint。原始输出保存在 [VirtIO fixture](logs/virtio-high-dma-2026-09-27.txt)、[真实物理总线 fixture](logs/physical-bus-debug-2026-09-27.txt)。随后完整机器窗口/TLB 快照 3 组测试也通过，见 [TLB 快照记录](tlb-snapshot.zh-CN.md)。仍需 release 配对构建、高地址代码/页表/SMC 和 OS DMA 回归；不能把这些直接总线调用测试当作 x64 OS 验收。

## 设备地址审计待完成项

| 路径 | 当前地址协议 | 剩余工作 |
| --- | --- | --- |
| 通用 VirtIO | 64 位 ring/descriptor，当前总线支持 36 位 | 已接物理总线，真实高地址窗口测试通过 |
| VirtIO balloon free-page hint | descriptor 地址继承 VirtIO 64 位 | 已使用完整地址分块物理清零，真实高地址测试通过 |
| 8237 DMA (`src/dma.js`) | 保留通道地址寄存器限制 | 已接物理总线，保留 32 位上限；低洞/异步重映射拒绝测试通过 |
| IDE bus-master PRDT (`src/ide.js`) | 32 位 PRDT 和 buffer 地址 | 全 PRDT 先验证再传输，失败触发设备错误；ATA/ATAPI 和边界测试通过 |
| v86gl PCI (`src/v86gl_pci.js`) | 64 位 descriptor/arena 地址，经 36 位物理总线（2026-09-28） | 已完成，见文末 |

32 位 DMA 设备应保留真实地址上限，但仍要经过物理译码，避免重映射后的低洞继续访问原后备 RAM。不要将所有设备强制扩宽为 64 位，也不要忽略设备提供的高位。

## 2026-09-27 续：固件/OS 可见的 4 GiB 以上 RAM

新增测试配置 `high_memory_size`（字节，1 MiB 的倍数；`v86.d.ts` 标为 testing option）。初始化时把后备 RAM 顶部这一段经物理窗口 0 重映射到客户机物理 4 GiB，低地址 RAM 在 `memory_size - high_memory_size` 处结束，原低地址范围成为空洞；总容量不变，仍受 wasm32 限制，不涉及 X6。固件接口与 QEMU 相同：CMOS 0x30/0x31、0x34/0x35 只报告低 RAM，0x5B–0x5D 报告 4 GiB 以上的 64 KiB 块数，SeaBIOS 1.16.2 据此生成 `[4 GiB, 4 GiB + size)` 的 E820 RAM 项；`FW_CFG_RAM_SIZE` 仍为总量。multiboot 内存图排除低位空洞并追加 4 GiB 处的 RAM 项。快照恢复后从恢复的窗口 0 重新得出低 RAM 边界。低 RAM 必须至少 32 MiB 并容纳 initrd（固定装载于 64 MiB），否则启动前拒绝。

[`tests/x64/high_memory.mjs`](../../../../tests/x64/high_memory.mjs)：64 MiB 中 16 MiB 上移，客户机自建页表映射 4 GiB，写入首尾与中间 qword、把一段代码复制到 4 GiB + 1 MiB 并在那里执行（返回值即自身 RIP `0x100100000`），宿主确认这些字节落在后备 RAM 的 [48 MiB, 64 MiB)；multiboot 图为 `[0,640K) [768K,48M) [4G,+16M)`，没有任何低 RAM 项覆盖空洞。

真实 OS 由 `X64_HIGH_MEMORY=<字节> node tests/x64/linux_boot.mjs` 验证（512 MiB 中 128 MiB 上移）：要求 `/proc/iomem` 出现 `100000000-107ffffff : System RAM`，且 64 位与 32 位兼容探针各自 16 MiB 触碰页中有帧号 ≥ 4 GiB 的页（`/proc/self/pagemap`），内容逐页校验。独立 QEMU（`max-ram-below-4g`）同配置下两种进程的 4096 页全部位于 4 GiB 以上。v86 结果见 [XC 记录](../XC/linux64-boot.zh-CN.md)。

## 2026-09-28 续：4 GiB 以上的页表、热代码与 SMC

[`high_memory.mjs`](../../../../tests/x64/high_memory.mjs) 新增第二阶段，并在解释器与 X4 页层（`disable_jit: false`）下各跑一遍，两次结果逐字节一致：

- 把 PML4/PDPT/PD 复制到 4 GiB + 2 MiB 并改写其中的链接，`MOV CR3` 指向 `0x100200000`（CR3 与全部页表都在重映射的高 RAM 中）；
- 一个热函数复制到 4 GiB + 1 MiB 并调用 4000 次（页层把它编译成页函数，统计要求 >30,000 条原生退休），随后经 4 GiB 映射改写该函数的立即数，再调用一次必须得到新结果，且页函数被这次写入退役。

此阶段在页层下暴露一个缺陷：`jac::ram_backing` 用“低地址总线是否映射”判断后备页，把重映射到 4 GiB 以上 RAM 的后备（在低总线上是空洞）当成不可直接访问，结果高 RAM 上的代码从不编译、页函数对高 RAM 的访问全走慢路径。现只排除 VGA 窗口（0xA0000–0xC0000）的后备，其余一律以 `physical::ram_page` 的结果为准。

真实 OS：`X64_JIT=1 X64_HIGH_MEMORY=$((128<<20)) node tests/x64/linux_boot.mjs` 在页层下同样通过（64/32 位探针各 4096 页落在 4 GiB 以上），见 [XC 记录](../XC/linux64-boot.zh-CN.md)。

仍未完成：~~v86gl PCI 的高地址协议~~、~~快照分块~~（均于 2026-09-28 完成，见下）。

## 2026-09-28 续二：v86gl 高地址、IDE 48 位寻址

**v86gl PCI**。此前协议只收低 DWORD，arena/描述符读写直接用后备 RAM 的 DataView（等于把客户机物理地址当作后备偏移）。现改为：

- 描述符、请求、arena 地址都是 64 位客户机物理地址；`valid_range` 要求范围是 36 位总线上的普通 RAM（`x64_phys_kind` 逐页为 RAM；不是 VGA/ROM 窗口、MMIO，也不是 RAM 上移到 4 GiB 以上后留下的低地址空洞），并由 `validate_physical_range` 检查 36 位上限；
- 读取经 `read_blob_physical`，回复与写回经 `write_blob_physical`（继承代码页失效通知）；arena 在后备中物理连续时（`x64_phys_resolve` 逐页核对）才零拷贝使用后备视图，否则逐段经总线复制。

[`tests/glbridge/virtio_v86gl_high_test.js`](../../../../tests/glbridge/virtio_v86gl_high_test.js)（`make test-glbridge` 自动收集）：64 MiB 中 16 MiB 上移到 4 GiB；arena 放在 4 GiB 处被接受，提交与写回经物理总线完成；落在低地址空洞（48 MiB）的 arena 被拒绝。原有 `virtio_v86gl_test.js` 同样通过。

**IDE 48 位寻址**（按 [ATA-6] 审计大小/偏移计算中的有符号位运算，Windows 镜像为 50 GB，已超出 2^31 与 2^32 字节）：

- `get_lba48` 原先丢弃 LBA 的 32–47 位（源码注释承认），超过 2^32 扇区（2 TiB）的盘会读错位置；现按 HOB 字节算术合成 48 位 LBA；字节偏移 `lba * sector_size` 本来就是浮点乘法，不受影响。
- 设备控制寄存器的 HOB 位（bit 7）原先不影响寄存器读取，READ NATIVE MAX ADDRESS EXT 的 24–47 位客户机无法读到；现在 HOB=1 时 Sector Count/LBA Low/Mid/High 读出先前写入的高字节，该命令也填入 24–47 位。
- IDENTIFY 字 60–61（28 位命令可寻址总数）原先是扇区数低 32 位，现在上限为 0x0FFFFFFF；字 100–103 原先只填 100–101，现在填满 48 位。
- 扇区数/柱面数的整数判断改用 `Number.isInteger`（原 `x | 0` 在 2^31 扇区以上会误报）。

[`tests/devices/ide_large_disk.js`](../../../../tests/devices/ide_large_disk.js)（`make devices-test`）用一个不分配内存、读出内容即自身字节偏移的 3 TiB（0x1_8000_0000 扇区）盘，直接访问端口：IDENTIFY 字 60–61 与 100–103、HOB 读出的 NATIVE MAX、以及 LBA 0x1_2345_6789、0xFFFF_FFFF、0x1_0000_0000、最后一个扇区的 READ SECTORS EXT 都落在正确字节偏移。修正前的 release 构建在第一个断言处失败（字 60–61 为 0x8000_0000）。50 GB 的 Windows 镜像（1.02 亿扇区）不触及这些边界，修正前后均可正常读取。


**分块快照**。V7 快照流（`save_state_stream`/`restore_state_stream`，Worker 传输同样有背压）此前只有单元测试（`tests/smp/state_stream.mjs`，未接入 Makefile），真实 OS 快照仍用 V6 单缓冲。现把该单元测试加入 `make multicore-coherence-tests`（及 `-release`），并让 `linux_boot.mjs` 的 `X64_LINUX_SNAPSHOT` 各轮交替使用 V7（写入文件、从文件读回，写/读都按 ≤1 MiB 的块）与 V6。2 核页层 x86_64 Linux 在探针运行中完成两次 V7 与一次 V6 快照往返后全部通过，见 [XC 记录](../XC/linux64-boot.zh-CN.md)。V6 `save_state()` 仍保留（兼容旧快照），它会构造整份缓冲。
