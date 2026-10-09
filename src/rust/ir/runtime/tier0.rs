//! Runtime support for Tier-0 page functions (ir::tier0).
use crate::cpu::{cpu, global_pointers as gp, memory};

/// The instruction fell through to the expected next instruction.
pub const STEP_NEXT: i32 = 0;
/// EIP moved (taken branch, delivered fault) within the same execution
/// context: the page function may dispatch the new EIP itself.
pub const STEP_DISPATCH: i32 = 1;
/// The context changed (mode, privilege, paging, CR4, interrupt flag, halt),
/// a compiled code page was written or an admission barrier passed (such as
/// XSETBV's): return to the CPU loop.
pub const STEP_EXIT: i32 = 2;

#[derive(PartialEq, Eq)]
struct Context {
    cs_base: i32,
    is_32: bool,
    stack_32: bool,
    cpl: u8,
    control: i32,
    cr0: i32,
    cr3: i32,
    // (the VEX state, which page functions check once per activation;
    // XSETBV's admission barrier advances the epoch)
    cr4: i32,
    state_flags: u32,
    epoch: u64,
}
unsafe fn context() -> Context {
    Context {
        cs_base: cpu::get_seg_cs(),
        is_32: *gp::is_32,
        stack_32: *gp::stack_size_32,
        cpl: *gp::cpl,
        control: *gp::flags & (cpu::FLAG_INTERRUPT | cpu::FLAG_TRAP | cpu::FLAG_VM),
        cr0: *gp::cr,
        cr3: *gp::cr.add(3),
        cr4: *gp::cr.add(4),
        // Flat segmentation: page functions may be specialized for it.
        state_flags: (*gp::state_flags).to_u32(),
        epoch: super::entry::continuation_epoch(),
    }
}

/// Interpret exactly one instruction at EIP, as the interpreter loop does, and
/// classify how the page function may continue. `expected_next` is the linear
/// address after the instruction.
#[no_mangle]
pub unsafe fn ir_t0_step(expected_next: u32) -> i32 {
    let before = context();
    let counter_before = *gp::instruction_counter;
    *gp::previous_ip = *gp::instruction_pointer;
    let Ok(physical) = cpu::get_phys_eip()
    else {
        crate::cpu::execution::note_jit_interpreted(1);
        return STEP_EXIT; // the fetch fault has been delivered
    };
    let opcode = *memory::mem8.add(physical as usize) as i32;
    let key = opcode as usize | (*memory::mem8.add(physical as usize + 1) as usize) << 8;
    STEPS[key] = STEPS[key].wrapping_add(1);
    *gp::instruction_pointer += 1;
    // The page function accounts for the retired instruction itself.
    crate::cpu::execution::begin_instruction();
    held(|| cpu::run_instruction(opcode | (*gp::is_32 as i32) << 8));
    crate::cpu::execution::finish_instruction();
    crate::cpu::execution::note_jit_interpreted(
        (*gp::instruction_counter)
            .wrapping_sub(counter_before)
            .wrapping_add(1),
    );
    // An interrupt this instruction or an earlier held access of the
    // activation made deliverable is delivered at this boundary, and the
    // page function leaves.
    if crate::cpu::execution::deliver_held_irqs()
        || *gp::in_hlt
        || cpu::core_yield
        || crate::cpu::apic::has_core_events()
        || context() != before
    {
        STEP_EXIT
    }
    else if *gp::instruction_pointer as u32 == expected_next {
        STEP_NEXT
    }
    else {
        STEP_DISPATCH
    }
}

/// Jcc condition `cc` (0..15) over the lazy FLAGS state, for templates whose
/// FLAGS producer is not known statically.
#[no_mangle]
pub unsafe fn ir_t0_condition(cc: u32) -> u32 {
    use crate::cpu::misc_instr::*;
    let base = match cc >> 1 {
        0 => test_o(),
        1 => test_b(),
        2 => test_z(),
        3 => test_be(),
        4 => test_s(),
        5 => test_p(),
        6 => test_l(),
        _ => test_le(),
    };
    (base != (cc & 1 != 0)) as u32
}

/// The operands of ir_t0_sse_fp: the destination (replaced by the result)
/// and the source, written by the page function (ir_t0_fma's: the
/// destination, the first source and the third)
#[repr(C, align(16))]
pub struct SseFpOperands(pub [u128; 3]);
pub static mut T0_SSE_FP: SseFpOperands = SseFpOperands([0; 3]);
/// Address of T0_SSE_FP for generated code
pub fn sse_fp_operands() -> u32 { (&raw const T0_SSE_FP) as u32 }

/// SSE floating point exactly (cpu::simd_fp), for the native templates'
/// refused instructions, on T0_SSE_FP: `key` is the catalogue key and
/// `imm8` CMPPS' predicate; the result (for conversions to an integer and
/// COMISS, the integer or the EFLAGS bits) replaces the destination and
/// MXCSR's flags are updated. 1 if the instruction faults: only MXCSR's
/// flags are set, as the interpreter, which delivers the fault, sets them
/// again; else 0.
#[no_mangle]
pub unsafe fn ir_t0_sse_fp(key: u32, imm8: u32) -> u32 {
    use crate::cpu::simd_fp;
    SSE_FP_CALLS[(key as usize).wrapping_mul(0x9E37_79B9) >> 24 & 255] += 1;
    let [destination, source, _] = T0_SSE_FP.0;
    let result = match key {
        // ROUNDPS/PD/SS/SD (SSE4.1)
        0x660F3A08..=0x660F3A0B => simd_fp::round(key, destination, source, imm8 as u8),
        _ => match key as u8 {
            0x52 | 0x53 => Ok(simd_fp::reciprocal(key, destination, source)),
            0x2E | 0x2F => simd_fp::compare_flags(key, destination, source).map(u128::from),
            // (the predicate: imm8[2:0], VEX imm8[4:0])
            0xC2 => simd_fp::compare(key, destination, source, imm8 as u8),
            0x2A | 0x2C | 0x2D | 0x5A | 0x5B | 0xE6 => {
                simd_fp::convert(key, false, destination, source)
            },
            _ => simd_fp::arithmetic(key, destination, source, imm8 as u8),
        },
    };
    match result {
        Ok(result) => {
            T0_SSE_FP.0[0] = result;
            0
        },
        Err(simd_fp::Unmasked) => 1,
    }
}

/// FMA's VEX.128 and scalar forms exactly (cpu::simd_fp::fused), for the
/// templates of Tier-0 and the x64 page tier, on T0_SSE_FP (the destination,
/// the first source and the r/m operand): `op` is the opcode byte, bit 8
/// VEX.W. The result replaces the destination and MXCSR's flags are
/// updated. 1 if the instruction faults: only MXCSR's flags are set, as the
/// interpreter, which delivers the fault, sets them again; else 0.
#[no_mangle]
pub unsafe fn ir_t0_fma(op: u32) -> u32 {
    FMA_CALLS = FMA_CALLS.wrapping_add(1);
    let [destination, first, third] = T0_SSE_FP.0;
    match crate::cpu::simd_fp::fused(op as u8, op & 0x100 != 0, [destination], [first], [third]) {
        Ok([result]) => {
            T0_SSE_FP.0[0] = result;
            0
        },
        Err(crate::cpu::simd_fp::Unmasked) => 1,
    }
}

/// PCMPESTRM/PCMPESTRI/PCMPISTRM/PCMPISTRI (`op`: the 66 0F 3A byte) with
/// imm8 on T0_SSE_FP (destination, source), the explicit forms' lengths `a`
/// and `b` (cpu::simd_int::compare_strings): xSTRM's mask replaces the
/// destination; returns the index | EFLAGS (CF, ZF, SF, OF) << 8. For the
/// templates of Tier-0 and the x64 page tier.
pub unsafe fn pcmpstr(op: u32, imm8: u32, a: i64, b: i64) -> u32 {
    let [destination, source, _] = T0_SSE_FP.0;
    let explicit = op & 2 == 0;
    let result = crate::cpu::simd_int::compare_strings(
        imm8 as u8,
        destination.to_le_bytes(),
        source.to_le_bytes(),
        explicit.then_some(a),
        explicit.then_some(b),
    );
    T0_SSE_FP.0[0] = u128::from_le_bytes(result.xmm0);
    result.index | (result.flags as u32) << 8
}
#[no_mangle]
pub unsafe fn ir_t0_pcmpstr(op: u32, imm8: u32, eax: i32, edx: i32) -> u32 {
    pcmpstr(op, imm8, eax as i64, edx as i64)
}

/// ir_t0_sse_fp's calls by a hash of the catalogue key (a diagnostic of
/// refused native floating point, see ir_t0_sse_fp_calls)
static mut SSE_FP_CALLS: [u32; 256] = [0; 256];
/// The exact-path calls of the form whose catalogue key is `key` (shared
/// with the keys of the same hash)
#[no_mangle]
pub unsafe fn ir_t0_sse_fp_calls(key: u32) -> u32 {
    SSE_FP_CALLS[(key as usize).wrapping_mul(0x9E37_79B9) >> 24 & 255]
}
#[no_mangle]
pub unsafe fn ir_t0_sse_fp_calls_reset() { SSE_FP_CALLS = [0; 256]; }
/// ir_t0_fma's calls: the FMA instructions the templates did not compute
/// natively (see relaxed_fma)
static mut FMA_CALLS: u32 = 0;
#[no_mangle]
pub unsafe fn ir_t0_fma_calls() -> u32 { FMA_CALLS }
#[no_mangle]
pub unsafe fn ir_t0_fma_calls_reset() { FMA_CALLS = 0; }

/// Interpreter steps by their first two instruction bytes (a diagnostic of
/// missing templates, see tests/bench/run.mjs --fallbacks).
static mut STEPS: [u32; 0x10000] = [0; 0x10000];
#[no_mangle]
pub unsafe fn ir_t0_steps(key: u32) -> u32 { STEPS[key as usize & 0xFFFF] }
#[no_mangle]
pub unsafe fn ir_t0_steps_reset() { STEPS = [0; 0x10000]; }

static mut COMPILED: [u64; 5] = [0; 5];
/// Emitted template bytes and counts by Form kind (the last: fallbacks).
static mut TEMPLATES: [(u64, u64); 64] = [(0, 0); 64];
pub fn note_template(kind: usize, bytes: usize) {
    unsafe {
        let t = &mut TEMPLATES[kind.min(63)];
        t.0 += bytes as u64;
        t.1 += 1;
    }
}
/// (bytes, count) of Form kind `kind`, or 0 past the table.
#[no_mangle]
pub unsafe fn ir_t0_template_stat(kind: u32, count: u32) -> u32 {
    let table = TEMPLATES;
    let t = table.get(kind as usize).copied().unwrap_or((0, 0));
    (if count != 0 { t.1 } else { t.0 }) as u32
}
/// Compile statistics: page functions, instructions, templated instructions,
/// bytes, pages covered.
pub fn note_compiled(instructions: usize, templated: usize, bytes: usize, pages: usize) {
    unsafe {
        COMPILED[4] += pages as u64;
        COMPILED[0] += 1;
        COMPILED[1] += instructions as u64;
        COMPILED[2] += templated as u64;
        COMPILED[3] += bytes as u64;
    }
}
/// Compile statistic `field` (see COMPILED); field 5: whether Tier-0 is on.
#[no_mangle]
pub unsafe fn ir_t0_stat(field: u32) -> u32 {
    if field == 5 {
        return super::schedule::tier0() as u32;
    }
    let values = COMPILED;
    values.get(field as usize).map_or(0, |v| *v as u32)
}

/// P3.0b's emergency switch (ir_t0_irq_deferral, on by default). On, page
/// functions leave accesses to devices that may interrupt to ir_t0_step,
/// which delivers the interrupt after the instruction, and hold delivery in
/// the other slow-path accesses and in steps (held). Off, as before: a
/// device access in a slow path can deliver an interrupt in the middle of
/// the instruction, with the GPRs and EIP still in the page function's
/// locals.
static mut T0_IRQ_DEFERRAL: bool = true;
pub fn irq_deferral() -> bool { unsafe { T0_IRQ_DEFERRAL } }
pub unsafe fn set_irq_deferral(on: bool) { T0_IRQ_DEFERRAL = on; }
/// Run a device access or an interpreted instruction of a page function
/// with interrupt delivery held (cpu::execution::hold_irqs): a deliverable
/// one is delivered at the next instruction boundary, where the page
/// function leaves (ir_t0_step, cache::execute).
#[inline(always)]
unsafe fn held<T>(access: impl FnOnce() -> T) -> T {
    if T0_IRQ_DEFERRAL {
        crate::cpu::execution::hold_irqs(access)
    }
    else {
        access()
    }
}

/// The physical addresses of the first and the last byte of an access of
/// `bytes` at linear `address` if it would translate, without any side
/// effect (no A/D bits, TLB fill or fault delivery).
unsafe fn probe(address: u32, bytes: u32, write: bool) -> Option<[u32; 2]> {
    let user = *gp::cpl == 3;
    let translate = |a: u32| cpu::translate_address(a as i32, write, user, false).ok();
    let first = translate(address)?;
    let last = address.wrapping_add(bytes - 1);
    let last = if (address & 0xFFF) + bytes <= 0x1000 {
        first.wrapping_add(bytes - 1)
    }
    else {
        translate(last)?
    };
    Some([first, last])
}
/// probe, None also for an access the interpreter must make: it reaches a
/// device that may raise or unmask an interrupt (memory::may_interrupt), so
/// that ir_t0_step delivers it at the instruction boundary (P3.0b)
unsafe fn probe_ram(address: u32, bytes: u32, write: bool) -> Option<[u32; 2]> {
    let physical = probe(address, bytes, write)?;
    if T0_IRQ_DEFERRAL && physical.iter().any(|&p| memory::may_interrupt(p)) {
        return None;
    }
    Some(physical)
}
/// Tier-0 read outside the TLB fast path (TLB miss, MMIO, page crossing):
/// `1 << 32` if the interpreter must make it (nothing happened; the page
/// function leaves the instruction to ir_t0_step): the access would fault,
/// or it reaches a device that may interrupt. Else the value, read with all
/// of the interpreter's effects. `write` probes write permission for RMW.
#[no_mangle]
pub unsafe fn ir_t0_read_slow(address: u32, bytes: u32, write: u32) -> u64 {
    if probe_ram(address, bytes, write != 0).is_none() {
        return 1 << 32;
    }
    let a = address as i32;
    let value = held(|| match bytes {
        1 => cpu::safe_read8(a),
        2 => cpu::safe_read16(a),
        _ => cpu::safe_read32s(a),
    });
    match value {
        Ok(v) => v as u32 as u64,
        Err(()) => {
            dbg_assert!(false, "tier-0 probe accepted a faulting read");
            1 << 32
        },
    }
}
/// Tier-0 store outside the fast path: 1 if the interpreter must run the
/// instruction instead (nothing written): the store would fault, it reaches
/// a device that may interrupt, or IR code lies on a page it writes (the
/// interpreter then invalidates that code and the page function's step
/// exits). Else the value is written: 0.
#[no_mangle]
pub unsafe fn ir_t0_write_slow(address: u32, value: u32, bytes: u32) -> u32 {
    let Some(physical) = probe_ram(address, bytes, true)
    else {
        return 1;
    };
    if physical
        .iter()
        .any(|&p| crate::jit::jit_page_has_code(crate::page::Page::page_of(p)))
    {
        return 1;
    }
    // A page-crossing store goes through memory::write8, which dirties the
    // page unconditionally and so advances the continuation epoch, but the
    // check above found no IR code on either page: nothing is invalidated.
    let a = address as i32;
    let written = held(|| match bytes {
        1 => cpu::safe_write8(a, value as i32),
        2 => cpu::safe_write16(a, value as i32),
        _ => cpu::safe_write32(a, value as i32),
    });
    dbg_assert!(written.is_ok(), "tier-0 probe accepted a faulting write");
    0
}

/// How a page function leaving its page continues in the next page's
/// function: by returning to the loop in t0_execute (Iterative), by a
/// nested call (Nested, ir_t0_chain), or by a Wasm tail call from the page
/// function itself (Tail, ir_t0_link; needs engine support, see
/// ir_t0_set_tail_calls). Page functions are emitted for the mode current
/// at compile time; the helpers decline in any other mode.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Link {
    Iterative,
    Nested,
    Tail,
}
static mut T0_LINK: Link = Link::Iterative;
static mut T0_TAIL_CALLS: bool = false;
pub fn t0_link() -> Link { unsafe { T0_LINK } }
/// Whether the engine has Wasm tail calls (ir_t0_set_tail_calls, src/cpu.js)
pub fn tail_calls() -> bool { unsafe { T0_TAIL_CALLS } }
/// Whether the host engine validates Wasm tail calls and passes its
/// function table to generated modules as ("e", "t"). Tail linking is not
/// the default: in V8 a cross-instance return_call_indirect costs more than
/// returning to t0_execute's loop.
#[no_mangle]
pub unsafe fn ir_t0_set_tail_calls(supported: u32) -> bool {
    if supported > 1 {
        return false;
    }
    T0_TAIL_CALLS = supported == 1;
    if !T0_TAIL_CALLS && T0_LINK == Link::Tail {
        T0_LINK = Link::Iterative;
    }
    true
}
/// Whether the host engine has Wasm relaxed SIMD and its multiply-adds fuse
/// (cpu.js relaxed_fma_fused, at startup)
static mut RELAXED_FMA_FUSED: bool = false;
/// Whether Tier-0 and the x64 page tier compute FMA with them
/// (native_fp::fused): where they fuse, unless switched off. Code compiled
/// before a change keeps its path; both are exact.
static mut RELAXED_FMA: bool = false;
pub fn relaxed_fma() -> bool { unsafe { RELAXED_FMA } }
#[no_mangle]
pub unsafe fn ir_relaxed_fma_fused(fused: u32) {
    RELAXED_FMA_FUSED = fused == 1;
    RELAXED_FMA = RELAXED_FMA_FUSED;
}
/// A/B switch: 0 the exact helper, 1 relaxed multiply-adds (if they fuse)
#[no_mangle]
pub unsafe fn ir_set_relaxed_fma(on: u32) -> bool {
    if on > 1 || on == 1 && !RELAXED_FMA_FUSED {
        return false;
    }
    RELAXED_FMA = on == 1;
    true
}
#[no_mangle]
pub unsafe fn ir_relaxed_fma() -> u32 { RELAXED_FMA as u32 }
/// A/B switch: 0 iterative, 1 nested, 2 tail (if supported).
#[no_mangle]
pub unsafe fn ir_t0_set_link_mode(mode: u32) -> bool {
    T0_LINK = match mode {
        0 => Link::Iterative,
        1 => Link::Nested,
        2 if T0_TAIL_CALLS => Link::Tail,
        _ => return false,
    };
    true
}
