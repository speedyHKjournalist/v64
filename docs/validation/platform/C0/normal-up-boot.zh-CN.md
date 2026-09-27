# C0 正常单核启动性能对照

2026-09-27，正式采样时间为 10:32:57–10:33:55 UTC。**`fc79557e` 相对 C0 前 `bb8979f3` 的启动时间中位数增加 0.619%，通过预先规定的 10% 回退阈值。** 固定 16 MiB 工作量的耗时中位数减少 1.745%。

本报告只覆盖下列两个精确版本和产物。后续工作树新增的退休统计、执行热路径或设备改动需要重新运行，不能直接继承此结果。它补充 C0 的正常单核启动门槛，不代表全部 P0 性能矩阵、其他 OS、其他宿主或多核吞吐已经验收。

## 方法

- 基线为 `bb8979f384b2fdeb5a653a238f61932579fa9aa7`，候选为 `fc79557ee109a87fc91ac60a19eaf9f7be707011`。两个独立 `/tmp` worktree 的已跟踪源码均无改动；分别执行 `make build/v86.wasm build/libv86.mjs`，各自使用自己的 `build` / Cargo target 目录，`WASM_OPT=false`。两份 C 辅助对象也独立重建，得到相同 SHA-256。
- 相同 SeaBIOS、VGA BIOS 和 `linux4.iso`；128 MiB RAM、`cpu_cores: 1`、ACPI 开启、默认 JIT、默认正常时钟；使用镜像自带 bootloader 和内核参数。
- 每个样本使用全新的 Node 进程和模拟器。计时从 `emulator-loaded` 之后调用 `run()` 的前一刻开始，到串口字节回调收到 Linux shell 的完整 `~% ` 提示符结束；覆盖 SeaBIOS POST 和 Linux 启动。构建、模块导入、Wasm 实例化、启动前的镜像装载不在计时内，客户机启动中的虚拟磁盘 I/O 仍在计时内。
- 每个版本先预热一次，再运行五组正式样本，顺序为 AB、BA、AB、BA、AB。没有删除任何正式样本或按结果挑选运行。
- 每次到达 shell 后，再执行 `dd if=/dev/zero bs=1024 count=16384 2>/dev/null | md5sum`。必须完成并输出 `2c7ab85a893283e98c931e9511add182`，随后返回提示符。该固定工作量是附加吞吐观察；脚本的退出判定使用 C0 规定的启动时间指标。
- 预先采用计划 §8 建议的 10% 回退调查阈值：`candidate_boot_median / baseline_boot_median <= 1.10`。这是一项工程回归阈值，不作统计显著性推断。
- 正式窗口开始前协调暂停团队其他构建和模拟器压力测试。宿主原有应用及系统后台任务保留，load average 记录在 JSON 中。之前有并行 C3 测试的探针预先标记为预跑，未计入下表；其原始记录保留在 `/tmp/v86-c0-contended-20260927`。

## 结果与原始样本

所有 12 次运行（含两次预热）均完成启动和校验工作量，串口文本完全一致。每次完整输出保存在 [串口记录目录](normal-up-boot-2026-09-27-serial/)；包含未舍入数值、顺序、产物哈希和环境的 [原始 JSON](normal-up-boot-2026-09-27.json) 是本表的数据来源。

| 组 | 顺序 | 基线启动 ms | 候选启动 ms | 基线工作量 ms | 候选工作量 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 预热（不计中位数） | AB | 3781.893 | 3882.619 | 802.142 | 825.588 |
| 1 | AB | 3784.334 | 3807.756 | 864.124 | 786.320 |
| 2 | BA | 3739.831 | 3675.474 | 792.478 | 735.542 |
| 3 | AB | 3796.315 | 3813.035 | 939.812 | 1010.942 |
| 4 | BA | 3805.485 | 3790.649 | 800.288 | 792.674 |
| 5 | AB | 3777.040 | 3843.649 | 768.761 | 727.580 |
| **正式样本中位数** | | **3784.334** | **3807.756** | **800.288** | **786.320** |

启动时间比例为 **1.006189**，工作量时间比例为 **0.982546**。结论是这个版本在该固定单核启动场景内低于 10% 回退阈值；没有以总构建时间、文件 mtime 或一次启动成功代替性能测量。

## 环境和产物

- Apple M1 Pro，10 个逻辑 CPU，16 GiB RAM；macOS 27.0，build 26A428，Darwin arm64 27.0.0。
- Node v25.6.0，V8 14.1.146.11-node.19。
- rustc 1.93.1 (`01f6ddf75`)，Apple clang 21.0.0 (`clang-2100.3.34.2`)，OpenJDK 25.0.2。
- 正式窗口开始和结束的 1/5/15 分钟 load average 分别为 `5.363/11.803/15.851` 和 `5.815/10.816/15.226`；这不是完全空闲的专用性能实验机。

| 文件 | SHA-256 |
| --- | --- |
| 基线 `build/v86.wasm` | `dd8f903b1602e96076253145ca146f2c5a9080c65074537442804a0dd046f6c8` |
| 基线 `build/libv86.mjs` | `7671e29abe4714a9b4c301bdbc8cf86932c2720dab0304634c6db52f0ef147ed` |
| 候选 `build/v86.wasm` | `6131b10b30a1098489f140d8748caf3b8a74a3ae539b0c0c8408e3c2f1ddcbeb` |
| 候选 `build/libv86.mjs` | `88dc869b0d87713700550545fd9627fc2667e57e2357c356fa014e52cca6ec62` |
| `bios/seabios.bin` | `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98` |
| `bios/vgabios.bin` | `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880` |
| `images/linux4.iso` | `a8ea434ab3b177c55f01275dcc1d35f52cfbee9bd44a32e74765c975b58bcc73` |

JSON 还记录了 runner、Closure compiler、SoftFloat 和 Zstd 对象哈希。所有串口记录的 SHA-256 为 `9703f3a9aea22b5e64ccb80fd102c87dda3c78475776a03a181b2d8760d175d8`。镜像尝试挂载未配置的 9p 文件系统时会输出已有的 mount 提示，两版本相同，不影响本次 shell 和管道工作量；本测试没有通过修改镜像隐藏该输出。

## 重跑

在主仓库目录中运行，以下示例为两个新的独立 checkout 构建，而不使用主工作区的 `build`：

```sh
c0_bench_dir=$(mktemp -d /tmp/v86-c0-bench.XXXXXX)
git worktree add --detach "$c0_bench_dir/baseline" bb8979f3
git worktree add --detach "$c0_bench_dir/current" fc79557e
mkdir -p "$c0_bench_dir/baseline/closure-compiler" "$c0_bench_dir/current/closure-compiler"
cp closure-compiler/compiler.jar "$c0_bench_dir/baseline/closure-compiler/compiler.jar"
cp closure-compiler/compiler.jar "$c0_bench_dir/current/closure-compiler/compiler.jar"
make -C "$c0_bench_dir/baseline" build/v86.wasm build/libv86.mjs
make -C "$c0_bench_dir/current" build/v86.wasm build/libv86.mjs

# 等其他模拟器测试/构建完成后再采样。
node tests/smp/clock_boot_bench.mjs \
  --baseline "$c0_bench_dir/baseline" \
  --current "$c0_bench_dir/current" \
  --assets "$PWD" --samples 5 --ratio 1.10 \
  --output build/c0-normal-up-boot.json
```

后续版本使用新的完整 checkout 代替 `--current`，先独立重建同样的 release 产物。脚本至少要求三个正式样本，默认五个；保存每个成功样本后立即刷新 JSON，失败时保存失败信息及已收到的串口，启动中位数超过阈值时以非零状态退出。脚本已通过 `node --check` 和仓库 ESLint 配置检查。
