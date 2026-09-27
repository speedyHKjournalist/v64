# x64 TLB 可移植快照

`src/rust/x64/paging.rs` 为每核 256 项直接映射 TLB 增加可移植格式。只导出当前 epoch 的有效项，不导出 host 指针、Rust 内存布局或 epoch 本身。恢复完整保留 stale translation；页表已经改变而尚未执行 INVLPG 的映射，在快照恢复后仍按已缓存映射访问。恢复不会重走页表、修改 A/D 位或借机清空 TLB。

每条记录固定 18 个无符号 DWORD，低字在前：

| DWORD | 字段 |
| --- | --- |
| 0–1 | 完整 linear page（线性地址右移 12 位） |
| 2–3 | 完整 CR3 tag |
| 4 | access 0/1/2（read/write/execute），bit 2 user，bit 3 CR0.WP，bit 4 EFER.NXE |
| 5–6 | Translation 的完整物理地址 |
| 7 | page shift，12 或 21 |
| 8 | bit 0 writable、bit 1 user、bit 2 executable、bit 3 global |
| 9 | 有效页表 witness 数量，4 KiB 页为 4，2 MiB 页为 3 |
| 10–17 | 四个完整物理页表 entry 地址（每项低/高 DWORD），未使用项必须为零 |

恢复前先验证全部记录：总数、canonical 线性页、36 位 CR3/物理地址、控制码和权限、页大小与 witness 数量、页表项 8 字节对齐、大页子页偏移，以及直接映射槽是否冲突。构建候选 TLB 后一次替换，任一记录错误都不改变旧缓存。空记录集显式恢复为空缓存。

Host ABI（缓冲区由 `v86_malloc` 分配，以 `v86_free` 释放，在 CPU 安全点调用）：

- `x64_tlb_snapshot_dwords(core) -> i32`：所需 DWORD 数；错误核号返回 -1。
- `x64_tlb_snapshot_write(core, pointer, capacity_dwords) -> i32`：写入并返回 DWORD 数；容量不足或坏参数返回 -1。
- `x64_tlb_snapshot_validate(pointer, dwords) -> bool`：无副作用验证，可在整机快照任何状态变更之前调用。
- `x64_tlb_snapshot_restore(core, pointer, dwords) -> bool`：先验证后提交。空集可传空指针。

物理窗口恢复会清全部 TLB，因此整机恢复顺序必须先恢复物理窗口，再恢复各核 TLB。旧快照没有该段时显式恢复空集。

2026-09-27 运行 `CARGO_PROFILE_TEST_OPT_LEVEL=0 cargo test --target-dir /tmp/v86-x5-native x64::paging::tests::portable -- --nocapture`，[5 个纯测试全部通过](logs/tlb-snapshot-native-2026-09-27.txt)：高线性/物理/witness 往返与 stale 翻译；失效 epoch 不复活和空集恢复；逐项非法记录/重复槽整批拒绝；大页 INVLPG 与未用 witness；supervisor CR0.WP=0 时只读页写缓存权限保留。

随后 `node tests/smp/x64_snapshot.mjs` 在 debug Wasm 上完成 [3 组整机集成验证](logs/x64-snapshot-debug-2026-09-27.txt)：

1. 两核配置下，高 RAM 窗口、RAM 内容和两核不同的完整 TLB 记录经 `save_state`/`restore_state` 全部恢复；保存和恢复不会隐式清空已缓存的 translation。
2. 错误物理窗口或第二核错误 TLB 记录，在 generation、execution epoch、RAM 和任一核 TLB 变化前被拒绝；单独 stateless 验证也不修改机器。
3. 缺少 `state[97]` 或 `core[12]` 扩展的旧快照，会清除目标遗留窗口和 TLB，原 RAM 后备恢复在低物理地址可访问。

该整机 fixture 注入合法缓存记录，隔离快照行为；stale 页表修改直到 INVLPG 的访问语义由上面的纯 walker/TLB 测试覆盖。它没有声称执行 x64 OS 或用客户指令填充真实分页缓存。
