# C3：原子异常边界与内存顺序

本记录针对 32 位协作轮转多核；CMPXCHG16B 和真正并行 Worker 的总线排他协议分别属于 X3/XC 和 W1。客户机普通 RAM 访问采用比 x86 TSO 更强的顺序：各核只在完整指令（或 REP 已完成元素的批边界）之间切换，RMW 的权限检查、读取、计算和写回不会被另一核插入。编译代码必须在切片边界退出并使下一次进入重新验证共享 load；不能把另一核可改变的内存值永久复用。

## 真实指令与设备观察

[`atomic_boundaries.asm`](../../../../tests/smp/atomic_boundaries.asm) 建立分页、CR0.WP、IDT 和独立 #PF/#UD handler；[`atomic_boundaries.mjs`](../../../../tests/smp/atomic_boundaries.mjs) 提供只记录读写的测试 MMIO 设备与标记用 PIO。权限变化、INVLPG、原子操作和异常返回均由客户机指令完成。测试设备的回调不修改 CPU 寄存器、页表、TLB 或执行顺序。

每个后端运行 107 个有断言的场景：

- LOCK INC16/32、隐式锁定 XCHG16/32、LOCK XADD32、成功/失败 LOCK CMPXCHG32、成功/失败 LOCK CMPXCHG8B，各覆盖跨页 RAM、MMIO、MMIO→RAM；第二页可写、不存在、只读共 81 个场景。
- 两个同页 MMIO CMPXCHG8B 场景的低 DWORD 最高位置 1，检测 64 位值拼接时的符号扩展污染。
- 8 种非法 LOCK 编码分别置于第二页可写/不存在/只读的地址环境，共 24 个场景。寄存器目的、MOV、CMP、BT、只读内存源、NOP 和 CMPXCHG8B 寄存器编码均交付 #UD，不能访问测试设备。

合法操作先在相同指令地址热身；两种 JIT 必须观察到该指令页发布且有真实编译激活。检查包含异常向量、指向 LOCK 前缀的恢复 EIP、第二页 CR2、#PF 错误码、全部受影响通用寄存器和算术 FLAGS、操作数完整内容，以及每个 MMIO 字节恰好一次读取和写回。失败的权限预检要求设备读写次数均为 0；操作数、寄存器和算术 FLAGS 保持未提交状态。页表 A/D 位不被当作操作数提交状态，它们可以在翻译过程中更新。

修复了测试实际检出的三个缺陷：

1. 解释器 CMPXCHG8B 比较失败时没有写回旧值，MMIO 丢失写周期。
2. 区域后端的独立 `ir_cmpxchg8b` helper 有同样问题；解释器修复不会自动修复这条路径。
3. MMIO `read64s` 的低 DWORD 先按有符号数扩展到 64 位，导致低位 bit 31 置位时覆盖高 DWORD。

另外，LOCK 不再作为可忽略前缀：解释器生成器在读取 opcode/ModRM 后、解析地址和访问操作数之前调用共享 `lock_allowed` 规则；无副作用的 JIT decoder 使用同一规则。合法内存 RMW 保持原子的执行边界，非法形式交付 #UD。规则的 Rust 测试枚举合法 opcode 的所有 256 种 ModRM 和各分组选择。原子写回规则依据 [Intel SDM Volume 2A 的 CMPXCHG8B/CMPXCHG16B 指令契约](https://cdrdv2-public.intel.com/812383/253666-sdm-vol-2a.pdf)：比较失败也需要目的操作数写周期。

## 无锁发布与队列

[`memory_order.asm`](../../../../tests/smp/memory_order.asm) 在每两个核之间运行容量 16 的单生产者/单消费者环形队列。每个元素含序号及其按位取反；生产者写完两个字段后，以普通 store 发布 HEAD；消费者观察 HEAD 后读取并校验两个字段，再以普通 store 发布 TAIL。正常数据路径不包含 LOCK、fence 或 PAUSE。

每对核传递 4,113–4,266 个元素，反复绕回同一 slot；检查消费顺序、完整负载、每核进展、最终 HEAD/TAIL 和累加校验和。JIT 变体要求真实编译激活。矩阵为三后端各 2 核 × 10 固定 seeds × quantum 17/257/4096，再加 4/8 核各一场，共 96 场景。`SMP_MUTATION=publish-early` 把 HEAD 提前到 payload 前并主动让出，应在第一个未完成元素被观察时失败；实测 seed 1、quantum 17 在序号 1 检出。

## 命令与结果

```sh
node tests/smp/atomic_boundaries.mjs
node tests/smp/memory_order.mjs
TEST_RELEASE_BUILD=1 node tests/smp/atomic_boundaries.mjs
TEST_RELEASE_BUILD=1 node tests/smp/memory_order.mjs
# 负向控制，预期非零退出
SMP_MUTATION=publish-early SMP_MODES=interpreter SMP_SEEDS=1 SMP_QUANTUMS=17 node tests/smp/memory_order.mjs
```

Debug 和 release 各通过原子矩阵 321 场景（三后端各 107/107）及无锁队列完整 96 场景。两个构建的原子 Tier-0 / region 激活次数均为 6,037 / 96,677，队列均为 101,147 / 1,260,840。激活次数是执行证据，不是确定性输出。源文件、Wasm、库与日志 SHA-256 见 [manifest](atomic-memory-order-manifest.json)；日志为 `build/c3-atomic-{debug,release}.log` 和 `build/c3-memory-order-{debug,release}.log`。

本门槛补齐原 `coherence.mjs` 合法 RAM 用例之外的故障/MMIO和无锁发布覆盖；磁盘/网络、线程迁移、信号和生命周期另有独立验收，不由本微测试推断。
