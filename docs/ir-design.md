# Experimental IR compiler: implemented design

> Historical: since this was written the legacy Tier 1/Tier 2 compiler has been
> removed and IR is the only compiler, present in every core build (there is no
> `ir-experimental` feature any more). See [ir-backend.md](ir-backend.md).

This describes the code in this change, **not completion of the full implementation plan**.
The authoritative remaining scope is [v86-ir-implementation-plan.md](v86-ir-implementation-plan.md).

The production CPU still uses the legacy Tier 1/Tier 2 compiler. `ir-experimental`
enables the compiler, live capture and explicit IR cache publication/CPU dispatch.
An opt-in policy now performs automatic IR region compilation and promotion; the
production default remains legacy and no Worker backend switch is enabled. Production changes now include
WasmBuilder's encoding/signature/local management, shared decoding in JIT region
analysis, and a separate regression-test isolation fix. The shared decoder is
compiled independently of the rest of experimental IR.

## Data and executable path

`runtime::compile::compile_region` takes an immutable request and byte snapshot.
The frontend reads only the supplied bytes. It does not invoke CPU memory helpers
or update CPU EIP. EIP, linear address and physical dependency pages have different
Rust types. A missing second page is a compile stop, not a delivered guest fault.
Opcode facts and the coverage directory are generated from `gen/x86_table.js`.
Prefix precedence and `ignore_mod` follow the pinned baseline. `fetch_modrm`
records the family's pre-prefix-selection fetch separately from the selected
encoding's semantic `e` property (notably invalid unprefixed 0F 7C/7D).
Non-custom ModRM helper instructions also remain block boundaries.

Production `analysis::analyze_step` consumes these facts for known complete
instructions. `CpuContext::instruction_snapshot` copies at most 15 bytes from
same-page allocated RAM without invoking MMIO. JIT region discovery supplies the
linear PC explicitly; GuestEip is derived using the CS base. Unknown/reserved
forms still use `analyze_step_legacy`, and the existing near-page-end cutoff
remains. Runtime interpreter decoding has not been migrated.

The HIR has arena IDs, explicit block parameters, typed values, ordered effects,
per-bit arithmetic FLAGS sources, and recovery maps. Sealed SSA construction
supports loops; trivial parameter elimination runs in the pass pipeline.
The verifier checks ownership, types, instruction order, dominance from all
entries, edge arguments, effect continuity, helper signatures and recovery uses.
The verifier rejects unreachable input blocks. Constant branch pruning removes
newly unreachable blocks and compacts their arenas before reverification.

The current legal MIR subset contains integer operations, register initialization,
state exits, branches and explicitly adapted i32/i64 outcome helper calls.
[`MirRegion` owns its machine plans](ir-mir-owned.md); the checked lowering
transaction releases HIR before emission. Controlled literal folding is available
on the owned representation, while general MIR graph transformations remain pending.
The standalone state ABI rejects guest memory; the cold CPU ABI supports the
integer memory/RMW subset described in [ir-memory.md](ir-memory.md). Unadapted
helpers, F80/x87 and unsupported SIMD forms remain rejected. Legalized helper imports carry their structural ABI and
allowed exit outcomes; normal state-writing helpers require future reload support.
Dispatcher and explicit effectful budget polls share the same work counter and
MIR state materializer; [straight-block merging](ir-cfg-merge.md) preserves polls
at each removed entry boundary.
There are no old JitContext/emitter calls inside the experimental frontend/backend.

Wasm uses a block dispatcher with edge-local parallel copies. All copy sources are
staged before any destinations are overwritten. This supports cycles, critical
edges and arbitrary reachable CFGs, with multiple external entries initialized
independently. The initial backend rejects an external entry with internal
predecessors; splitting prologues from internal block entry is still pending.

Typed liveness/interference allocation includes recovery values, loop live ranges
and edge arguments. Effect tokens do not receive locals. Allocation has live-set
and work limits. Each non-entry block must have a recovery map for budget exit.
Budget consumption counts dispatched blocks and preserved internal polls, while guest
instruction accounting is carried by StateMaps. The cold CPU ABI tracks materialized
committed-count deltas and now accepts loops with complete live [SSA count-base
maps](ir-dynamic-count.md). Static/mixed-count CPU loops remain rejected. Reachable direct guest CFG lifting
is available through a cold compilation API; online scheduling is not yet integrated. REP now has
separate element-work reporting and final instruction commit through its
[terminal batch ABI](ir-rep.md). Full guest scheduling and live runtime budget
integration remain pending.

## Initial register frontend

Implemented operations include MOV, register XCHG, LEA, MOVSX/MOVZX,
ADD/ADC/SUB/SBB/CMP/AND/OR/XOR/TEST, INC/DEC, NEG/NOT, CLC/STC/CMC,
SETcc/CMOVcc, and terminal Jcc/JMP/LOOP/JCXZ families. Supported widths include 8/16/32 and
AL/AH/AX aliases. The standalone frontend rejects memory other than LEA. `lift_cpu` additionally
supports MOV, integer ALU/compare/test, unary and conditional memory forms with
explicit effects and fault/commit maps. RMW uses paired affine tickets; general
reusable RAM-proof optimization remains pending.
Audited memory LOCK forms use the explicit paired ordering contract in
[ir-exchange.md](ir-exchange.md); other LOCK forms are rejected.
Later scalar/BCD, implicit memory, stack and near-control extensions are described
in [ir-progress.md](ir-progress.md). Counter width and target width are independent
for [LOOP/JCXZ](ir-loops.md). Branches inside a linear snapshot are rejected; terminal branches restore their
selected EIP on exit. Multi-block decoding/region discovery is still pending.

FLAGS are six I1 SSA values plus the incoming system flags. Narrow arithmetic
is explicitly masked. ADC/SBB use two carry/borrow checks, INC/DEC preserve CF,
and logical AF follows the baseline's zero result. No undefined flags use poison.

The bounded pass pipeline provides pure constant folding, block-local GVN,
trivial non-effect parameters, and DCE rooted in terminators, effects and active
recovery maps. It verifies after each transformation stage. It does not yet provide
region-wide GVN, memory forwarding, LICM, SIMD optimization or state-sync pruning.

## WasmBuilder audit

Locals use u32 indices with LEB128 for get/set/tee. Type declarations come from
an allocation-time type vector; free pools no longer define types implicitly.
Double free, unfreed locals and incompatible helper signatures fail in release
as well as debug. Existing `unsafe_clone` lifetime requirements still apply.

Function signatures are interned structurally. Types include i32/i64/f32/f64/v128
and multiple results. Names, imports, exported function indices, local vectors,
group sizes, section/body lengths, calls and branch depths use full unsigned LEB.
Sections are assembled at finish, replacing the 14-/28-bit fixed-width patchers.
Conversions of host lengths to Wasm lengths are checked.

The builder emits one function and one imported memory. It does not emit a table
section; production `WasmTableIndex(u16)` and table-capacity policy are separate
runtime constraints and remain unchanged. Production slot capacity and publication
must be addressed in IR-12, not inferred from the generalized builder.

See [ir-validation.md](ir-validation.md), [ir-helper-contracts.md](ir-helper-contracts.md)
and [ir-progress.md](ir-progress.md) for evidence and remaining gates.

The CPU frontend additionally supports basic PUSH/POP with native SSA pointer
arithmetic, a separate stack-width input and explicit fault/success maps. POP
memory's temporary-ESP segment-fault handling follows the fixed baseline through
`PopAddress`; see [ir-stack.md](ir-stack.md). Complex stack/control operations and
online tier integration remain pending.

Near CALL/RET and indirect JMP now use `StateMap.next_value` for SSA destinations,
with explicit pre-fault and successful transfer state. The dynamic value is a
liveness/DCE root and is updated during substitutions. Targets are captured before
CALL pushes; target fetch belongs to the next execution step. See
[ir-control.md](ir-control.md). Full system transfers and live tier integration
remain pending.


## Shift FLAGS provenance

`FlagState.last_op1` retains the pinned CPU operand used by undefined AF after
shifts. It is a typed I32 source read at entry and updated by arithmetic SSA, then
materialized at observer/fault/exit snapshots. It participates in all StateMap
value walks and substitutions. The standalone ABI supplies its own checked
`StateLayout.flag_operand` word; CPU emission uses the actual global. Shift and
rotate computations, including double shifts, remain native pure HIR between
memory RMW effects. See [ir-shifts.md](ir-shifts.md) for count and flag policies.


## Native i64 and checked division

Scalar I64 values now lower through typed Wasm locals, arithmetic/conversions and
parallel edge copies. Generic helper import signatures and return staging retain
I32/I64 widths. I64 arithmetic does not weaken the separate RmwTicket verifier.
`Divide` is ordered, width-checked and owns a pre-instruction recovery map. Its
native emitter guards all host traps and guest quotient overflow before assigning
results; the CPU adapter only delivers #DE. See [ir-multiply.md](ir-multiply.md).


## Typed bit counts and byte-addressed bit strings

Pure leading-zero, trailing-zero and population-count nodes accept I32/I64 and
have matching Wasm/folder semantics, including zero. BSF/BSR explicitly select the
old destination for zero sources and compute pinned FLAGS through the retained
operand state. Memory BT-family nodes lower to one-byte loads or RMW tickets after
signed bit-index displacement, preserving address-size wrapping order. See
[ir-bits.md](ir-bits.md) for prefix and undefined-flag policies.

CPU identification, timestamps and MSRs use named terminal adapters with explicit
permission/fault ownership. Their state and deterministic debug/release tests are
described in [ir-cpu-info.md](ir-cpu-info.md); production CPUID/clock policy is
unchanged and online publication remains pending.

The terminal system frontend additionally supports SYSENTER/SYSEXIT, HLT, CLI,
CLTS and WBINVD. Mode changes keep CPU-owned segment caches and fetch state;
HLT retains synchronous timer/halt/IRQ observations. Their exact cold-entry
contract is documented in [ir-cpu-system.md](ir-cpu-system.md). STI requires
further next-instruction-shadow modeling and is still rejected.

CR/DR transfers use terminal adapters with explicit GPR and system-register
indices, preserving full 32-bit width and the decoder's ignored ModRM.mod rule.
CPU TLB/PDPTE maintenance and fault/abort ownership are documented in
[ir-control-regs.md](ir-control-regs.md). This does not install experimental
artifacts into the online context-generation or invalidation protocol.

Descriptor-table operands, SMSW/LMSW and INVLPG use explicit EA/segment HIR and
staged terminal CPU helpers, documented in [ir-descriptor.md](ir-descriptor.md).
Their compound data accesses are CPU-owned, with preflight/partial-write policy
retained. Explicit invalid-register #UD paths are covered separately within that
family; the production coverage gate remains unchanged.

SLDT/STR and LLDT/LTR have terminal CPU adapters with precise mode/privilege and
descriptor outcomes. A checked LTR core preserves the legacy caller ABI and
partial busy-write state. [ir-task-regs.md](ir-task-regs.md) describes independent
pinned LTR/LLDT reference bodies, CPU regressions and remaining task-switch scope.

LAR/LSL have contracted terminal descriptor queries with post-fault destination
writes preserved. VERR/VERW also have terminal query adapters. Their
[contract](ir-selector-query.md) records the separate raw ZF SSA source and CPU
materialization needed to preserve descriptor-fault/MMIO observations across IR
exits and reentry. Other arithmetic bits remain materialized, with last_op1
provenance retained for baseline undefined AF behavior.

CMPXCHG8B uses an ordered terminal HIR operation with a guarded native i64 RAM
path and a CPU-owned staged slow adapter. [Its contract](ir-cmpxchg8b.md) includes
write preflight, callback register capture, partial failures, and separate SSA
provenance for the ZF lazy marker. These plans now belong to the owned MIR artifact;
general graph and effect transformations remain outside the implemented MIR API.

XMM mappings now use V128 SSA, typed locals and parallel edge copies, with full
active vector mappings in StateMaps. [SIMD transfers](ir-simd-moves.md) use native
RAM vector loads/stores and CPU-owned cold completion exits. Scalar register
forms preserve high lanes; scalar memory loads zero them. Vector arithmetic,
FP controls and MMX/x87 remain subsequent IR-08 work.

The separate `compile_cpu_cfg_region` API now constructs reachable direct CFGs
from immutable x86 bytes, carrying GPR/FLAGS/XMM/effect and dynamic retirement
bases between instructions. It retains terminal store/helper boundaries and
outside/dynamic exits. [The CFG frontend contract](ir-cfg-frontend.md) describes
budgets, snapshot remapping and actual interpreter/fault comparisons. The linear
compiler and online legacy selection retain their existing behavior.

[Dominator GVN and constant branch pruning](ir-dataflow.md) now run in the
optimized pipeline, with CPU/effect exclusions, all-entry reachability and exact
budget equivalence. Memory proofs and online Tier integration remain separate.

CPU compile-request artifacts now carry a logical/linear/default-width entry key.
Their Wasm guard precedes all entry state changes; publication-key comparison also
requires the entry contract. This is distinct from code dependency/lifetime
validation and from the unguarded MIR fixture emitter. See [CPU entry admission](ir-entry.md).

[Live in-Wasm compilation](ir-live-compile.md) now captures CPU code with a read-only
RAM walker and explicit linear-to-physical mappings. It exposes one unpublished
artifact with context/generation/write-version/content revalidation. Those live
handles alone do not reserve table slots. [Explicit IR cache publication](ir-cache.md)
now transfers a result into the shared slot pool, watches its physical dependencies
and enables normal CPU dispatch, with owner validation and cold-frame reclamation.

[Automatic compilation](ir-auto.md) now uses bounded ordinary/linked entry heat,
shared-decoder region windows and per-main-loop compile credit. Lightweight Tier 1
can promote to a larger optimized Tier 2 region through the same publisher, with
failed-input suppression and bounded automatic cache eviction. It remains opt-in.

The [public backend selector](ir-backend.md) now enables this policy through
`jit_backend: "ir"`, disables legacy generation and carries bounded region options
through normal initialization and CPU Worker messages. Runtime statistics are
copied through `get_jit_info()`; snapshot restore keeps the destination's policy.
This is a supported experimental entry point, not production-default acceptance.
