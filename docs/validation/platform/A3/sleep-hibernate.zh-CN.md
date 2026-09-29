# A3：S3（挂起到内存）、S4（OS 主导休眠）与 ACPI 电源闭环

本阶段把 A1 暂时隐藏的 S3/S4 做成真实可用的睡眠状态，并在 32 位与 64 位 Linux、单核/多核、解释器/JIT、轮转/宿主并行（W1）下各做 20 次循环验收。基线：`8af0560e + 未提交修改`（2026-09-28/29，用户自行提交）。

## 设计

平台描述（[`src/platform.js`](../../../../src/platform.js)）中的 `ACPI_SLEEP_STATES` 是睡眠状态的唯一来源：SeaBIOS 经 fw_cfg 文件 `etc/system-states`（[`acpi_system_states_file`](../../../../src/acpi.js)）读取每个状态的 SLP_TYP 与是否公布，由此生成 DSDT 的 `\_S3`、`\_S4`、`\_S5` 包。只有这里标记为 supported 的状态才会出现在表里；客户机写入未实现的 SLP_TYP 时，设备按“立即唤醒”处理，不会挂住。

### S3：挂起到内存

- 客户机写 PM1_CNT（SLP_TYP=S3、SLP_EN）后，[`ACPI.prototype.suspend`](../../../../src/acpi.js) 置 `sleeping = 3`，在 CMOS 0x0F 写入 0xFE（SeaBIOS 的 S3 resume 标记），并让所有核在当前指令结束后停止：轮转模式下 `run_cores` 不再执行任何核；宿主并行模式下 `run_parallel` 发出 stop-the-world，所有 vCPU Worker 在安全点停泊。**不以“所有核执行 HLT”代替睡眠。**
- 睡眠期间 RAM 与设备状态保留，设备定时器照常运行（RTC 闹钟可以唤醒）；PM timer、TSC 与机器时钟按 C0 的策略继续。
- 唤醒源：电源按钮（PWRBTN_STS）、RTC 闹钟（RTC_STS 且 RTC_EN）。`wake` 置 WAK_STS 与唤醒原因，然后 [`CPU.prototype.resume_from_sleep`](../../../../src/cpu.js) 以 `reboot_internal("s3-wake", keep_memory)` 复位全部 CPU 与设备但保留 RAM 和已影子化的 BIOS。SeaBIOS 看到 POST 已运行且 CMOS 0x0F=0xFE，走 resume 路径跳到 FACS waking vector；AP 由客户机按正常 INIT/SIPI 重新启动。
- 事件：`acpi-sleep`（"S3"）、`acpi-wake`（"power-button"/"rtc"/"other"）；`V86.prototype.power_state()` 返回 "S0"/"S3"/"S4"/"S5"。

### S4：OS 主导的休眠

在 PIIX4/SeaBIOS 模型里，S4 对硬件只是一次带 S4 标记的 soft-off：客户机把休眠映像写入交换盘并刷盘后写 SLP_TYP=S4，设备进入 `soft_off = 4`，emulator 停止并发出 `acpi-power-off`（"S4"）。下一次上电（`power_button()` 或 `run()`）按冷启动处理：RAM（含 X6 扩展 RAM）清零、固件重新 POST，由客户机内核通过 `resume=` 从磁盘恢复。**不用宿主 save_state/restore_state 模拟 S4，也不公布 S4BIOS。**磁盘内容跨关机保留（内存盘/异步盘/只读覆盖盘的写回策略与普通关机相同）。

### 表与 AML

[`tests/devices/acpi_tables.js`](../../../../tests/devices/acpi_tables.js) 用 ACPICA 的 `iasl`/`acpiexec` 反汇编、重编译并执行 DSDT，断言 `\_S3 = {1,1,0,0}`、`\_S4 = {2,2,0,0}`、`\_S5 = {0,0,0,0}`（7/7 通过）。

## 客户机测试

- [`tests/devices/acpi_guest.js`](../../../../tests/devices/acpi_guest.js)（`GUEST=linux4`：`images/linux4.iso`，SHA-256 `a8ea434ab3b177c55f01275dcc1d35f52cfbee9bd44a32e74765c975b58bcc73`，32 位 Linux 4.16，`nokaslr resume=/dev/sda`，96 MiB 空白交换盘）：
  - 电源按钮只产生一次事件、一次 SCI；`acpi_pm` 作为 clocksource 时客户机时间跟随 PM timer；
  - S3 × N：奇数轮由 RTC 闹钟（`/sys/class/rtc/rtc0/wakealarm`）唤醒，偶数轮由电源按钮唤醒；断言唤醒原因事件、RAM 中的校验数据完整、`uptime` 与 RTC 墙钟不倒退、所有核重新在线；
  - S4 × N：写入计算出的 marker，`echo disk > /sys/power/state`，断言 `acpi-power-off` 为 "S4"，上电后 shell 在恢复的内核中继续并读回 marker；
  - 之后 reboot 与 S5 power cycle 各两次。
- [`tests/x64/linux_boot.mjs`](../../../../tests/x64/linux_boot.mjs) 的 `X64_LINUX_SLEEP=<cycles>`（`X64_LINUX_FLAVOR=lts`：Alpine standard 3.24.0 x86_64 ISO，SHA-256 `9f8bf67c1604381bf056f907d77adaf301fad9cc7b9e1fb73660c1b66f3ebd9f`，其 lts 内核带 `CONFIG_HIBERNATION`；virt 内核没有）：`/sys/power/state` 必须含 `mem disk`；S3 同样交替 RTC/电源按钮并核对 tmpfs 内容的 md5 与在线 CPU；S4 在 256 MiB 空白 `/dev/sdb` 上 `mkswap`/`swapon`，恢复后断言 `dmesg` 中恰有一条 “Waking up from system sleep state S4”、tmpfs 内容与在线 CPU 完整。Alpine live initramfs 在加载磁盘驱动前处理 `resume=`，因此命令行追加 `ata_piix`。

## 结果（每项 20 次 S3 + 20 次 S4）

| 客户机 | 配置 | 结果 | 日志 |
| --- | --- | --- | --- |
| Linux 4.16 i386 | 1 核 JIT | 通过，另 2 次 reboot、2 次 S5 上电 | [log](logs/linux4-1c-jit-20xS3-20xS4-2026-09-28.log) |
| Linux 4.16 i386 | 1 核解释器 | 通过 | [log](logs/linux4-1c-interpreter-20xS3-20xS4-2026-09-28.log) |
| Linux 4.16 i386 | 2 核 JIT | 通过 | [log](logs/linux4-2c-jit-20xS3-20xS4-2026-09-28.log) |
| Linux 4.16 i386 | 2 核解释器 | 通过 | [log](logs/linux4-2c-interpreter-20xS3-20xS4-2026-09-28.log) |
| Linux 4.16 i386 | 4 核 JIT | 通过 | [log](logs/linux4-4c-jit-20xS3-20xS4-2026-09-28.log) |
| Linux 4.16 i386 | 4 核，宿主并行（W1，JIT） | 通过：S3 的全核停机屏障与恢复经 vCPU Worker 停泊协议 | [log](logs/linux4-4c-parallel-jit-20xS3-20xS4-2026-09-29.log) |
| Alpine 3.24 x86_64（lts，Linux 6.18） | 1 核页层 | 通过 | [log](logs/alpine-lts-1c-page-tier-20xS3-20xS4-2026-09-28.log) |
| Alpine 3.24 x86_64（lts） | 2 核页层 | 通过，所有 CPU 在每次恢复后在线 | [log](logs/alpine-lts-2c-page-tier-20xS3-20xS4-2026-09-28.log) |

此外，W1 回归每次运行 `PARALLEL=1 GUEST=linux4 CPU_CORES=4 S3_CYCLES=4 S4_CYCLES=2`（见 [W1 记录](../W1/parallel-correctness.zh-CN.md)）。

## 本阶段修正的问题

- Alpine S4 首次尝试冷启动而非恢复：live initramfs 在找到交换盘前就处理了 `resume=`，命令行加载 `ata_piix` 后解决（测试侧）。
- Linux 6.x 在恢复时只在 `pm_debug_messages` 开启时打印 “Image restored successfully”；改为统计恢复后内核总会打印的 “Waking up from system sleep state S4”。
- 4 核 S3 首次在 SeaBIOS 的 SMP 锁上挂起：解释器的内存 `BTS/BTR/BTC` 是普通读后写，在并发核上会丢失锁释放；改为经 `safe_read_write8` 的原子读改写（W1 中发现，32 位与 x64 路径同时修正）。

## 限制与未验收

- 不支持 S4BIOS（固件保存映像），不公布该能力；S1/S2 不公布。
- Windows 的 S3/S4 未验收：Windows 8.1 x64 镜像只读，覆盖层写入只存于本次会话内存；Windows 休眠需要 hiberfil.sys 跨上电保留，本轮没有做该验收。
- 64 位 Alpine 的 4 核睡眠循环未单独运行（2 核已覆盖 AP 重新上线路径）。

## 复现

```sh
make acpi-table-tests                                       # ACPICA 反汇编/执行（需 IASL/ACPIEXEC）
GUEST=linux4 CPU_CORES=2 S3_CYCLES=20 S4_CYCLES=20 POWER_CYCLES=2 node tests/devices/acpi_guest.js
GUEST=linux4 CPU_CORES=2 DISABLE_JIT=1 S3_CYCLES=20 S4_CYCLES=20 node tests/devices/acpi_guest.js
GUEST=linux4 PARALLEL=1 CPU_CORES=4 S3_CYCLES=20 S4_CYCLES=20 node tests/devices/acpi_guest.js   # 需 make parallel
X64_LINUX_FLAVOR=lts X64_JIT=1 X64_CORES=2 X64_LINUX_SLEEP=20 X64_LINUX_TIMEOUT=7200000 node tests/x64/linux_boot.mjs
```
