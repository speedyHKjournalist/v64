# IR encoding and lowering coverage

Run `make ir-coverage` for counts and `make ir-generated-check` to validate that
`ir-coverage.json` and the Rust decode catalogue match the source opcode table.
The stable encoding ID is `(opcode << 4) | (fixed_g + 1)`, using zero for an opcode
without a ModRM group. It does not depend on table ordering.

`lowering` is the IR compiler's path for each form (IR is the only compiler;
until the legacy JIT was removed, a separate `experimental_lowering` column held
this while `lowering` tracked the legacy-default build). Of 3,972 coarse forms,
244 explicit invalid reg/mem and missing-group forms are BaselineUD and **none
remain Pending**: each has a native/helper path or explicit baseline behavior,
including baseline unsupported/debug-assert and release-#UD cases. This is a
coarse catalogue milestone, not full prefix/mode/exception acceptance.
Current capabilities are:

| Category | Forms | Contract / evidence |
|---|---:|---|
| NativeHIR | 860 | [Design](ir-design.md), [shifts](ir-shifts.md), [multiply](ir-multiply.md), [bits](ir-bits.md), [exchange](ir-exchange.md), [scalar/BCD](ir-misc.md) |
| CpuSimdHIR | 450 | [Moves](ir-simd-moves.md), [integer arithmetic](ir-simd-integer.md), [packing/shifts](ir-simd-permute.md), [shuffles](ir-simd-shuffle.md), [half/scalar transfers](ir-simd-transfer.md), [word lanes and sign masks](ir-simd-lane.md), [masked stores](ir-simd-masked.md) |
| CpuX87Helper | 320 | [Register F80 helper](ir-x87.md) and [memory/environment adapters](ir-control-fp-increment.md); explicit baseline restrictions, #UD and #NM priority |
| CpuFarControlHelper | 42 | [Far transfers and software interrupts](ir-control-fp-increment.md) |
| CpuFpStateHelper | 8 | [FXSAVE/FXRSTOR and MXCSR](ir-control-fp-increment.md) |
| CpuSseFpHelper | 272 | [SSE FP/conversions and normal-return reload](ir-control-fp-increment.md) |
| CpuMmxHelper | 274 | [MMX arithmetic, transfers and masked stores](ir-control-fp-increment.md) |
| CpuBaselineHelper | 160 | [ARPL/FWAIT/RDRAND/MOVNTI, fences and explicit baseline behavior](ir-control-fp-increment.md) |
| CpuStiHIR | 2 | [STI and indivisible shadow fragments](ir-control-fp-increment.md) |
| CpuMemoryHIR | 644 | [RAM/MMU/RMW](ir-memory.md) and the instruction-family contracts above |
| CpuStackHIR | 156 | [Stack](ir-stack.md), [ENTER](ir-enter.md), [FLAGS/segment stacks](ir-system-stack.md) |
| CpuRepHelper | 84 | [REP HIR and terminal batch ABI](ir-rep.md) |
| CpuInfoHelper | 8 | [CPUID, timestamp and MSR terminal adapters](ir-cpu-info.md) |
| CpuSystemHelper | 12 | [SYSENTER/SYSEXIT, HLT, CLI, CLTS and WBINVD](ir-cpu-system.md) |
| CpuControlRegHelper | 8 | [Control/debug register transfers and mapping changes](ir-control-regs.md) |
| CpuDescriptorHelper | 56 | [Descriptor tables, machine-status word and INVLPG](ir-descriptor.md); includes explicit invalid-register #UD paths |
| CpuTaskRegHelper | 32 | [SLDT/STR, LLDT/LTR and task busy-bit state](ir-task-regs.md) |
| CpuSelectorQueryHelper | 32 | [LAR/LSL and VERR/VERW query, fault and raw-ZF policy](ir-selector-query.md) |
| CpuIoHIR | 36 | [IN/OUT and non-REP INS/OUTS](ir-io.md); contracted device/permission adapters |
| CpuStringHIR | 30 | [Non-REP MOVS/CMPS/STOS/LODS/SCAS](ir-strings.md); repeat forms use CpuRepHelper |
| CpuStateHIR | 48 | [Segment MOV and far pointer loads](ir-segments.md) |
| CpuControlHIR | 28 | [Near control transfers](ir-control.md) |
| CpuArithmeticHIR | 14 | [DIV/IDIV](ir-multiply.md), [AAM](ir-misc.md) |
| TerminalBranchHIR | 152 | [Jcc/JMP design](ir-design.md), [counter branches](ir-loops.md) |

`make ir-default-gate` (and `make ir-coverage-tests`) reject any Pending form, so
a new decoder form must be given a lowering path. No helper coverage is claimed
simply because an old CPU helper or emitter exists.

The forms expand catalogue operand size, address size and reg/mem selectors.
Implicit widths retain the opcode table's fixed-width classification; Rust lowering
selects the actual register fragments. Privilege/mode constraints, LOCK legality,
repeat-prefix combinations, nested x87 subopcodes, runtime feature checks and
helper-specific invalid encodings still need a more complete acceptance matrix.

The `tests` list points to the relevant fixture generator and executable suite
for each implemented family. The coverage check requires attributed paths to
exist. This navigation is not exhaustive per-form proof; actual tested dimensions
and deliberate policies are recorded in the linked contracts and
[validation report](ir-validation.md). Pending forms would carry no test claim;
invalid forms reference the decoder suite.

Decode facts distinguish `fetch_modrm` (the opcode family's fetch before mandatory
prefix dispatch) from `e` (the selected form's EA semantics), retaining the pinned
baseline's invalid-form lengths. Region analysis uses the catalogue's `custom`
attribute to retain helper observer boundaries.

[CMPXCHG8B](ir-cmpxchg8b.md) adds four memory forms with native RAM execution
and ordered CPU slow paths.

The shared interpreter rules, explicit missing groups and expanded acceptance matrix are documented in [the contract increment](ir-contract-matrix.md).
