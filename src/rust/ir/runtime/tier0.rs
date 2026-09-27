//! Runtime support for Tier-0 page functions (ir::tier0).
use crate::cpu::{cpu, global_pointers as gp, memory};

/// The instruction fell through to the expected next instruction.
pub const STEP_NEXT: i32 = 0;
/// EIP moved (taken branch, delivered fault) within the same execution
/// context: the page function may dispatch the new EIP itself.
pub const STEP_DISPATCH: i32 = 1;
/// The context changed (mode, privilege, paging, interrupt flag, halt) or a
/// compiled code page was written: return to the CPU loop.
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
    *gp::previous_ip = *gp::instruction_pointer;
    let Ok(physical) = cpu::get_phys_eip()
    else {
        return STEP_EXIT; // the fetch fault has been delivered
    };
    let opcode = *memory::mem8.add(physical as usize) as i32;
    let key = opcode as usize | (*memory::mem8.add(physical as usize + 1) as usize) << 8;
    STEPS[key] = STEPS[key].wrapping_add(1);
    *gp::instruction_pointer += 1;
    // The page function accounts for the retired instruction itself.
    cpu::run_instruction(opcode | (*gp::is_32 as i32) << 8);
    if *gp::in_hlt || context() != before {
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

/// Whether an access of `bytes` at linear `address` would translate, without
/// any side effect (no A/D bits, TLB fill or fault delivery).
unsafe fn probe(address: u32, bytes: u32, write: bool) -> bool {
    let user = *gp::cpl == 3;
    let translates = |a: u32| cpu::translate_address(a as i32, write, user, false).is_ok();
    translates(address) && ((address & 0xFFF) + bytes <= 0x1000 || translates((address | 0xFFF) + 1))
}
/// Tier-0 read outside the TLB fast path (TLB miss, MMIO, page crossing):
/// `1 << 32` if the access would fault (nothing happened; the page function
/// leaves the instruction to the interpreter), else the value, read with all
/// of the interpreter's effects. `write` probes write permission for RMW.
#[no_mangle]
pub unsafe fn ir_t0_read_slow(address: u32, bytes: u32, write: u32) -> u64 {
    if !probe(address, bytes, write != 0) {
        return 1 << 32;
    }
    let a = address as i32;
    let value = match bytes {
        1 => cpu::safe_read8(a),
        2 => cpu::safe_read16(a),
        _ => cpu::safe_read32s(a),
    };
    match value {
        Ok(v) => v as u32 as u64,
        Err(()) => {
            dbg_assert!(false, "tier-0 probe accepted a faulting read");
            1 << 32
        },
    }
}
/// Tier-0 store outside the fast path: 1 if the interpreter must run the
/// instruction instead (nothing written): the store would fault, or IR code
/// lies on a page it writes (the interpreter then invalidates that code and
/// the page function's step exits). Else the value is written: 0.
#[no_mangle]
pub unsafe fn ir_t0_write_slow(address: u32, value: u32, bytes: u32) -> u32 {
    if !probe(address, bytes, true) {
        return 1;
    }
    let user = *gp::cpl == 3;
    let last = address.wrapping_add(bytes - 1);
    for a in [address, last] {
        let Ok(physical) = cpu::translate_address(a as i32, true, user, false)
        else {
            return 1;
        };
        if crate::jit::jit_page_has_code(crate::page::Page::page_of(physical)) {
            return 1;
        }
    }
    // A page-crossing store goes through memory::write8, which dirties the
    // page unconditionally and so advances the continuation epoch, but the
    // loop above found no IR code on either page: nothing is invalidated.
    let a = address as i32;
    let written = match bytes {
        1 => cpu::safe_write8(a, value as i32),
        2 => cpu::safe_write16(a, value as i32),
        _ => cpu::safe_write32(a, value as i32),
    };
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
