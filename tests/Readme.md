Use the corresponding `make` target in the root directory to run a test. The
following list is roughtly sorted from most interesting/useful to least.

- [nasm](nasm/): Small unit tests written in assembly, which are run using gdb
  on the host.
- [qemu](qemu/): Based on tests from qemu. Builds a Linux binary, which tests
  many CPU features, which are then compared to a run on qemu.
- [kvm-unit-test](kvm-unit-tests/): Based on tests from the KVM project, tests
  various CPU features.
- [full](full/): Starts several OSes and checks if they boot correctly.
- [jit-paging](jit-paging/): Tests jit and paging interaction.
- [api](api/): Tests for several API functions of v86.
- [devices](devices/): Device tests.
- [rust](rust/): Rust unit test helpers.
- [expect](expect/): Expect tests for the IR compiler's output. Contains a set
  of asm+wast files; each program is compiled as one Tier-2 region, which must
  match the wast file.

The following environmental variables are respected by most tests if applicable:

- `TEST_RELEASE_BUILD=1`: Test the release build (libv86.js, v86.wasm) instead of the
  debug build (source files with v86-debug.wasm)
- `MAX_PARALLEL_TESTS=n`: Maximum number of tests to run in parallel. Defaults
  to the number of cores in your system or less.
- `TEST_NAME="…"`: Run only the specified test (only expect, full, nasm)

IR compiler tests are available through `make ir-tests`. See
[IR design and architecture](../docs/ir-design.md).

`make ir-decode-snapshot-tests` checks the shared decoder over the complete
catalogue and prefix/addressing corpus, and the boundaries of IR code capture
(MMIO, unallocated RAM, an instruction continuing past a captured page) in a
test-only Wasm CPU.

`make ir-memory-tests` generates CPU-ABI IR fixtures and compares native RAM,
MMU faults, MMIO callbacks and self-modifying aliases against exact interpreter
steps in the dedicated experimental CPU Wasm build.

`make ir-stack-tests` compares PUSH/POP, PUSHA/POPA and LEAVE IR against exact interpreter steps across
operand/stack widths, SP wrapping, real ring0/ring3 faults and MMIO observers,
including whole-range preflight, skipped SP slots and mid-instruction remapping.

`make ir-control-tests` checks near CALL/RET/JMP, dynamic EIP StateMaps, overlapping
return/target memory, real transfer/target-fetch faults, and MMIO callback state.


`make ir-shift-tests` compares group-2 shifts/rotates and SHLD/SHRD with a bit-serial
reference model and exact CPU interpreter steps, including all CL values, count-zero
memory faults/MMIO, and FLAGS provenance across IR exits.


`make ir-multiply-tests` validates native MUL/IMUL/DIV/IDIV against BigInt and CPU
execution, including #DE, memory-fault precedence, TSS privilege transitions,
i64 phi copies and mixed-width helper ABI.


`make ir-bit-tests` validates BT/BTS/BTR/BTC, BSF/BSR, POPCNT and BSWAP, including
signed bit-string addressing, byte MMIO/RMW, exhaustive 16-bit scans/counts and
typed I32/I64 count folding.

`make ir-exchange-tests` validates XCHG/XADD/CMPXCHG aliases, flags, failed-compare
writes, real faults and MMIO, plus audited LOCK arithmetic/bit families and the
nonshared synchronous CPU ABI.

`make ir-enter-tests` uses a dedicated release CPU oracle for ENTER's full nesting
sequence, precise partial progress, alias/MMIO paths and pinned post-fault host
aborts. Expected caught baseline panics appear in its log.

`make ir-misc-tests` validates scalar conversions, SAHF/LAHF, SALC/CLD/STD, BCD
adjustments, moffs and XLAT against independent references and CPU steps, with
exhaustive input matrices and real memory/#DE faults. CPU differential comparisons
mask only undefined OF for DAA/DAS; the independent oracle checks input-OF preservation.

`make ir-loop-tests` validates LOOP/LOOPcc and JCXZ/JECXZ through real CPU and
standalone Wasm execution, independent counter/target references, exhaustive CX
inputs and post-commit target #PF frames.

`make ir-system-stack-tests` checks FLAGS/segment stacks in protected, real and
VM86 modes, native/MMIO operand paths, selector and descriptor exceptions, and
immediate POPF IRQ delivery. It also validates terminal CPU helper outcomes.

`make ir-segment-tests` checks segment MOV and LES/LDS/LSS/LFS/LGS, including
precise operand/descriptor fault ordering, linear pointer tails and VM86.

`make ir-string-tests` checks non-REP MOVS/CMPS/STOS/LODS/SCAS, DF and pointer
wrap, source/destination fault order, MMIO remaps and real-mode/VM86 execution.

`make ir-io-tests` checks scalar IN/OUT and non-REP INS/OUTS, TSS bitmap
permissions, fault priority, port/MMIO observations and callback remaps.

`make ir-rep-engine-tests` builds an isolated pinned string-engine reference CPU
and checks explicit REP outcomes, element budgets, partial faults and reentry.
It requires the recorded baseline commit to be present in the local Git history.

`make ir-rep-tests` checks REP HIR initial/resume artifacts, explicit progress
StateMaps, separate element budgets, fault exits and final instruction commits.

`make ir-cpu-info-tests` checks CPUID, RDTSC and MSR terminal adapters in debug
and release CPUs, with deterministic clock observations, persistent TSC state,
CPL/CR4.TSD faults, real/VM86 modes and pinned unknown-MSR/APIC policies.

`make ir-cpu-system-tests` checks SYSENTER/SYSEXIT, HLT, CLI, CLTS and WBINVD:
mode/segment-cache changes, privilege and real/VM86 behavior, target-fetch faults,
HLT timer/halt/PIC events and exception-delivery MMIO observations.

`make ir-control-regs-tests` checks all CR/DR transfer forms, ignored ModRM.mod,
permission/alias faults, debug/release invalid-state policies, warmed TLB mapping
changes, physical PDPTE MMIO and partial aborts, and post-CR3 target-fetch faults.

`make ir-descriptor-tests` checks SGDT/SIDT/LGDT/LIDT, SMSW/LMSW and INVLPG in
debug/release CPUs: compound operand order, preflight and late faults, table-field
observation during MMIO, address16 tails, real/VM86 modes and target TLB invalidation.

`make ir-task-regs-tests` checks SLDT/STR and LLDT/LTR against independently
pinned interpreter LTR/LLDT bodies in debug/release CPUs, including descriptor
read faults, partial TR state on busy-write abort, MMIO remaps and physical tails.
The reference builder requires the recorded baseline commit in local Git history.

`make ir-selector-query-tests` checks LAR/LSL permission/type matrices, operand
and descriptor faults, post-fault ESP writes, aliases and MMIO destination timing.
`make ir-flags-observer-tests` records the existing VERR/VERW raw-ZF fault behavior;
this diagnostic target runs only the original interpreter.
`make ir-verr-tests` checks the implemented terminal adapters, raw/computed ZF
state, descriptor permissions/faults/MMIO, and IR/IR/interpreter transitions.

`make ir-cmpxchg8b-tests` checks native RAM and CPU slow qword exchange paths,
EA aliases/prefixes, write preflight, MMIO/lazy-ZF timing, callback register
changes/remaps, partial faults and the pinned signed-low MMIO read behavior.
`make ir-verr-tests` also checks IR exits followed by interpreter CMPXCHG8B
write callbacks to verify ZF lazy-marker preservation across backends.

`make ir-simd-move-tests` checks XMM V128 SSA/local/StateMap support and
MOVUPS/UPD/APS/APD/DQA/DQU/SS/SD: aliases and high lanes, native RAM, task-state
guards before EA, unaligned/pinned MMIO behavior, callbacks, partial faults,
cold completion exits, reentry and vector edge-copy cycles.


`make ir-simd-integer-tests` checks 46 packed integer/logical XMM encodings using
22,080 optimized/unoptimized fixtures, both CPU builds and an independent BigInt
lane model. It covers native RAM, saturation/overflow/alias boundaries, EM/TS
priority, page/segment faults, MMIO destination mutations and remapping, and
vector SSA chains across cold completion exits and separately compiled reentry.


The packed suite now also checks packing/unpacking and variable shifts (33,120
fixture pairs), including full-u64 counts and exact 8/16-byte fault extents.
`make ir-simd-immediate-tests` checks 14,720 immediate-shift fixture pairs,
covering all imm8 values, all XMM destinations at boundary counts, zero-count
EM/TS guards and pre-immediate exception observer PCs.


`make ir-simd-shuffle-tests` checks PSHUFD/LW/HW and SHUFPS/PD using 29,400 fixture
pairs, every imm8 with self/distinct/memory sources, all XMM aliases at representative
controls, exact payloads, complete source-read faults, MMIO destination changes,
and mixed-shuffle SSA chains across cold completion and reentry.

The task-register reference test artifact exports `__stack_pointer` only for
isolating expected terminal host traps. The harness checks normal stack balance
and restores the pre-call host stack after a caught RuntimeError; it retains all
guest-state, callback and partial-fault comparisons. This avoids cumulative stack
exhaustion when compiler-generated frames change.


`make ir-simd-transfer-tests` checks XMM half transfers, MOVD/MOVQ and duplicate
lanes using 5,664 fixture pairs. It verifies exact access widths, GPR SSA bridges,
zero-filled high bits, preserved target halves after MMIO callbacks, high-qword
store capture, faults and mixed-transfer reentry.

`make ir-simd-lane-tests` checks XMM sign masks, word insertion/extraction,
non-temporal stores and LDDQU with independent scalar models and debug/release
CPU comparisons. It exhausts byte/dword/qword sign masks and word immediates,
checks exact two-byte reads, MMIO mutations, faults and native/cold chain reentry.

`make ir-simd-masked-tests` checks MASKMOVDQU through independent byte-selection
models and debug/release CPU execution. It exhausts all masks and verifies
whole-range zero-mask preflight, precise MMIO writes, page-table callback sampling,
partial faults, DI addressing and dirty-XMM completion/reentry.

`make ir-tests` also checks explicit MIR memory plans: guard widths/permissions,
CPU adapter signatures and completion policies, ENTER partial accesses, stale
plans and memory/helper import conflicts. Existing CPU and independent-reference
memory/SIMD suites execute the planned paths.

`make ir-tests` checks lowered MIR effect plans for address adapters, access/SSE
guards and RMW observation/commit phases. It rejects stale plans, unsafe changes,
CPU import shadowing and effect/helper signature conflicts.

`make ir-tests` checks MIR division/CMPXCHG8B plans, including guest quotient
bounds, host-trap protection, implicit CPU slots, full write guards, ZF/count
updates and altered-plan rejection. Existing multiply/divide and CMPXCHG8B
execution suites exercise the migrated paths.

`make ir-tests` checks generic MIR helper call-site plans: CPU/standalone state
observations, typed multi-result staging, caller fault delivery, terminal CPU/REP
outcomes, stale helper tables and orphan arena records. Existing helper/I/O/REP
execution suites exercise these planned calls.

`make ir-tests` checks the lowered MIR dispatcher CFG and typed parallel-copy
scheduler. A symbolic oracle covers 150,207 source mappings; 648 actual Wasm
executions cover critical-edge copies, fanout, aliasing and budget recovery.
Existing i32/i64/v128 loop/edge fixtures use the same schedules.

`make ir-tests` checks selected MIR scalar/value programs and packed kernels,
including machine-stack typing and corrupted-plan rejection. The independent
BigInt oracle executes 17,280 scalar boundary cases; all 57 packed kernels are
selected for register and memory operands. Existing SIMD execution suites use
the same kernel plans.

`make ir-tests` checks MIR state materialization order, count phases and typed
write expressions. Forty-eight modules provide 3,456 CPU/standalone observation
executions across PC modes, raw/lazy ZF, GPR/XMM writes, wrapping and reentry.
RMW checks preserve post-ALU values with pre-write counts; malformed state plans
are rejected.

`make ir-tests` now executes CPU loops with SSA count bases, including before/after
helper observations, caller faults, helper-owned exits and budget reentry. The
independent model checks 7,786 executions, 17,604 observations and 106 bounded
reentries. Static/mixed-count CPU loops remain rejected.

`make ir-cfg-tests` compiles reachable x86 bytecode loops and diamonds at eight
budgets, with optimized/unoptimized GPR/FLAGS/XMM state propagation. It checks
35,328 real CPU comparisons, independent self-loop counts and sixteen precise
second-iteration scalar/vector page faults. Overlap/truncation, graph budgets and
immutable dependency checks are included.

`make ir-tests` checks bounded straight-block merging and explicit MIR budget
polls, including preserved recovery points and malformed poll plans. The CFG
execution suite now also compares 17,664 optimized/unoptimized exits for exact
budget/count/previous-IP equivalence. The merge pass can be disabled independently
through `PassConfig.merge`.

`make ir-tests` also checks dominator GVN, constant branch selection and
unreachable-arena compaction. A 3,072-case independent Wasm oracle covers i32/i64
arithmetic, diamonds and exact budgets. The expanded CFG suite checks 39,936 CPU
comparisons, 19,968 optimized/unoptimized budget exits and sixteen constant
branches that skip absent-page reads. CPU reads, siblings and independent entries
have negative reuse tests.

`make ir-entry-tests` validates compile-request CPU entry specialization in debug
and release: 176 modules, 1,760 no-effect rejections per CPU build, 176 admitted
interpreter comparisons and 32 precise page faults. It covers logical/linear/width
keys, physical aliases, entry-index bounds and rejection before REP metadata or
state/helper effects.

`make ir-live-tests` compiles IR inside the actual experimental CPU Wasm: 44
interpreter comparisons, eight data page faults, 19 read-only paging/capture cases
per debug/release build, and artifact lifecycle tests. It also builds
`build/v86-ir-runtime.wasm` without test hooks and executes live-compiled CFG/store
artifacts there. This target does not select IR in the normal CPU scheduler.

`make ir-cache-tests` publishes live IR results into the shared table pool and runs
them through normal CPU dispatch, in debug and release test-hook builds and in
the normal release core. Tests include precise
fetch/data faults, source/PTE aliases, active SMC and I/O reset, pending/stale/failed
publication, deferred collection and zero-budget REP recovery.

`make ir-auto-tests` enables the experimental automatic policy and checks actual
Tier 1 publication, optimized promotion, 16/32-bit execution and exact loop counts,
failed-input suppression and changed-code retry, failed upgrades retaining Tier 1,
pending/reset/restore lifetimes, premature completion rejection and bounded cache
eviction.

`make ir-backend-integration-tests` selects IR through the public V86 constructor,
checks all region limits and copied statistics, and exercises Tier 1/2 execution,
SMC, x87 interpreter fallback, reset/restore, snapshot restore and initialization
errors on debug and release cores. `make ir-backend-browser-tests` runs
the same scenarios in Chromium's main thread and a real dedicated CPU Worker.
It requires localhost serving and an installed Chromium; the runner uses an isolated
profile.

`make jit-disabled-tests` checks that disabling IR scheduling suppresses promotion
of a published Tier 1 region across 128 CPU frames while it keeps executing, and
that the same entry promotes after scheduling is re-enabled, in debug and release
builds.

`make ir-mir-owned-tests` checks the HIR-to-owned-MIR construction boundary,
corrupt machine types/local ownership, emission after HIR destruction, the
transactional MIR literal pass and optimized compile-request integration. It also
checks that the actual work-budget failure leaves earlier queued rewrites intact.
An independent BigInt oracle executes 12,768 literal Wasm results and 36 real
narrow-register MIR rewrites; `make ir-tests` includes these execution fixtures.
