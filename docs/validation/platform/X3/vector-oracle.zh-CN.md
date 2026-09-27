# X3：SIMD、MMX 与 x87 独立验证

[`vector.rs`](../../../../src/rust/x64/vector.rs) 接入共同的 long-mode decoder、16 个 XMM 架构寄存器和宽地址访存。XMM8–15 使用独立 bank；原来固定指向 8 个寄存器的 legacy XMM accessor 已集中到 bank 地址函数，packed integer helpers 不再别名到 XMM0–7。每条成功指令才提交 RIP，异常保留故障 RIP。

实现包括 SSE/SSE2 的 packed/scalar 浮点、转换、比较、整数饱和/打包/移位、MMX、SSE3 水平运算和复制、宽 GPR↔XMM、FXSAVE64/FXRSTOR64、MXCSR、x87 寄存器及内存操作。地址经过共同的 FS/GS、RIP-relative、address32 及 canonical 检查；跨页 store 和完整 FXSAVE/FXRSTOR 提交前先验证整个访问。SIMD 禁用、TS、对齐、分页和未屏蔽浮点异常产生客户机异常。

SSE 算术直接调用现有 SoftFloat 的 f32/f64 实现，按 MXCSR 设置四种舍入方式，提交 sticky flags，并处理 DAZ/FTZ；异常时不写目的 XMM。long-mode x87 在每条指令的作用域内使用精确算术策略，随后恢复 legacy host 策略，不改变原有 32 位执行路径。其格式和整数转换保留 precision/overflow/invalid 等标志；未屏蔽 x87 异常延迟到等待型指令，no-wait 状态操作仍可观察和清理状态。

## 可重跑的客户机

```sh
node tests/x64/vector_oracle.mjs
X64_JIT=tier0 node tests/x64/vector_oracle.mjs
X64_JIT=region node tests/x64/vector_oracle.mjs
TEST_RELEASE_BUILD=1 node tests/x64/vector_oracle.mjs
```

[`vector_oracle.mjs`](../../../../tests/x64/vector_oracle.mjs) 生成同一 NASM multiboot 二进制，QEMU TCG 和 v86 都执行真实的分页开启与 long-mode 跳转，然后在 `0xFFFF800000...` 高 RIP 运行。没有注入最终寄存器或直接调用待测语义函数。结果包括 4 个完整 XMM（含 XMM0 别名哨兵）、MXCSR、GPR、定义明确的 FLAGS、异常向量/错误码/CR2、跨页 store 的未修改内存前缀。

当前 corpus 为 949 cases，覆盖：四舍入模式、quiet/signaling NaN、正负零、无穷、denormal、DAZ/FTZ、整数转换边界、全部 8 个比较 predicate、packed integer/MMX、16 个 XMM 的保存恢复、高 FIP/FDP、FS 全宽基址、address32、CR0/CR4 guards、对齐与跨页异常、x87 四舍入/FNCLEX/延迟 #MF。`X64_JIT` 两种模式额外执行混合整数 native 块与 SIMD helper 的热循环，要求有实际 native retirement；它不宣称 SIMD 已直接编译成 Wasm 算术。

`X64_VECTOR_FILTER` 可按用例名称筛选，`X64_ORACLE_ONLY=1` 只生成独立参考。产物在 `build/x64-vector/`：guest.asm/bin、cases.json、qemu.bin、v86.bin、differences.json。最终运行记录与校验和由 `vector-oracle-manifest.json` 固定。

## 参考实现的已知差异

五个用例保留 QEMU 结果，但另按明确的架构后置条件断言：两种未屏蔽 SSE 异常不得提交目的寄存器；LDMXCSR 高保留位触发 #GP；双 NaN 的 SSE 传播选择首个操作数；FXSAVE64 保留完整 FIP/FDP。这些规则来自 [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)。[QEMU 10.2 的 FPU 实现](https://raw.githubusercontent.com/qemu/qemu/v10.2.0/target/i386/tcg/fpu_helper.c) 明确记录了 SSE NaN 使用 x87 选择规则的 TODO，保存的指令/数据指针为零；其 MXCSR helpers 更新状态而未实现这些异常路径。因此没有为了匹配参考缺陷而降低架构行为。

独立差分实际发现并修正了 denormal 与 NaN/invalid 的优先级、float→integer 的 denormal 标志、CVTPI2PS 高 64 位保留、x87 精度标志丢失及 legacy fast-math 绕过异常的问题。x87 超越函数仍复用已有实现；该 corpus 不宣称已穷举全部超越函数输入或全部平台微架构的近似倒数结果。

2026-09-27 的 19:59 debug 构建上，解释器、Tier0 和 region 各通过全部 949 cases；两种 JIT 模式分别记录 1,440,442 与 1,440,462 次 native retirement。每个后端包含 944 组独立 QEMU 逐字段比较和上述 5 组架构断言。1,000,000 轮混合预热保证异步编译已实际发布，避免短热循环在繁忙主机上结束过早。日志保留在本目录 `logs/vector-*-2026-09-27.txt`。这次记录为 debug 验证，release 需配对统一构建另行复验。
