# Windows XP SMP 资格验证

入口是 [`windows_qualification.mjs`](../../../../tests/smp/windows_qualification.mjs)，使用用户提供的 `windowsxp_multidisk_C_4G.img`。当前结果是 **原始 UP Windows 客户机探针通过，ACPI MP Win32 多核门槛尚未通过**；不能仅凭 AP 已执行 NT 内核就声明 Windows SMP 完成。详细记录和文件校验和在 [`windows-xp-manifest.json`](windows-xp-manifest.json)。

原盘是 4 GiB raw MBR/NTFS 镜像，系统为 XP SP3 5.1.2600.5512。实际安装的 HAL 版本资源是 `PC Compatible Eisa/Isa HAL`，原始内核为 `ntoskrnl.exe`。配置 4 核后，Windows 正常进入桌面，Win32 探针报告 `processors=1 process_mask=1 machine_mask=1`，完成 128 轮、0 次失败。其他 AP 仍在 BIOS，符合 Standard PC UP 安装的能力边界。

测试只读打开原始镜像，所有客户机写入保存在 RAM 中的 sector overlay。新建的 FAT16 IDE 工具盘承载静态 Win32 探针及从同一原盘 `sp3.cab` 只读提取的匹配 `halmacpi.dll`、`ntkrnlmp.exe`。客户机批处理复制备用文件到 System32，通过 `/HAL=HALSMP.DLL /KERNEL=NTSMP.EXE` 的 Boot.ini 项尝试 MP 启动；原 HAL/kernel 不被覆盖。这些启动覆盖参数由 [Microsoft 的 Boot.ini 文档](https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/switch-options-for-boot-files) 定义。退出时核对原盘大小与 mtime 未变；报告保留原始盘 SHA-256。

探针创建与 Windows 处理器数相同的线程，各执行 128 轮。每轮通过 `SetThreadAffinityMask` 迁移，并在工作前后读取 CPUID leaf 1 的 APIC ID，验证实际执行核心；共享进度用 Interlocked 原子更新。仅列出 CPU 数量、进入桌面或 host 核心计数增加都不能使该门槛通过。

## MP 启动未决问题

匹配 MP HAL/kernel 确实启动 4 个 APIC ID：每个核心都进入 NT MP 内核并持续执行。随后全部核心在 `0x804dcbe1` 的 idle 循环停留，240 秒内未进入桌面或完成 Win32 探针。`KiBugCheckData` 的五个 DWORD 均为零。BSP LAPIC ISR 曾为 `0xD1`，单独发送 EOI 清除此向量后仍无进一步进度；因此不能把它直接归为此前 Linux reset 的旧 IRQ 路由缺陷。

未修改的失败快照保留在 `build/c3-windows-xp/mp-stalled-state.bin`，诊断在同目录的 `mp-stalled-debug.json`、`inspector-registers.json`，原始执行日志是 `build/c3-windows-xp.log`。该快照包含转换后的 RAM 磁盘覆盖层，可恢复继续诊断。它使用固定 JS/Wasm 产物，原始文件内容不写入仓库。下一步应把同一覆盖层转换盘送入独立 QEMU 参考环境，区分 Standard PC 到 ACPI HAL 转换所需的设备树适配与模拟器缺陷；当前证据不足以给其中一方定责。

复现命令（需要 `7zz` 和 `i686-w64-mingw32-gcc`）：

```sh
XP_LOG_DIR=build/c3-windows-xp node tests/smp/windows_qualification.mjs /path/to/windowsxp_multidisk_C_4G.img
```

并行开发时用 `V86_MODULE=../../build/c3-os-fixed-lib.mjs WASM_PATH=build/c3-os-fixed-release.wasm` 固定配对产物；本次对应 SHA-256 已记在 manifest。`XP_PHASE_MS` 可延长等待，`XP_KEY_DELAY` 控制扫描码间隔；图形分辨率变化仅是尝试启动探针的启发条件，不是 Windows 启动成功判据。

从失败快照继续 MP 诊断，并导出供参考机使用的新盘：

```sh
V86_MODULE=../../build/c3-os-fixed-lib.mjs \
WASM_PATH=build/c3-os-fixed-release.wasm \
XP_RESTORE=build/c3-windows-xp/mp-stalled-state.bin \
XP_RESUME_MP=1 XP_PHASE_MS=1000 \
XP_LOG_DIR=build/c3-xp-export \
XP_CONVERTED_DISK=build/c3-xp-converted.img \
node tests/smp/windows_qualification.mjs /path/to/windowsxp_multidisk_C_4G.img
```

此命令的短等待阶段预期因探针未完成退出非零；finally 阶段仍会将原盘复制为一个**必须不存在的新路径**，再只向这个新文件应用 RAM sector overlay。`XP_CONVERTED_DISK` 不能等于原盘，也不能覆盖已有文件。原始盘继续以 `r` 方式打开。`XP_RESTORE` 需使用保存快照时匹配的固定 JS/Wasm 产物。诊断中可向输出目录的 `command.txt` 写入客户机命令，由已有的键盘输入流程执行。
