# XC：真实 x86_64 Linux 启动链路

`tests/x64/linux_boot.mjs` 下载并校验官方 Alpine virt 3.24.0 x86_64 ISO，提取原始 `vmlinuz-virt` 和 `initramfs-virt`，通过 Linux boot protocol、SeaBIOS 和原始 ISO 启动。测试不写 CPU 上下文，不修改 kernel/initrd，也不把 synthetic guest 通过视作 OS 已通过。

来源：[官方 ISO](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.0-x86_64.iso) 与 [官方 SHA-256](https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-virt-3.24.0-x86_64.iso.sha256)。固定 SHA-256：

- ISO：`6cd1a38ae05cf96a5d0cbb2ddd6c630834babfeca1ecc5d1f05ec0b06b886102`
- kernel：`1e6bf9027720c75c3ed0d79171f21b5791ee40ca9795d07c7c6e04dc5ea2ae90`
- initrd：`e7f4d0ab8a434f70317392610303c2dfac59bd66c4452a8b80024d83beac3802`

内部 qualification 开关 `set_x64_test_capabilities(bool)` 在每个新 Wasm machine 默认关闭；测试显式启用后，仅在既有32位 profile上添加 CMPXCHG16B、SYSCALL、NX、LM、LAHF/SAHF 和 48 位线性/36 位物理地址报告。没有新增公开 `cpu_profile` / `cpu_execution` 配置，没有宣告未实现的 AVX/XSAVE/BMI/LA57/1GiB page。

```sh
X64_LINUX_QEMU=1 node tests/x64/linux_boot.mjs
SHOW_LOGS=1 node tests/x64/linux_boot.mjs
X64_JIT=1 SHOW_LOGS=1 node tests/x64/linux_boot.mjs
```

独立 QEMU TCG 已完成 login → root shell → `uname -m` = `x86_64` → 命令完成标记；日志为 `build/x64-linux/qemu.serial`。v86 相同链路正在验证，尚未通过。首次实际执行识别到 32→64 `RETF` 未更新 CS.L、仍套用16位 EIP断言，导致 `instr32_CB` host panic（RIP=0x100200，前一IP=0x100111，EFER=0x500，CS=0x10）。该失败促使修复实际模式切换入口，不能只移除断言来掩盖错误模式。

每轮保存 `image.json`（镜像哈希/命令行）、`result.json`（通过或失败、完整 RIP/EFER/GPR/只读页表解析的指令字节/机器诊断）及串口记录。正式通过要求内核无 panic、到达实际登录 shell，并执行 `uname` 和完成命令；多核上线、原生命中、长期负载和性能仍须分别提供证据。
