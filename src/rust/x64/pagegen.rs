//! x64 page tier: one Wasm function per 4 KiB page of long-mode code.
//!
//! The function serves every compiled block start of its page. A dispatch
//! loop branches (br_table over the page offset) to a block; blocks continue
//! into each other without returning to the CPU loop. The 16 GPRs, EFLAGS
//! and RIP live in locals and are written back at every exit and around
//! interpreter steps, so memory is authoritative whenever Rust code runs.
//!
//! Templates cover the frequent integer forms. Everything else, and any
//! template precondition that fails at run time, has the wide interpreter's
//! exact behavior:
//! - step: the instruction is interpreted in place by `x64_page_step`, then
//!   the function dispatches on the new RIP (or returns if the step changed
//!   the execution context).
//! - retry: a memory access missing the access cache (x64::jac) that
//!   `x64_page_access` cannot serve (fault, device, page with compiled code,
//!   page crossing) leaves the function with RIP at the instruction and none
//!   of its effects; the runtime interprets it.
//! EFLAGS arithmetic bits are only computed where a later reader can observe
//! them (page-local liveness; exits and steps read all of them). Condition
//! consumers after CMP/SUB/TEST-like producers in the same block compare the
//! producer's operands directly.
use super::decode::{self, AddressBase, AddressExpr, ByteRegister, Decoded};
use super::jac;
use super::state::{gpr_high_offset, gpr_low_offset, ExecutionMode, GuestIp};
use crate::cpu::global_pointers as gp;
use crate::wasmgen::wasm_builder::{
    Label, Signature, WasmBuilder, WasmLocal, WasmLocalI64, WasmLocalV128, WasmType,
};
use crate::wasmgen::wasm_opcodes as op;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// x64_pagegen_size_stats: Wasm bytes emitted per template kind (count,
/// bytes), for code size work
static mut SIZE_STATS: Option<HashMap<String, (u64, u64)>> = None;
fn size_note(name: String, bytes: usize) {
    unsafe {
        if let Some(stats) = (*(&raw mut SIZE_STATS)).as_mut() {
            let entry = stats.entry(name).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += bytes as u64;
        }
    }
}
#[no_mangle]
pub fn x64_pagegen_size_stats(enabled: bool) { unsafe { SIZE_STATS = enabled.then(HashMap::new) }; }
#[no_mangle]
pub fn x64_pagegen_size_dump() {
    unsafe {
        if let Some(stats) = (*(&raw const SIZE_STATS)).as_ref() {
            let mut rows: Vec<_> = stats.iter().collect();
            rows.sort_by_key(|(_, &(_, bytes))| std::cmp::Reverse(bytes));
            let total: u64 = rows.iter().map(|(_, &(_, b))| b).sum();
            for (name, &(count, bytes)) in rows.iter().take(40) {
                console_log!(
                    "X64_PAGEGEN_SIZE {} count {} bytes {} ({:.1}%) avg {:.1}",
                    name,
                    count,
                    bytes,
                    100.0 * bytes as f64 / total as f64,
                    bytes as f64 / count as f64
                );
            }
        }
    }
}

/// Why a page function returned (gp::x64_page_exit).
pub const EXIT_NORMAL: u32 = 0;
/// Interpret the instruction at RIP: a template precondition failed before
/// any of its effects.
pub const EXIT_RETRY: u32 = 1;
/// RIP is inside the page but not a compiled block start.
pub const EXIT_UNKNOWN: u32 = 2;
/// x64_page_step results.
pub const STEP_CONTINUE: i32 = 0;
pub const STEP_EXIT: i32 = 2;

const PAGE: usize = 4096;
/// Decoded instructions per page function, including overlapping decodes.
const MAX_INSTRUCTIONS: usize = 3072;

const CF: u32 = 1;
const PF: u32 = 4;
const AF: u32 = 0x10;
const ZF: u32 = 0x40;
const SF: u32 = 0x80;
const OF: u32 = 0x800;
const ARITH: u32 = CF | PF | AF | ZF | SF | OF;

fn mask(w: u8) -> u64 {
    if w == 64 {
        u64::MAX
    }
    else {
        (1u64 << w) - 1
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Reg {
    index: u8,
    /// AH, CH, DH or BH (no REX)
    high: bool,
}
#[derive(Clone, Copy, Debug)]
enum Opnd {
    Reg(Reg),
    Mem(AddressExpr),
    Imm(u64),
}
impl Opnd {
    fn reg(self) -> Option<Reg> {
        if let Opnd::Reg(r) = self {
            Some(r)
        }
        else {
            None
        }
    }
}
/// An XMM register (0..15) or a memory operand of an SSE instruction.
#[derive(Clone, Copy, Debug)]
enum Xmm {
    Reg(u8),
    Mem(AddressExpr),
}
#[derive(Clone, Copy, Debug)]
enum Op {
    /// ADD OR ADC SBB AND SUB XOR CMP (x86 /digit order)
    Alu {
        code: u8,
        width: u8,
        dst: Opnd,
        src: Opnd,
    },
    Test {
        width: u8,
        a: Opnd,
        b: Opnd,
    },
    Mov {
        width: u8,
        dst: Opnd,
        src: Opnd,
    },
    Extend {
        width: u8,
        from: u8,
        signed: bool,
        dst: Reg,
        src: Opnd,
    },
    Lea {
        width: u8,
        dst: Reg,
        address: AddressExpr,
    },
    IncDec {
        dec: bool,
        width: u8,
        dst: Opnd,
    },
    Neg {
        width: u8,
        dst: Opnd,
    },
    Not {
        width: u8,
        dst: Opnd,
    },
    /// ROL ROR - - SHL SHR SAL SAR; `count` None is CL.
    Shift {
        code: u8,
        width: u8,
        dst: Opnd,
        count: Option<u8>,
    },
    /// Shifts and rotates without a template (8/16-bit by CL, RCL/RCR up to
    /// 32 bits): the interpreter's semantics through x64_page_shift
    ShiftCall {
        code: u8,
        width: u8,
        dst: Opnd,
        count: Option<u8>,
    },
    Imul {
        width: u8,
        dst: Reg,
        a: Opnd,
        b: Opnd,
    },
    MulWide {
        signed: bool,
        width: u8,
        src: Opnd,
    },
    Push {
        src: Opnd,
    },
    Pop {
        dst: Reg,
    },
    Pushf,
    Leave,
    Call {
        target: u64,
    },
    CallIndirect {
        src: Opnd,
    },
    Ret {
        pop: u16,
    },
    Jmp {
        target: u64,
    },
    JmpIndirect {
        src: Opnd,
    },
    Jcc {
        cc: u8,
        target: u64,
    },
    Cmov {
        cc: u8,
        width: u8,
        dst: Reg,
        src: Opnd,
    },
    Setcc {
        cc: u8,
        dst: Opnd,
    },
    Xchg {
        width: u8,
        a: Opnd,
        b: Reg,
    },
    Xadd {
        width: u8,
        dst: Opnd,
        src: Reg,
    },
    Cmpxchg {
        width: u8,
        dst: Opnd,
        src: Reg,
    },
    /// CBW/CWDE/CDQE
    SignAcc {
        width: u8,
    },
    /// CWD/CDQ/CQO
    SignDx {
        width: u8,
    },
    /// BT BTS BTR BTC
    Bt {
        action: u8,
        width: u8,
        dst: Opnd,
        index: Opnd,
    },
    BitScan {
        reverse: bool,
        width: u8,
        dst: Reg,
        src: Opnd,
    },
    Popcnt {
        width: u8,
        dst: Reg,
        src: Opnd,
    },
    Bswap {
        width: u8,
        reg: u8,
    },
    /// CMC CLC STC CLD STD by opcode
    Flag {
        opcode: u8,
    },
    Lahf,
    Sahf,
    Nop,
    Cli,
    /// STI ends the activation: the next instruction runs in the interrupt
    /// shadow in the interpreter.
    Sti,
    Swapgs,
    Rdtsc,
    /// DIV/IDIV r/m32/64 whose quotient fits (else retried: #DE or a wide
    /// dividend).
    Div {
        signed: bool,
        width: u8,
        src: Opnd,
    },
    /// MOVS/STOS with 64-bit addresses and no FS/GS source; with REP only
    /// inside one page per operand, forward, RAX 0 for wide STOS.
    Movs {
        width: u8,
        rep: bool,
    },
    Stos {
        width: u8,
        rep: bool,
    },
    /// REPE/REPNE CMPS (SCAS: `scan`) with 64-bit addresses and no FS/GS
    /// source: natively inside one page per operand, forward (else a step)
    RepCompare {
        width: u8,
        scan: bool,
        equal: bool,
    },
    MovSreg {
        segment: u8,
        width: u8,
        dst: Opnd,
    },
    /// SHLD/SHRD r/m32/64, r, imm8
    DoubleShift {
        left: bool,
        width: u8,
        dst: Opnd,
        src: Reg,
        count: u8,
    },
    /// CMPXCHG16B (wide) / CMPXCHG8B
    CompareExchange {
        wide: bool,
        address: AddressExpr,
    },
    /// SSE moves of the low `bits` (32, 64 or 128). Register destinations
    /// keep their other bits unless `zero` (always for 32/64-bit loads);
    /// `aligned` memory operands must be 16-byte aligned (else #GP, retried).
    Vmove {
        bits: u8,
        dst: Xmm,
        src: Xmm,
        aligned: bool,
        zero: bool,
    },
    /// 128-bit AND ANDN OR XOR (PS/PD/integer forms); memory is aligned.
    Vlogic {
        code: u8,
        dst: u8,
        src: Xmm,
    },
    /// ADD MUL SUB DIV (`code` 0x58 0x59 0x5C 0x5E) of single or double
    /// precision lanes: packed (memory aligned) or scalar (the low lane;
    /// the others keep their bits). See Emitter::vfp for when it runs natively.
    Vfp {
        code: u8,
        double: bool,
        packed: bool,
        dst: u8,
        src: Xmm,
    },
    /// MOVD/MOVQ xmm, r/m32/64 (upper bits cleared)
    MovdIn {
        width: u8,
        dst: u8,
        src: Opnd,
    },
    /// MOVD/MOVQ r/m32/64, xmm
    MovdOut {
        width: u8,
        dst: Opnd,
        src: u8,
    },
    /// SSE2 packed integer, shuffle and unpack forms with Wasm SIMD (the
    /// semantics of cpu::sse_instr, as ir::tier0::simd): dst = op(dst, src).
    /// Memory sources are 128 bits and must be aligned (else #GP, retried).
    Vpacked {
        op: Packed,
        dst: u8,
        src: Xmm,
    },
    /// PSRLW/D/Q PSRAW/D PSLLW/D/Q xmm, imm8 (`kind` is the ModRM reg), and
    /// PSRLDQ/PSLLDQ (`bits` 128)
    VshiftImm {
        dst: u8,
        bits: u8,
        kind: u8,
        count: u8,
    },
    /// COMISS UCOMISS COMISD UCOMISD: natively when neither operand is a NaN
    /// or a denormal, which leaves MXCSR unchanged; else retried.
    Vcompare {
        double: bool,
        dst: u8,
        src: Xmm,
    },
    /// INVLPG m (CPL 0; see pages::x64_page_invlpg)
    Invlpg {
        address: AddressExpr,
    },
    /// LDMXCSR (`load`) / STMXCSR m32
    Mxcsr {
        load: bool,
        address: AddressExpr,
    },
    /// MOV r64, CR0/CR2/CR3/CR4 (CPL 0)
    ReadCr {
        control: u8,
        reg: Reg,
    },
    /// MOV r64, CR8 / MOV CR8, r64 (the local APIC's TPR)
    Cr8 {
        write: bool,
        reg: Reg,
    },
    Rdtscp,
    /// Interpreted in place by x64_page_step.
    Step,
}

/// Packed operations of Op::Vpacked (Wasm SIMD opcodes).
#[derive(Clone, Copy, Debug)]
enum Packed {
    /// i8x16.shuffle over (destination, source)
    Shuffle([u8; 16]),
    /// i8x16.shuffle over (destination, zero)
    ShuffleZero([u8; 16]),
    /// PSHUFB: the destination's bytes by the source's indices (bit 7 selects zero)
    Swizzle,
    Binary(u32),
    /// element bytes, high halves
    Unpack(u8, bool),
    Pack(u32),
    /// Shift by the source's low quadword: (opcode, lane bits, arithmetic).
    Shift(u32, u32, bool),
    MulHigh(bool),
    MulDwords,
    Sad,
}
/// 66 0F `code` packed integer forms.
fn packed_op(code: u8) -> Option<Packed> {
    Some(match code {
        0xFC => Packed::Binary(0x6E),
        0xFD => Packed::Binary(0x8E),
        0xFE => Packed::Binary(0xAE),
        0xD4 => Packed::Binary(0xCE),
        0xF8 => Packed::Binary(0x71),
        0xF9 => Packed::Binary(0x91),
        0xFA => Packed::Binary(0xB1),
        0xFB => Packed::Binary(0xD1),
        0xEC => Packed::Binary(0x6F),
        0xED => Packed::Binary(0x8F),
        0xDC => Packed::Binary(0x70),
        0xDD => Packed::Binary(0x90),
        0xE8 => Packed::Binary(0x72),
        0xE9 => Packed::Binary(0x92),
        0xD8 => Packed::Binary(0x73),
        0xD9 => Packed::Binary(0x93),
        0x64 => Packed::Binary(0x27),
        0x65 => Packed::Binary(0x31),
        0x66 => Packed::Binary(0x3B),
        0x74 => Packed::Binary(0x23),
        0x75 => Packed::Binary(0x2D),
        0x76 => Packed::Binary(0x37),
        0xDA => Packed::Binary(0x77),
        0xDE => Packed::Binary(0x79),
        0xEA => Packed::Binary(0x96),
        0xEE => Packed::Binary(0x98),
        0xE0 => Packed::Binary(0x7B),
        0xE3 => Packed::Binary(0x9B),
        0xE4 => Packed::MulHigh(false),
        0xE5 => Packed::MulHigh(true),
        0xF4 => Packed::MulDwords,
        0xF6 => Packed::Sad,
        0xD5 => Packed::Binary(0x95),
        0xF5 => Packed::Binary(0xBA),
        0x60 => Packed::Unpack(1, false),
        0x61 => Packed::Unpack(2, false),
        0x62 => Packed::Unpack(4, false),
        0x68 => Packed::Unpack(1, true),
        0x69 => Packed::Unpack(2, true),
        0x6A => Packed::Unpack(4, true),
        0x6C => Packed::Unpack(8, false),
        0x6D => Packed::Unpack(8, true),
        0x63 => Packed::Pack(0x65),
        0x67 => Packed::Pack(0x66),
        0x6B => Packed::Pack(0x85),
        0xD1 => Packed::Shift(0x8D, 16, false),
        0xD2 => Packed::Shift(0xAD, 32, false),
        0xD3 => Packed::Shift(0xCD, 64, false),
        0xE1 => Packed::Shift(0x8C, 16, true),
        0xE2 => Packed::Shift(0xAC, 32, true),
        0xF1 => Packed::Shift(0x8B, 16, false),
        0xF2 => Packed::Shift(0xAB, 32, false),
        0xF3 => Packed::Shift(0xCB, 64, false),
        _ => return None,
    })
}
/// Lanes of PSHUFD/PSHUFLW/PSHUFHW/SHUFPS/SHUFPD over (destination, source)
/// for i8x16.shuffle.
fn shuffle_lanes(op: u32, imm: u32) -> [u8; 16] {
    let mut lanes = [0; 16];
    for i in 0..16u32 {
        lanes[i as usize] = match op {
            0x660F70 => 16 + ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4),
            0xF20F70 if i < 8 => 16 + ((imm >> (2 * (i / 2)) & 3) * 2 + i % 2),
            0xF30F70 if i >= 8 => 16 + (8 + (imm >> (2 * ((i - 8) / 2)) & 3) * 2 + i % 2),
            0xF20F70 | 0xF30F70 => 16 + i,
            0x0FC6 => (imm >> (2 * (i / 4)) & 3) * 4 + i % 4 + if i >= 8 { 16 } else { 0 },
            0x660FC6 => (imm >> (i / 8) & 1) * 8 + i % 8 + if i >= 8 { 16 } else { 0 },
            _ => unreachable!(),
        } as u8;
    }
    lanes
}

/// PALIGNR xmm, xmm/m128, imm8 (simd_int::palignr_lanes)
fn palignr(imm8: u64) -> Packed {
    match crate::cpu::simd_int::palignr_lanes(imm8.min(255) as u8, 16) {
        (lanes, true) => Packed::ShuffleZero(lanes),
        (lanes, false) => Packed::Shuffle(lanes),
    }
}

fn register(encoded: u8, width: u8, rex: bool) -> Reg {
    if width == 8 {
        match decode::byte_register(encoded, rex) {
            ByteRegister::Low(index) => Reg { index, high: false },
            ByteRegister::HighLegacy(index) => Reg { index, high: true },
        }
    }
    else {
        Reg {
            index: encoded,
            high: false,
        }
    }
}

/// Branch target relative to the page (decoded at linear address 0; see
/// compile). Whether it is canonical depends on where the page runs.
fn relative(d: &Decoded) -> Option<u64> {
    let i = d.immediate?;
    let displacement =
        if i.encoded_bytes == 1 { i.value as i8 as i64 } else { i.value as i32 as i64 };
    Some(d.next.0.wrapping_add(displacement as u64))
}

/// The template for a long-mode instruction, or Step. Mirrors
/// x64::execute::execute; anything it does not cover exactly is a Step.
fn classify(d: &Decoded) -> Op {
    if !d.mode.is_long() {
        return Op::Step;
    }
    let op = d.base_opcode();
    let w = d.operand_size;
    let rex = d.prefixes.rex.is_some();
    let group = d.modrm.map_or(0, |m| m >> 3 & 7);
    let imm = d.immediate.map(|i| i.value);
    let memory = d.rm_register.is_none() && d.address.is_some();
    let reg = |r: u8, width: u8| register(r, width, rex);
    let rm = |width: u8| -> Option<Opnd> {
        match d.rm_register {
            Some(r) => Some(Opnd::Reg(reg(r, width))),
            None => d.address.map(Opnd::Mem),
        }
    };
    // REP/REPNE are ignored by these forms in the interpreter (or select
    // their catalog entry); anything else with REP is a step.
    let rep_ok = matches!(op, 0xC2 | 0xC3 | 0xE8 | 0xE9 | 0xEB | 0x70..=0x7F | 0x0F80..=0x0F8F | 0x0FB8 | 0x0FBC | 0x0FBD | 0x0F1E | 0xA4..=0xA7 | 0xAA..=0xAF)
        || op == 0xFF && matches!(group, 2 | 4)
        // F3/F2 that select an SSE instruction are not repeat prefixes
        || matches!(d.opcode >> 16, 0xF2 | 0xF3);
    if d.prefixes.rep.is_some() && !rep_ok {
        return Op::Step;
    }
    // The decoder accepts LOCK only on memory read-modify-write forms.
    let lock_ok = memory
        && match op {
            0x00..=0x3D => op & 7 <= 1 && op >> 3 != 7,
            0x80 | 0x81 | 0x83 => group != 7,
            0xFE | 0xFF => group <= 1,
            0xF6 | 0xF7 => matches!(group, 2 | 3),
            0x86 | 0x87 | 0x0FC0 | 0x0FC1 | 0x0FB0 | 0x0FB1 | 0x0FAB | 0x0FB3 | 0x0FBB => true,
            0x0FBA => group >= 5,
            0x0FC7 => group == 1,
            _ => false,
        };
    if d.prefixes.lock && !lock_ok {
        return Op::Step;
    }
    // With cores in workers, a locked read-modify-write (XCHG with memory is
    // locked) commits with a compare-exchange loop (see locked_rmw), or
    // atomically in the interpreter (x64::memory::run_locked).
    let result = (|| -> Option<Op> {
        Some(match op {
            0x00..=0x3D if op & 7 <= 5 => {
                let code = (op >> 3) as u8;
                let width = if op & 1 == 0 { 8 } else { w };
                match op & 7 {
                    0 | 1 => Op::Alu {
                        code,
                        width,
                        dst: rm(width)?,
                        src: Opnd::Reg(reg(d.reg?, width)),
                    },
                    2 | 3 => Op::Alu {
                        code,
                        width,
                        dst: Opnd::Reg(reg(d.reg?, width)),
                        src: rm(width)?,
                    },
                    _ => Op::Alu {
                        code,
                        width,
                        dst: Opnd::Reg(reg(0, width)),
                        src: Opnd::Imm(imm? & mask(width)),
                    },
                }
            },
            0x80 | 0x81 | 0x83 => {
                let width = if op == 0x80 { 8 } else { w };
                Op::Alu {
                    code: group,
                    width,
                    dst: rm(width)?,
                    src: Opnd::Imm(imm? & mask(width)),
                }
            },
            0x84 | 0x85 => {
                let width = if op == 0x84 { 8 } else { w };
                Op::Test {
                    width,
                    a: rm(width)?,
                    b: Opnd::Reg(reg(d.reg?, width)),
                }
            },
            0xA8 | 0xA9 => {
                let width = if op == 0xA8 { 8 } else { w };
                Op::Test {
                    width,
                    a: Opnd::Reg(reg(0, width)),
                    b: Opnd::Imm(imm? & mask(width)),
                }
            },
            0x88..=0x8B => {
                let width = if op & 1 == 0 { 8 } else { w };
                if op & 2 == 0 {
                    Op::Mov {
                        width,
                        dst: rm(width)?,
                        src: Opnd::Reg(reg(d.reg?, width)),
                    }
                }
                else {
                    Op::Mov {
                        width,
                        dst: Opnd::Reg(reg(d.reg?, width)),
                        src: rm(width)?,
                    }
                }
            },
            0xB0..=0xBF => {
                let width = if op < 0xB8 { 8 } else { w };
                Op::Mov {
                    width,
                    dst: Opnd::Reg(reg(d.opcode_register?, width)),
                    src: Opnd::Imm(imm? & mask(width)),
                }
            },
            0xC6 | 0xC7 if group == 0 => {
                let width = if op == 0xC6 { 8 } else { w };
                Op::Mov {
                    width,
                    dst: rm(width)?,
                    src: Opnd::Imm(imm? & mask(width)),
                }
            },
            0x8D => Op::Lea {
                width: w,
                dst: reg(d.reg?, w),
                address: d.address?,
            },
            0x63 => Op::Extend {
                width: w,
                from: if w == 16 { 16 } else { 32 },
                signed: true,
                dst: reg(d.reg?, w),
                src: rm(if w == 16 { 16 } else { 32 })?,
            },
            0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF => {
                let from = if op & 1 == 0 { 8 } else { 16 };
                Op::Extend {
                    width: w,
                    from,
                    signed: op & 8 != 0,
                    dst: reg(d.reg?, w),
                    src: rm(from)?,
                }
            },
            0xFE | 0xFF if group <= 1 => {
                let width = if op == 0xFE { 8 } else { w };
                Op::IncDec {
                    dec: group == 1,
                    width,
                    dst: rm(width)?,
                }
            },
            0xF6 | 0xF7 => {
                let width = if op == 0xF6 { 8 } else { w };
                match group {
                    0 | 1 => Op::Test {
                        width,
                        a: rm(width)?,
                        b: Opnd::Imm(imm? & mask(width)),
                    },
                    2 => Op::Not {
                        width,
                        dst: rm(width)?,
                    },
                    3 => Op::Neg {
                        width,
                        dst: rm(width)?,
                    },
                    4 | 5 if width >= 32 => Op::MulWide {
                        signed: group == 5,
                        width,
                        src: rm(width)?,
                    },
                    6 | 7 if width >= 32 => Op::Div {
                        signed: group == 7,
                        width,
                        src: rm(width)?,
                    },
                    _ => return None,
                }
            },
            0xC0 | 0xC1 | 0xD0 | 0xD1 | 0xD2 | 0xD3 => {
                let width = if op & 1 == 0 { 8 } else { w };
                let count = match op {
                    0xC0 | 0xC1 => Some(imm? as u8),
                    0xD0 | 0xD1 => Some(1),
                    _ => None,
                };
                // Rotates through carry, and narrow CL shifts or rotates,
                // call the interpreter's semantics (64-bit RCL/RCR step).
                if matches!(group, 2 | 3) || count.is_none() && width < 32 {
                    if width == 64 {
                        return None;
                    }
                    return Some(Op::ShiftCall {
                        code: group,
                        width,
                        dst: rm(width)?,
                        count,
                    });
                }
                Op::Shift {
                    code: group,
                    width,
                    dst: rm(width)?,
                    count,
                }
            },
            0x0FAF => Op::Imul {
                width: w,
                dst: reg(d.reg?, w),
                a: rm(w)?,
                b: Opnd::Reg(reg(d.reg?, w)),
            },
            0x69 | 0x6B => Op::Imul {
                width: w,
                dst: reg(d.reg?, w),
                a: rm(w)?,
                b: Opnd::Imm(imm? & mask(w)),
            },
            0x50..=0x57 if w == 64 => Op::Push {
                src: Opnd::Reg(reg(d.opcode_register?, 64)),
            },
            0x58..=0x5F if w == 64 => Op::Pop {
                dst: reg(d.opcode_register?, 64),
            },
            0x68 | 0x6A if w == 64 => Op::Push {
                src: Opnd::Imm(imm?),
            },
            0xFF if group == 6 && w == 64 => Op::Push { src: rm(64)? },
            0x9C if w == 64 => Op::Pushf,
            0xC9 if w == 64 => Op::Leave,
            0xE8 => Op::Call {
                target: relative(d)?,
            },
            0xFF if group == 2 => Op::CallIndirect { src: rm(64)? },
            0xFF if group == 4 => Op::JmpIndirect { src: rm(64)? },
            0xC3 => Op::Ret { pop: 0 },
            0xC2 => Op::Ret { pop: imm? as u16 },
            0xE9 | 0xEB => Op::Jmp {
                target: relative(d)?,
            },
            0x70..=0x7F | 0x0F80..=0x0F8F => Op::Jcc {
                cc: op as u8 & 15,
                target: relative(d)?,
            },
            0x0F40..=0x0F4F => Op::Cmov {
                cc: op as u8 & 15,
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
            },
            0x0F90..=0x0F9F => Op::Setcc {
                cc: op as u8 & 15,
                dst: rm(8)?,
            },
            0x86 | 0x87 => {
                let width = if op == 0x86 { 8 } else { w };
                Op::Xchg {
                    width,
                    a: rm(width)?,
                    b: reg(d.reg?, width),
                }
            },
            0x90 if d.opcode_register? & 7 == 0 && d.opcode_register? < 8 => {
                // PAUSE yields the core in the interpreter
                if d.prefixes.rep.is_some() {
                    return None;
                }
                Op::Nop
            },
            0x90..=0x97 => Op::Xchg {
                width: w,
                a: Opnd::Reg(reg(0, w)),
                b: reg(d.opcode_register?, w),
            },
            0x0FC0 | 0x0FC1 => {
                let width = if op == 0x0FC0 { 8 } else { w };
                Op::Xadd {
                    width,
                    dst: rm(width)?,
                    src: reg(d.reg?, width),
                }
            },
            0x0FB0 | 0x0FB1 => {
                let width = if op == 0x0FB0 { 8 } else { w };
                Op::Cmpxchg {
                    width,
                    dst: rm(width)?,
                    src: reg(d.reg?, width),
                }
            },
            0x98 => Op::SignAcc { width: w },
            0x99 => Op::SignDx { width: w },
            0x0FA3 | 0x0FAB | 0x0FB3 | 0x0FBB => Op::Bt {
                action: ((op >> 3) & 3) as u8,
                width: w,
                dst: rm(w)?,
                index: Opnd::Reg(reg(d.reg?, w)),
            },
            0x0FBA if group >= 4 => Op::Bt {
                action: group - 4,
                width: w,
                dst: rm(w)?,
                index: Opnd::Imm(imm?),
            },
            0x0FBC | 0x0FBD => Op::BitScan {
                reverse: op == 0x0FBD,
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
            },
            0x0FB8 if d.opcode == 0xF30FB8 => Op::Popcnt {
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
            },
            0x0FC8..=0x0FCF if w != 16 => Op::Bswap {
                width: w,
                reg: (op as u8 & 7) | d.prefixes.b(),
            },
            0xF5 | 0xF8 | 0xF9 | 0xFC | 0xFD => Op::Flag { opcode: op as u8 },
            0x9E => Op::Sahf,
            0x9F => Op::Lahf,
            0x0F0D | 0x0F18..=0x0F1F => Op::Nop,
            0xFA => Op::Cli,
            0xFB => Op::Sti,
            0x0F01 if d.modrm == Some(0xF8) => Op::Swapgs,
            0x0F01 if group == 7 && memory => Op::Invlpg {
                address: d.address?,
            },
            0x0F31 => Op::Rdtsc,
            0xA4 | 0xA5 | 0xAA | 0xAB
                if d.address_size == 64
                    && !(op <= 0xA5 && matches!(d.prefixes.segment, Some(4 | 5))) =>
            {
                let width = if op & 1 == 0 { 8 } else { w };
                let rep = d.prefixes.rep.is_some();
                if op <= 0xA5 {
                    Op::Movs { width, rep }
                }
                else {
                    Op::Stos { width, rep }
                }
            },
            0xA6 | 0xA7 | 0xAE | 0xAF
                if d.address_size == 64
                    && d.prefixes.rep.is_some()
                    && !(op <= 0xA7 && matches!(d.prefixes.segment, Some(4 | 5))) =>
            {
                Op::RepCompare {
                    width: if op & 1 == 0 { 8 } else { w },
                    scan: op >= 0xAE,
                    equal: d.prefixes.rep == Some(0xF3),
                }
            },
            0x8C if group < 6 => Op::MovSreg {
                segment: group,
                width: if memory { 16 } else { w },
                dst: rm(w)?,
            },
            0x0FA4 | 0x0FAC if w >= 32 => Op::DoubleShift {
                left: op == 0x0FA4,
                width: w,
                dst: rm(w)?,
                src: reg(d.reg?, w),
                count: imm? as u8,
            },
            0x0FC7 if group == 1 && memory => Op::CompareExchange {
                wide: w == 128,
                address: d.address?,
            },
            // MOV AL/rAX, moffs and back: an absolute address (FS/GS base added)
            0xA0..=0xA3 => {
                let width = if op & 1 == 0 { 8 } else { w };
                let address = AddressExpr {
                    base: AddressBase::None,
                    index: None,
                    scale: 1,
                    displacement: imm? as i64,
                    address_size: d.address_size,
                    segment: d.prefixes.segment.unwrap_or(3),
                };
                let accumulator = Opnd::Reg(Reg {
                    index: 0,
                    high: false,
                });
                if op & 2 == 0 {
                    Op::Mov {
                        width,
                        dst: accumulator,
                        src: Opnd::Mem(address),
                    }
                }
                else {
                    Op::Mov {
                        width,
                        dst: Opnd::Mem(address),
                        src: accumulator,
                    }
                }
            },
            // MOVNTI: an ordinary store here
            0x0FC3 if memory && w >= 32 => Op::Mov {
                width: w,
                dst: rm(w)?,
                src: Opnd::Reg(reg(d.reg?, w)),
            },
            // LFENCE MFENCE SFENCE: one core runs at a time, in program order
            0x0FAE if d.opcode == 0x0FAE && d.rm_register.is_some() && group >= 5 => Op::Nop,
            0x0FAE if d.opcode == 0x0FAE && memory && matches!(group, 2 | 3) => Op::Mxcsr {
                load: group == 2,
                address: d.address?,
            },
            0x0F01 if d.modrm == Some(0xF9) => Op::Rdtscp,
            0x0F20 if matches!(d.reg, Some(0 | 2 | 3 | 4)) && d.rm_register.is_some() => {
                Op::ReadCr {
                    control: d.reg?,
                    reg: reg(d.rm_register?, 64),
                }
            },
            0x0F20 | 0x0F22 if d.reg == Some(8) && d.rm_register.is_some() => Op::Cr8 {
                write: op == 0x0F22,
                reg: reg(d.rm_register?, 64),
            },
            _ if d.opcode >> 8 & 0xFF == 0x0F
                || d.opcode >> 16 == 0x0F
                || matches!(op >> 8, 0x0F38 | 0x0F3A) =>
            {
                return sse(d)
            },
            _ => return None,
        })
    })();
    result.unwrap_or(Op::Step)
}

/// SSE data movement and bitwise templates (x64::vector semantics).
fn sse(d: &Decoded) -> Option<Op> {
    let xmm_rm = || -> Option<Xmm> {
        match d.rm_register {
            Some(r) => Some(Xmm::Reg(r)),
            None => d.address.map(Xmm::Mem),
        }
    };
    let register = d.reg?;
    let memory = d.rm_register.is_none();
    let full = |aligned: bool, store: bool| -> Option<Op> {
        Some(if store {
            Op::Vmove {
                bits: 128,
                dst: xmm_rm()?,
                src: Xmm::Reg(register),
                aligned,
                zero: false,
            }
        }
        else {
            Op::Vmove {
                bits: 128,
                dst: Xmm::Reg(register),
                src: xmm_rm()?,
                aligned,
                zero: false,
            }
        })
    };
    Some(match d.opcode {
        // MOVUPS MOVUPD MOVDQU / MOVAPS MOVAPD MOVDQA
        0x0F10 | 0x660F10 | 0xF30F6F => full(false, false)?,
        0x0F11 | 0x660F11 | 0xF30F7F => full(false, true)?,
        0x0F28 | 0x660F28 | 0x660F6F => full(true, false)?,
        0x0F29 | 0x660F29 | 0x660F7F => full(true, true)?,
        // MOVNTPS MOVNTPD MOVNTDQ (memory only)
        0x0F2B | 0x660F2B | 0x660FE7 if memory => full(true, true)?,
        // MOVSS MOVSD
        0xF30F10 | 0xF20F10 => {
            let bits = if d.opcode == 0xF30F10 { 32 } else { 64 };
            Op::Vmove {
                bits,
                dst: Xmm::Reg(register),
                src: xmm_rm()?,
                aligned: false,
                zero: memory,
            }
        },
        0xF30F11 | 0xF20F11 => {
            let bits = if d.opcode == 0xF30F11 { 32 } else { 64 };
            Op::Vmove {
                bits,
                dst: xmm_rm()?,
                src: Xmm::Reg(register),
                aligned: false,
                zero: false,
            }
        },
        // MOVQ xmm, xmm/m64 and MOVQ xmm/m64, xmm: a register destination's upper half is cleared
        0xF30F7E => Op::Vmove {
            bits: 64,
            dst: Xmm::Reg(register),
            src: xmm_rm()?,
            aligned: false,
            zero: true,
        },
        0x660FD6 => Op::Vmove {
            bits: 64,
            dst: xmm_rm()?,
            src: Xmm::Reg(register),
            aligned: false,
            zero: true,
        },
        0x660F6E | 0x660F7E => {
            let width = if d.prefixes.w() { 64 } else { 32 };
            let rm = match d.rm_register {
                Some(r) => Opnd::Reg(Reg {
                    index: r,
                    high: false,
                }),
                None => Opnd::Mem(d.address?),
            };
            if d.opcode == 0x660F6E {
                Op::MovdIn {
                    width,
                    dst: register,
                    src: rm,
                }
            }
            else {
                Op::MovdOut {
                    width,
                    dst: rm,
                    src: register,
                }
            }
        },
        // AND ANDN OR XOR
        0x0F54 | 0x660F54 | 0x660FDB => Op::Vlogic {
            code: 0,
            dst: register,
            src: xmm_rm()?,
        },
        0x0F55 | 0x660F55 | 0x660FDF => Op::Vlogic {
            code: 1,
            dst: register,
            src: xmm_rm()?,
        },
        0x0F56 | 0x660F56 | 0x660FEB => Op::Vlogic {
            code: 2,
            dst: register,
            src: xmm_rm()?,
        },
        0x0F57 | 0x660F57 | 0x660FEF => Op::Vlogic {
            code: 3,
            dst: register,
            src: xmm_rm()?,
        },
        // ADDPS/PD/SS/SD MULx SUBx DIVx
        0x0F58 | 0x0F59 | 0x0F5C | 0x0F5E | 0x660F58 | 0x660F59 | 0x660F5C | 0x660F5E
        | 0xF30F58 | 0xF30F59 | 0xF30F5C | 0xF30F5E | 0xF20F58 | 0xF20F59 | 0xF20F5C | 0xF20F5E => {
            let prefix = d.opcode >> 16;
            Op::Vfp {
                code: d.opcode as u8,
                double: prefix == 0x66 || prefix == 0xF2,
                packed: prefix == 0 || prefix == 0x66,
                dst: register,
                src: xmm_rm()?,
            }
        },
        0x0F2E | 0x0F2F | 0x660F2E | 0x660F2F => Op::Vcompare {
            double: d.opcode >> 16 == 0x66,
            dst: register,
            src: xmm_rm()?,
        },
        // (the forms below emit Wasm SIMD: not in the build for engines without it)
        _ if !cfg!(target_feature = "simd128") => return None,
        0x660F70 | 0xF20F70 | 0xF30F70 | 0x0FC6 | 0x660FC6 => Op::Vpacked {
            op: Packed::Shuffle(shuffle_lanes(d.opcode, d.immediate?.value as u32 & 0xFF)),
            dst: register,
            src: xmm_rm()?,
        },
        0x660F71 | 0x660F72 | 0x660F73 if !memory => {
            let kind = d.modrm? >> 3 & 7;
            let code = d.opcode as u8;
            let bytes = matches!(kind, 3 | 7) && code == 0x73;
            if !(matches!(kind, 2 | 4 | 6) && !(code == 0x73 && kind == 4) || bytes) {
                return None;
            }
            Op::VshiftImm {
                dst: d.rm_register?,
                bits: if bytes { 128 } else { 16 << (code - 0x71) },
                kind,
                count: d.immediate?.value.min(255) as u8,
            }
        },
        op if op >> 8 == 0x660F => Op::Vpacked {
            op: packed_op(op as u8)?,
            dst: register,
            src: xmm_rm()?,
        },
        // PSHUFB, PALIGNR (SSSE3)
        0x660F3800 => Op::Vpacked {
            op: Packed::Swizzle,
            dst: register,
            src: xmm_rm()?,
        },
        0x660F3A0F => Op::Vpacked {
            op: palignr(d.immediate?.value),
            dst: register,
            src: xmm_rm()?,
        },
        _ => return None,
    })
}

fn cond_reads(cc: u8) -> u32 {
    match cc >> 1 {
        0 => OF,
        1 => CF,
        2 => ZF,
        3 => CF | ZF,
        4 => SF,
        5 => PF,
        6 => SF | OF,
        _ => ZF | SF | OF,
    }
}
fn shift_count(width: u8, count: u8) -> u8 { count & if width == 64 { 63 } else { 31 } }
/// (read, written) EFLAGS arithmetic bits.
fn effects(op: &Op) -> (u32, u32) {
    match *op {
        Op::Alu { code: 2 | 3, .. } => (CF, ARITH),
        Op::Alu { .. }
        | Op::Test { .. }
        | Op::Neg { .. }
        | Op::Xadd { .. }
        | Op::Cmpxchg { .. }
        | Op::Popcnt { .. } => (0, ARITH),
        Op::IncDec { .. } => (0, ARITH & !CF),
        Op::Shift {
            code,
            width,
            count: Some(count),
            ..
        } => {
            let raw = shift_count(width, count);
            if raw == 0 {
                (0, 0)
            }
            else {
                let of = if raw == 1 { OF } else { 0 };
                (0, if code >= 4 { CF | PF | ZF | SF | of } else { CF | of })
            }
        },
        // A zero CL count leaves every flag unchanged; rotates only set CF/OF.
        Op::Shift {
            code: 0 | 1,
            count: None,
            ..
        } => (CF | OF, CF | OF),
        Op::Shift { count: None, .. } => (CF | PF | ZF | SF | OF, CF | PF | ZF | SF | OF),
        // (the helper takes and returns all of EFLAGS)
        Op::ShiftCall { .. } => (ARITH, ARITH),
        Op::Imul { .. } | Op::MulWide { .. } => (0, CF | OF),
        Op::Bt { .. } => (0, CF),
        Op::BitScan { .. } => (0, ZF),
        Op::Jcc { cc, .. } | Op::Cmov { cc, .. } | Op::Setcc { cc, .. } => (cond_reads(cc), 0),
        Op::Pushf => (ARITH, 0),
        Op::Flag { opcode: 0xF5 } => (CF, CF),
        Op::Flag {
            opcode: 0xF8 | 0xF9,
        } => (0, CF),
        Op::Lahf => (SF | ZF | AF | PF | CF, 0),
        Op::DoubleShift { width, count, .. } => {
            let count = shift_count(width, count);
            (
                0,
                if count == 0 { 0 } else { CF | PF | ZF | SF | if count == 1 { OF } else { 0 } },
            )
        },
        Op::CompareExchange { .. } => (0, ZF),
        Op::Sahf => (0, SF | ZF | AF | PF | CF),
        Op::Vcompare { .. } => (0, ARITH),
        Op::Step => (ARITH, ARITH),
        // (RCX = 0 leaves EFLAGS as they were)
        Op::RepCompare { .. } => (ARITH, ARITH),
        _ => (0, 0),
    }
}

/// A flags producer whose operands a later condition can compare directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Known {
    /// fa - fb = fr (CMP, SUB, NEG, CMPXCHG)
    Sub(u8),
    /// fr, with CF = OF = 0 (AND, OR, XOR, TEST)
    Logic(u8),
    /// only ZF, SF, PF of fr (ADD, XADD, INC, DEC)
    Result(u8),
}
fn producer(op: &Op) -> Option<Known> {
    match *op {
        Op::Alu {
            code: 5 | 7, width, ..
        }
        | Op::Neg { width, .. }
        | Op::Cmpxchg { width, .. } => Some(Known::Sub(width)),
        Op::Alu {
            code: 1 | 4 | 6,
            width,
            ..
        }
        | Op::Test { width, .. } => Some(Known::Logic(width)),
        Op::Alu { code: 0, width, .. } | Op::Xadd { width, .. } | Op::IncDec { width, .. } => {
            Some(Known::Result(width))
        },
        _ => None,
    }
}
fn fusable(known: Known, cc: u8) -> bool {
    match known {
        Known::Sub(_) | Known::Logic(_) => true,
        Known::Result(_) => matches!(cc >> 1, 2 | 4 | 5),
    }
}

struct Inst {
    d: Decoded,
    op: Op,
    /// EFLAGS bits the instruction reads (materialized first when pending)
    flags_read: u32,
    /// Liveness input: flags_read, but 0 for fused consumers and steps
    /// (which materialize everything themselves).
    reads: u32,
    writes: u32,
    live_out: u32,
    /// Condition from the producer operands instead of EFLAGS.
    fused: Option<Known>,
    /// Producer: keep operands for a fused consumer.
    keep: bool,
    /// An instruction that continues into the next page: its bytes there
    /// (little endian) and how many. It runs only while the next page
    /// fetches as these bytes (x64_page_straddle), else it is stepped.
    straddle: Option<(u64, u8)>,
    /// A locked read-modify-write of memory (LOCK, XCHG) with cores in
    /// workers: committed with a compare-exchange loop (Emitter::read_dst)
    locked: bool,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum End {
    /// Continue at this page offset (4096: the next page).
    Next(u16),
    /// The last instruction transferred control.
    Stop,
    /// Interpret the instruction at this offset (undecodable here).
    Retry(u16),
    /// Step the instruction at this offset in place: it continues into the
    /// next page (or does not decode), so the interpreter fetches it.
    StepAt(u16),
}
struct Block {
    start: u16,
    insts: Vec<Inst>,
    end: End,
    live_in: u32,
}

fn in_page(page: u64, target: u64) -> Option<u16> {
    (target & !4095 == page).then_some((target & 4095) as u16)
}
fn is_rep_string(d: &Decoded) -> bool {
    d.prefixes.rep.is_some() && matches!(d.base_opcode(), 0x6C..=0x6F | 0xA4..=0xA7 | 0xAA..=0xAF)
}

/// With cores in workers: a locked read-modify-write of memory.
fn locked_rmw(d: &Decoded, op: &Op) -> bool {
    crate::parallel::active()
        && d.rm_register.is_none()
        && (d.prefixes.lock
            || matches!(
                op,
                Op::Xchg {
                    a: Opnd::Mem(_),
                    ..
                }
            ))
}
/// Templates that commit a locked memory operand with a compare-exchange
/// loop (Emitter::read_dst and write_dst; the rest are stepped).
fn lockable(op: &Op) -> bool {
    match *op {
        Op::Alu {
            code,
            dst: Opnd::Mem(_),
            ..
        } => code != 7,
        Op::IncDec {
            dst: Opnd::Mem(_), ..
        }
        | Op::Neg {
            dst: Opnd::Mem(_), ..
        }
        | Op::Not {
            dst: Opnd::Mem(_), ..
        }
        | Op::Xadd {
            dst: Opnd::Mem(_), ..
        }
        | Op::Cmpxchg {
            dst: Opnd::Mem(_), ..
        }
        | Op::Xchg {
            a: Opnd::Mem(_), ..
        } => true,
        Op::Bt {
            action,
            dst: Opnd::Mem(_),
            ..
        } => action != 0,
        _ => false,
    }
}

pub struct Compiled {
    pub bytes: Vec<u8>,
    /// Block starts, as a bitmap of page offsets.
    pub served: [u64; 64],
    pub instructions: usize,
    pub templated: usize,
    pub blocks: usize,
}

/// Multiplicative hashing of page offsets (the default SipHash showed in
/// compile profiles).
#[derive(Default)]
struct OffsetHasher(u64);
impl std::hash::Hasher for OffsetHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }
    fn write_u16(&mut self, value: u16) {
        self.0 = (value as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}
struct Decoder<'a> {
    bytes: &'a [u8],
    /// the first bytes of the next page as compiled (may be empty)
    next: &'a [u8],
    page: u64,
    cache: HashMap<u16, Option<(Decoded, Op)>, std::hash::BuildHasherDefault<OffsetHasher>>,
}
impl Decoder<'_> {
    fn at(&mut self, offset: u16) -> Option<(Decoded, Op)> {
        let (bytes, next, page) = (self.bytes, self.next, self.page);
        *self.cache.entry(offset).or_insert_with(|| {
            let d =
                decode::decode_with(GuestIp(page + offset as u64), ExecutionMode::Long64, |i| {
                    let at = offset as usize + i as usize;
                    if at < PAGE { bytes.get(at) } else { next.get(at - PAGE) }
                        .copied()
                        .ok_or(())
                })
                .ok()?;
            // (at most 8 bytes in the next page: x64_page_straddle compares one word)
            if offset as usize + d.length as usize > PAGE + 8 {
                return None;
            }
            Some((d, classify(&d)))
        })
    }
}

/// Compile a page of long-mode code (the bytes of its RAM backing page) for
/// the block starts `entries`. The function is position independent: it runs
/// wherever the page is mapped (gp::x64_page_linear), so every mapping of the
/// same backing page shares it. Addresses below are relative to the page.
/// `chaining`: leaving the page, tail-call the function serving the new page
/// when the chaining table (pages::CHAIN) has it. `next`: the first bytes of
/// the next linear page where it was compiled, for instructions that
/// straddle into it (empty: those are stepped).
pub fn compile(
    bytes: &[u8],
    next: &[u8],
    entries: &[u16],
    chaining: bool,
    name: String,
) -> Option<Compiled> {
    let page = 0;
    if bytes.len() != PAGE || entries.is_empty() {
        return None;
    }
    let mut decoder = Decoder {
        bytes,
        next,
        page,
        cache: HashMap::default(),
    };
    // Discover block starts: entries, in-page branch targets, return
    // addresses, and the instruction after every step (steps continue by
    // dispatch). Each REP string instruction starts its own block so a
    // step that repeats it dispatches back to it.
    let mut starts = BTreeSet::new();
    let mut work: Vec<u16> = Vec::new();
    for &e in entries {
        if (e as usize) < PAGE && starts.insert(e) {
            work.push(e);
        }
    }
    let mut decoded = 0;
    while let Some(start) = work.pop() {
        let add = |o: u64, starts: &mut BTreeSet<u16>, work: &mut Vec<u16>| {
            if o < PAGE as u64 && starts.insert(o as u16) {
                work.push(o as u16);
            }
        };
        let mut o = start;
        loop {
            if o != start && starts.contains(&o) {
                break;
            }
            decoded += 1;
            if decoded > MAX_INSTRUCTIONS {
                // Long runs (padding, data): the rest stays interpreted.
                break;
            }
            let Some((d, op)) = decoder.at(o)
            else {
                break;
            };
            let next = o as u64 + d.length as u64;
            match op {
                Op::Jcc { target, .. } => {
                    if let Some(t) = in_page(page, target) {
                        add(t as u64, &mut starts, &mut work);
                    }
                    add(next, &mut starts, &mut work);
                    break;
                },
                Op::Jmp { target } | Op::Call { target } => {
                    if let Some(t) = in_page(page, target) {
                        add(t as u64, &mut starts, &mut work);
                    }
                    if matches!(op, Op::Call { .. }) {
                        add(next, &mut starts, &mut work);
                    }
                    break;
                },
                Op::CallIndirect { .. } => {
                    add(next, &mut starts, &mut work);
                    break;
                },
                Op::Ret { .. } | Op::JmpIndirect { .. } => break,
                Op::Sti => {
                    if next < PAGE as u64 {
                        if let Some((shadow, _)) = decoder.at(next as u16) {
                            add(next + shadow.length as u64, &mut starts, &mut work);
                        }
                    }
                    break;
                },
                Op::Movs { rep: true, .. } | Op::Stos { rep: true, .. } | Op::RepCompare { .. }
                    if o != start =>
                {
                    add(o as u64, &mut starts, &mut work);
                    break;
                },
                Op::Step => {
                    if is_rep_string(&d) && o != start {
                        add(o as u64, &mut starts, &mut work);
                        break;
                    }
                    add(next, &mut starts, &mut work);
                    break;
                },
                _ => {},
            }
            if next >= PAGE as u64 {
                break;
            }
            o = next as u16;
        }
    }
    // Blocks, in page order: from each start to its first control transfer,
    // step, or the next start.
    let mut blocks: Vec<Block> = Vec::new();
    let mut total = 0;
    for &start in &starts {
        let mut insts = Vec::new();
        let mut o = start;
        let end = loop {
            if o as usize >= PAGE {
                // (past the page end after a straddling instruction)
                break End::Next(o);
            }
            if o != start && starts.contains(&o) {
                break End::Next(o);
            }
            if total >= MAX_INSTRUCTIONS {
                break End::Retry(o);
            }
            total += 1;
            let Some((d, op)) = decoder.at(o)
            else {
                break End::StepAt(o);
            };
            let next = o + d.length as u16;
            let (reads, writes) = effects(&op);
            let liveness = if matches!(op, Op::Step) { 0 } else { reads };
            let locked = cfg!(feature = "parallel") && locked_rmw(&d, &op);
            let op = if locked && !lockable(&op) { Op::Step } else { op };
            let straddle = (next as usize > PAGE).then(|| {
                let count = next as usize - PAGE;
                let word = (0..count).fold(0u64, |w, i| w | (decoder.next[i] as u64) << (8 * i));
                (word, count as u8)
            });
            insts.push(Inst {
                d,
                op,
                flags_read: reads,
                reads: liveness,
                writes,
                live_out: ARITH,
                fused: None,
                keep: false,
                straddle,
                locked: locked && !matches!(op, Op::Step),
            });
            match op {
                Op::Jcc { .. } | Op::Step => break End::Next(next),
                Op::Jmp { .. }
                | Op::Call { .. }
                | Op::CallIndirect { .. }
                | Op::Ret { .. }
                | Op::JmpIndirect { .. }
                | Op::Sti => break End::Stop,
                _ => {},
            }
            o = next;
        };
        // After a truncated discovery a fall-through may not be a start.
        let end = match end {
            End::Next(o) if (o as usize) < PAGE && !starts.contains(&o) => End::Retry(o),
            end => end,
        };
        blocks.push(Block {
            start,
            insts,
            end,
            live_in: ARITH,
        });
    }
    let index: BTreeMap<u16, usize> = blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (b.start, i))
        .collect();
    // Fusion (per block, forward): a condition consumer reads the operands
    // of the last flags producer when no other flags writer intervenes.
    for block in &mut blocks {
        let mut known: Option<(usize, Known)> = None;
        for i in 0..block.insts.len() {
            let op = block.insts[i].op;
            let cc = match op {
                Op::Jcc { cc, .. } | Op::Cmov { cc, .. } | Op::Setcc { cc, .. } => Some(cc),
                _ => None,
            };
            if let (Some(cc), Some((p, k))) = (cc, known) {
                if fusable(k, cc) {
                    block.insts[i].fused = Some(k);
                    block.insts[i].reads = 0;
                    block.insts[i].flags_read = 0;
                    block.insts[p].keep = true;
                }
            }
            if block.insts[i].writes != 0 {
                known = producer(&op).map(|k| (i, k));
            }
        }
    }
    // EFLAGS liveness to a fixpoint (backward over the page's blocks).
    let successors = |blocks: &Vec<Block>, b: usize| -> u32 {
        let block = &blocks[b];
        // Only a performance estimate: anything reading a flag the lazy
        // record still holds materializes it (exits, steps, other code).
        let live = |o: u16| if (o as usize) < PAGE { blocks[index[&o]].live_in } else { 0 };
        let target = |t: u64| {
            in_page(page, t)
                .and_then(|o| index.get(&o))
                .map_or(0, |&i| blocks[i].live_in)
        };
        let last = block.insts.last().map(|i| i.op);
        match (block.end, last) {
            (End::Retry(_) | End::StepAt(_), _) => 0,
            (End::Next(_), Some(Op::Step)) => 0,
            (End::Next(o), Some(Op::Jcc { target: t, .. })) => live(o) | target(t),
            (End::Next(o), _) => live(o),
            (End::Stop, Some(Op::Jmp { target: t }))
            | (End::Stop, Some(Op::Call { target: t })) => target(t),
            (End::Stop, _) => 0,
        }
    };
    loop {
        let mut changed = false;
        for b in (0..blocks.len()).rev() {
            let mut live = successors(&blocks, b);
            let block = &mut blocks[b];
            for inst in block.insts.iter_mut().rev() {
                inst.live_out = live;
                live = inst.reads | (live & !inst.writes);
            }
            if live != block.live_in {
                block.live_in = live;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut served = [0u64; 64];
    for &s in &starts {
        served[s as usize / 64] |= 1 << (s % 64);
    }
    let instructions = blocks.iter().map(|b| b.insts.len()).sum();
    let templated = blocks
        .iter()
        .flat_map(|b| &b.insts)
        .filter(|i| !matches!(i.op, Op::Step))
        .count();
    let bytes = Emitter::emit(&blocks, &index, chaining, name);
    Some(Compiled {
        bytes,
        served,
        instructions,
        templated,
        blocks: blocks.len(),
    })
}

// i64 locals (0..16 are the GPRs)
const RIP: usize = 16;
const EP: usize = 17;
const FA: usize = 18;
const FB: usize = 19;
const FR: usize = 20;
const TA: usize = 21;
const TB: usize = 22;
const TR: usize = 23;
const TV: usize = 24;
const ADDR: usize = 25;
const TAG: usize = 26;
const TC: usize = 27;
/// scratch of flag and condition computations only
const TX: usize = 28;
/// linear address of the page
const BASE: usize = 29;
/// results of the two halves of an SSE floating point operation (vfp)
const FP0: usize = 30;
const FP1: usize = 31;
/// the value a locked instruction read (read_dst), for its compare-exchange
const OLD: usize = 32;
/// a value being stored (store: cores in workers)
const SV: usize = 33;
const LOCALS64: usize = 34;
// i32 locals
const FL: usize = 0;
const N: usize = 1;
const K: usize = 2;
const JAC: usize = 3;
const ENT: usize = 4;
const OFF: usize = 5;
const HOST: usize = 6;
const HH: usize = 7;
const ST: usize = 8;
const COND: usize = 9;
/// Lazy flags record: kind << 16 | pending EFLAGS bits (operands in FA/FB).
const FK: usize = 10;
/// ADC/SBB carry input
const CI: usize = 11;
/// REP MOVS source host address (host() clobbers HH)
const SRC: usize = 12;
/// an SSE arithmetic lane was inexact (vfp)
const INX: usize = 13;
/// the host address of a store (store, load_any: cores in workers)
const SH: usize = 14;
const LOCALS32: usize = 15;
const RAX: Reg = Reg {
    index: 0,
    high: false,
};
const RDX: Reg = Reg {
    index: 2,
    high: false,
};
const AH: Reg = Reg {
    index: 0,
    high: true,
};

#[derive(Clone, Copy)]
struct Frame {
    exit: Label,
    /// RIP left the page (normal exit): chain or return
    leave: Label,
    retry: Label,
    step: Label,
    dispatch: Label,
}
struct Emitter {
    b: WasmBuilder,
    v: Vec<WasmLocalI64>,
    w: Vec<WasmLocal>,
    budget: WasmLocal,
    frame: Option<Frame>,
    labels: Vec<Label>,
    current: usize,
    /// the module's access-cache lookup function (see access_function)
    access: Option<u32>,
    /// the compare-exchange loop of a locked instruction (read_dst)
    lock_loop: Option<Label>,
}
/// Dispatch through a table of 16-byte buckets and compares instead of a
/// page-sized table (x64_page_set_bucket_dispatch).
static mut BUCKET_DISPATCH: bool = true;
const DISPATCH_SHIFT: u32 = 4;
#[no_mangle]
pub fn x64_page_set_bucket_dispatch(enabled: bool) { unsafe { BUCKET_DISPATCH = enabled } }
/// Native instructions are counted once per block at its entry instead of
/// after each instruction (smaller code; N is then an upper bound when a
/// block is left early). x64_page_set_block_count.
static mut BLOCK_COUNT: bool = true;
#[no_mangle]
pub fn x64_page_set_block_count(enabled: bool) { unsafe { BLOCK_COUNT = enabled } }
/// Memory accesses call one small lookup function per module instead of
/// inlining the access cache lookup at each (page functions shrink by a
/// third; engines compile them that much faster). x64_page_set_outline.
static mut OUTLINE_ACCESS: bool = true;
#[no_mangle]
pub fn x64_page_set_outline(enabled: bool) { unsafe { OUTLINE_ACCESS = enabled } }

impl Emitter {
    fn emit(
        blocks: &[Block],
        index: &BTreeMap<u16, usize>,
        chaining: bool,
        name: String,
    ) -> Vec<u8> {
        let mut b = WasmBuilder::new();
        b.set_entry_result();
        b.set_function_name(name);
        let budget = b.arg_local_initial_state.unsafe_clone();
        let v = (0..LOCALS64)
            .map(|_| b.declare_zeroed_local_i64())
            .collect();
        let w = (0..LOCALS32).map(|_| b.declare_zeroed_local()).collect();
        let mut e = Emitter {
            b,
            v,
            w,
            budget,
            frame: None,
            labels: Vec::new(),
            current: 0,
            access: None,
            lock_loop: None,
        };
        let mark = e.b.body_len();
        e.prologue();
        size_note("[prologue]".into(), e.b.body_len() - mark);
        let exit = e.b.block_void();
        let leave = e.b.block_void();
        let retry = e.b.block_void();
        let dispatch = e.b.loop_void();
        let step = e.b.block_void();
        e.frame = Some(Frame {
            exit,
            leave,
            retry,
            step,
            dispatch,
        });
        // Budget (native instructions and steps), then the page.
        e.gi(N);
        e.gi(K);
        e.b.add_i32();
        e.b.get_local(&e.budget);
        e.b.geu_i32();
        if cfg!(feature = "parallel") {
            // (cores in workers: another core kicked this one, e.g. with an
            // IPI; see parallel::kick)
            e.c32(&raw const crate::cpu::cpu::core_yield as i32);
            e.b.guest_load_u8(0);
            e.b.or_i32();
        }
        e.b.br_if(exit);
        e.g(RIP);
        e.g(BASE);
        e.b.sub_i64();
        e.c64(4096);
        e.b.op(op::OP_I64GEU);
        e.b.br_if(leave);
        for _ in blocks {
            let label = e.b.block_void();
            e.labels.push(label);
        }
        e.labels.reverse();
        let bad = e.b.block_void();
        let mark = e.b.body_len();
        let offset = |e: &mut Emitter| {
            e.g(RIP);
            e.b.wrap_i64_to_i32();
            e.c32(4095);
            e.b.and_i32();
        };
        if unsafe { BUCKET_DISPATCH } {
            // Two levels: a table over 16-byte buckets of the page, then the
            // block starts in the bucket (a page-sized table is most of a
            // small function and slow to compile)
            let mut buckets: BTreeMap<u16, Vec<(u16, usize)>> = BTreeMap::new();
            for (&o, &i) in index {
                buckets.entry(o >> DISPATCH_SHIFT).or_default().push((o, i));
            }
            let order: Vec<u16> = buckets.keys().copied().collect();
            let mut bucket_labels: HashMap<u16, Label> = HashMap::new();
            for &b in order.iter().rev() {
                bucket_labels.insert(b, e.b.block_void());
            }
            offset(&mut e);
            e.ti(OFF);
            e.c32(DISPATCH_SHIFT as i32);
            e.b.shr_u_i32();
            let targets: Vec<Label> = (0..(PAGE >> DISPATCH_SHIFT) as u16)
                .map(|b| bucket_labels.get(&b).copied().unwrap_or(bad))
                .collect();
            e.b.brtable(bad, &mut targets.iter());
            for b in order {
                e.b.block_end();
                for &(o, i) in &buckets[&b] {
                    e.gi(OFF);
                    e.c32(o as i32);
                    e.b.eq_i32();
                    e.b.br_if(e.labels[i]);
                }
                e.b.br(bad);
            }
        }
        else {
            offset(&mut e);
            let targets: Vec<Label> = (0..PAGE as u16)
                .map(|o| index.get(&o).map_or(bad, |&i| e.labels[i]))
                .collect();
            e.b.brtable(bad, &mut targets.iter());
        }
        size_note("[dispatch br_table]".into(), e.b.body_len() - mark);
        e.b.block_end();
        // Not a block start: step it in place, unless the page is due for a
        // recompile (pages::x64_page_unserved)
        e.g(RIP);
        e.b.call_signature(
            "x64_page_unserved",
            Signature::new(&[WasmType::I64], &[WasmType::I32]),
        );
        e.b.eqz_i32();
        e.b.br_if(step);
        e.set_exit(EXIT_UNKNOWN);
        e.b.br(exit);
        for (i, block) in blocks.iter().enumerate() {
            e.b.block_end();
            e.current = i;
            e.block(block, index);
        }
        let mark = e.b.body_len();
        e.b.unreachable();
        e.b.block_end(); // step
        e.step_code();
        e.b.block_end(); // dispatch loop
        e.b.unreachable();
        e.b.block_end(); // retry
        e.set_exit(EXIT_RETRY);
        e.b.br(exit);
        e.b.block_end(); // leave
        if chaining {
            e.chain();
        }
        e.b.block_end(); // exit
        e.materialize_if(ARITH);
        e.writeback();
        e.gi(N);
        size_note("[step, retry, chain, exit]".into(), e.b.body_len() - mark);
        let Emitter {
            mut b,
            v,
            w,
            budget,
            ..
        } = e;
        for l in v {
            b.free_local_i64(l);
        }
        for l in w {
            b.free_local(l);
        }
        std::mem::forget(budget);
        b.finish();
        b.output().to_vec()
    }
    fn f(&self) -> Frame { self.frame.unwrap() }
    fn g(&mut self, i: usize) { self.b.get_local_i64(&self.v[i]); }
    fn s(&mut self, i: usize) { self.b.set_local_i64(&self.v[i]); }
    fn gi(&mut self, i: usize) { self.b.get_local(&self.w[i]); }
    fn si(&mut self, i: usize) { self.b.set_local(&self.w[i]); }
    fn ti(&mut self, i: usize) { self.b.tee_local(&self.w[i]); }
    fn c64(&mut self, v: u64) { self.b.const_i64(v as i64); }
    fn c32(&mut self, v: i32) { self.b.const_i32(v); }

    fn set_exit(&mut self, code: u32) {
        self.c32(gp::x64_page_exit as i32);
        self.c32(code as i32);
        self.b.store_aligned_i32(0);
    }
    fn load_pair(&mut self, low: u32, high: u32) {
        self.c32(low as i32);
        self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        self.c32(high as i32);
        self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        self.c64(32);
        self.b.shl_i64();
        self.b.or_i64();
    }
    fn store_pair(&mut self, low: u32, high: u32, i: usize) {
        self.c32(low as i32);
        self.g(i);
        self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
        self.c32(high as i32);
        self.g(i);
        self.c64(32);
        self.b.shr_u_i64();
        self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
    }
    fn reload(&mut self) {
        for i in 0..16 {
            self.load_pair(gpr_low_offset(i), gpr_high_offset(i));
            self.s(i);
        }
        self.b.load_fixed_i32(gp::flags as u32);
        self.si(FL);
    }
    fn prologue(&mut self) {
        self.set_exit(EXIT_NORMAL);
        self.reload();
        self.load_pair(gp::instruction_pointer as u32, gp::x64_rip_hi as u32);
        self.s(RIP);
        self.b.load_fixed_i32(gp::x64_jac_base as u32);
        self.si(JAC);
        self.c32(gp::x64_jac_epoch as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(EP);
        self.c32(gp::x64_page_linear as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(BASE);
        // a chaining predecessor passes its lazy EFLAGS record on (see chain)
        self.b.load_fixed_i32(gp::x64_page_lazy_kind as u32);
        self.si(FK);
        self.c32(gp::x64_page_lazy_a as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(FA);
        self.c32(gp::x64_page_lazy_b as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(FB);
    }
    /// Memory becomes authoritative: GPRs, materialized EFLAGS and RIP.
    fn writeback(&mut self) {
        for i in 0..16 {
            self.store_pair(gpr_low_offset(i), gpr_high_offset(i), i);
        }
        self.c32(gp::flags as i32);
        self.gi(FL);
        self.b.store_aligned_i32(0);
        self.c32(gp::flags_changed as i32);
        self.c32(0);
        self.b.store_aligned_i32(0);
        self.store_pair(gp::instruction_pointer as u32, gp::x64_rip_hi as u32, RIP);
        self.c32(gp::last_virt_eip as i32);
        self.c32(-1);
        self.b.store_aligned_i32(0);
    }
    /// Shared: interpret the instruction at RIP, then dispatch on the new RIP
    /// unless the step changed the execution context (memory is current).
    fn step_code(&mut self) {
        self.materialize_if(ARITH);
        self.writeback();
        self.gi(K);
        self.c32(1);
        self.b.add_i32();
        self.si(K);
        self.b
            .call_signature("x64_page_step", Signature::new(&[], &[WasmType::I32]));
        self.si(ST);
        self.gi(ST);
        self.b.if_void();
        self.gi(N);
        self.b.return_();
        self.b.block_end();
        self.reload();
        self.c32(0);
        self.si(FK);
        self.load_pair(gp::instruction_pointer as u32, gp::x64_rip_hi as u32);
        self.s(RIP);
        self.b.br(self.f().dispatch);
    }
    /// Count one native instruction, unless blocks count theirs at entry
    /// (BLOCK_COUNT).
    fn retired(&mut self) {
        if unsafe { BLOCK_COUNT } {
            return;
        }
        self.gi(N);
        self.c32(1);
        self.b.add_i32();
        self.si(N);
    }
    /// Push the linear address of page-relative address `offset`.
    fn linear(&mut self, offset: u64) {
        self.g(BASE);
        if offset != 0 {
            self.c64(offset);
            self.b.add_i64();
        }
    }
    fn leave_to(&mut self, label: Label, offset: u64) {
        self.linear(offset);
        self.s(RIP);
        self.b.br(label);
    }
    /// Continue at `target`: a later block of this function directly, an
    /// earlier one through dispatch (and its budget check), else return.
    fn goto(&mut self, target: u64, index: &BTreeMap<u16, usize>) {
        match in_page(0, target).and_then(|o| index.get(&o)) {
            Some(&i) if i > self.current => self.b.br(self.labels[i]),
            Some(_) => self.leave_to(self.f().dispatch, target),
            None => self.leave_to(self.f().leave, target),
        }
    }
    /// RIP left the page: with budget left and a chaining entry for the new
    /// linear page (pages::CHAIN, tagged with the access cache epoch), write
    /// the state back and tail-call that page's function, which counts on
    /// from the instructions retired so far (gp::x64_page_chain). Else
    /// return to the dispatch loop.
    fn chain(&mut self) {
        self.gi(N);
        self.gi(K);
        self.b.add_i32();
        self.b.get_local(&self.budget);
        self.b.ltu_i32();
        if cfg!(feature = "parallel") {
            // (cores in workers: not while code publications or invalidations
            // of other cores wait for this one, see parallel::code::poll)
            let [publish, publish_seen, invalidate, invalidate_seen] =
                unsafe { crate::parallel::code::pending_addresses() };
            for (next, seen) in [(publish, publish_seen), (invalidate, invalidate_seen)] {
                self.c32(next as i32);
                self.b.guest_load_i32(0);
                self.c32(seen as i32);
                self.b.load_aligned_i32(0);
                self.b.eq_i32();
                self.b.and_i32();
            }
            // nor when another core kicked this one
            self.c32(&raw const crate::cpu::cpu::core_yield as i32);
            self.b.guest_load_u8(0);
            self.b.eqz_i32();
            self.b.and_i32();
        }
        self.b.if_void();
        self.g(RIP);
        self.c64(12);
        self.b.shr_u_i64();
        self.s(TAG);
        self.g(TAG);
        self.b.wrap_i64_to_i32();
        self.c32(super::pages::CHAIN_ENTRIES as i32 - 1);
        self.b.and_i32();
        self.c32(4);
        self.b.shl_i32();
        self.b.load_fixed_i32(gp::x64_code_base as u32);
        self.b.add_i32();
        self.si(ENT);
        self.gi(ENT);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.g(TAG);
        self.g(EP);
        self.b.or_i64();
        self.b.eq_i64();
        self.b.if_void();
        // the state goes to memory, EFLAGS with the lazy record unevaluated:
        // the next function continues with it (its prologue)
        self.writeback();
        self.c32(gp::x64_page_lazy_kind as i32);
        self.gi(FK);
        self.b.store_aligned_i32(0);
        self.c32(gp::x64_page_lazy_a as i32);
        self.g(FA);
        self.b.store_aligned_i64(0);
        self.c32(gp::x64_page_lazy_b as i32);
        self.g(FB);
        self.b.store_aligned_i64(0);
        self.c32(gp::x64_page_linear as i32);
        self.g(RIP);
        self.c64(!4095);
        self.b.and_i64();
        self.b.store_aligned_i64(0);
        self.c32(gp::x64_page_chain as i32);
        self.b.load_fixed_i32(gp::x64_page_chain as u32);
        self.gi(N);
        self.b.add_i32();
        self.b.store_aligned_i32(0);
        self.b.get_local(&self.budget);
        self.gi(N);
        self.b.sub_i32();
        self.gi(K);
        self.b.sub_i32();
        self.gi(ENT);
        self.b.load_aligned_i32(8);
        self.b.return_call_indirect_fn1();
        self.b.block_end();
        self.b.block_end();
        self.materialize_if(ARITH);
        self.writeback();
        self.gi(N);
        self.b.return_();
    }
    /// Retry the branch at `start` unless its target outside the page is
    /// canonical where the page runs (a noncanonical target is #GP at the
    /// branch).
    fn check_target(&mut self, target: u64, start: u64) {
        if in_page(0, target).is_none() {
            self.linear(target);
            self.s(TX);
            self.check_canonical(TX, start);
        }
    }
    /// Continue at the address in RIP (checked by dispatch).
    fn dispatch(&mut self) { self.b.br(self.f().dispatch); }
    fn block(&mut self, block: &Block, index: &BTreeMap<u16, usize>) {
        if unsafe { BLOCK_COUNT } {
            // (a block left early, by a retry or a step, counts the rest of
            // its instructions too: N bounds activations and feeds statistics)
            let native = block
                .insts
                .iter()
                .filter(|i| !matches!(i.op, Op::Step))
                .count();
            if native != 0 {
                self.gi(N);
                self.c32(native as i32);
                self.b.add_i32();
                self.si(N);
            }
        }
        for inst in &block.insts {
            self.instruction(inst, index);
        }
        match block.end {
            End::Stop => {},
            End::Retry(o) => self.leave_to(self.f().retry, o as u64),
            End::StepAt(o) => self.leave_to(self.f().step, o as u64),
            End::Next(o) => {
                if !block.insts.last().is_some_and(|i| matches!(i.op, Op::Step))
                    && index.get(&o) != Some(&(self.current + 1))
                {
                    self.goto(o as u64, index);
                }
            },
        }
    }

    // Operands ----------------------------------------------------------

    fn get_reg(&mut self, r: Reg, width: u8) {
        self.g(r.index as usize);
        if r.high {
            self.c64(8);
            self.b.shr_u_i64();
            self.c64(0xFF);
            self.b.and_i64();
        }
        else if width < 64 {
            self.c64(mask(width));
            self.b.and_i64();
        }
    }
    /// Write the value on the stack (low `width` bits) with x86-64 register
    /// semantics: 32-bit writes zero-extend, 8/16-bit writes merge.
    fn set_reg(&mut self, r: Reg, width: u8) {
        let i = r.index as usize;
        match width {
            64 => self.s(i),
            32 => {
                self.b.wrap_i64_to_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.s(i);
            },
            _ => {
                self.c64(mask(width));
                self.b.and_i64();
                let keep = if r.high {
                    self.c64(8);
                    self.b.shl_i64();
                    !0xFF00u64
                }
                else {
                    !mask(width)
                };
                self.g(i);
                self.c64(keep);
                self.b.and_i64();
                self.b.or_i64();
                self.s(i);
            },
        }
    }
    /// Push the address of a memory operand: the effective address wrapped
    /// to its size, plus the FS/GS base when `segment` (not for LEA).
    fn address(&mut self, a: &AddressExpr, next: u64, segment: bool) {
        let mut have = false;
        let mut displacement = a.displacement;
        match a.base {
            AddressBase::Register(r) => {
                self.g(r as usize);
                have = true;
            },
            AddressBase::NextRip => {
                self.linear((next as i64).wrapping_add(displacement) as u64);
                displacement = 0;
                have = true;
            },
            AddressBase::None => {},
        }
        if let Some(i) = a.index {
            self.g(i as usize);
            if a.scale != 0 {
                self.c64(a.scale as u64);
                self.b.shl_i64();
            }
            if have {
                self.b.add_i64();
            }
            have = true;
        }
        if !have {
            self.c64(displacement as u64);
        }
        else if displacement != 0 {
            self.c64(displacement as u64);
            self.b.add_i64();
        }
        match a.address_size {
            32 => {
                self.b.wrap_i64_to_i32();
                self.b.extend_unsigned_i32_to_i64();
            },
            16 => {
                self.c64(0xFFFF);
                self.b.and_i64();
            },
            _ => {},
        }
        if segment && a.segment >= 4 {
            let s = a.segment as u32;
            self.load_pair(
                gp::segment_offsets as u32 + s * 4,
                gp::x64_segment_base_hi as u32 + s * 4,
            );
            self.b.add_i64();
        }
    }
    /// Host address (i32) of a `size`-byte access at the linear address in
    /// ADDR: an access cache hit, else x64_page_access, else a retry of the
    /// instruction at `start`.
    fn host(&mut self, size: u32, write: bool, start: u64) {
        self.host_or(size, write, start, self.f().retry)
    }
    /// host(), leaving for `fallback` (retry, or step) when refused.
    /// The module's internal function (addr: i64, kind: i32) -> i32: the
    /// host address for a `kind & 255`-byte access (bit 8: write) at linear
    /// addr from the access cache (x64::jac), else x64_page_access; 0 when
    /// refused. The same lookup host_or otherwise inlines.
    fn access_function(&mut self) -> u32 {
        if let Some(f) = self.access {
            return f;
        }
        use crate::leb::{write_leb_i32, write_leb_u32};
        debug_assert!(jac::WRITE_OFFSET == 1 << 15 && jac::ENTRY_BYTES == 16);
        let slow = self.b.import_index(
            "x64_page_access",
            Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
        );
        // locals: tag (i64), entry, offset, host (i32)
        let mut c: Vec<u8> = vec![2, 1, op::TYPE_I64, 3, op::TYPE_I32];
        let i32c = |c: &mut Vec<u8>, v: i32| {
            c.push(op::OP_I32CONST);
            write_leb_i32(c, v);
        };
        // tag = addr >> 12 | epoch bits (local 2)
        c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_I64CONST, 12, op::OP_I64SHRU]);
        i32c(&mut c, gp::x64_jac_epoch as i32);
        c.extend_from_slice(&[op::OP_I64LOAD, 3, 0, op::OP_I64OR, op::OP_TEELOCAL, 2]);
        // entry = table base + (tag & (ENTRIES - 1)) * 16 (+ write tables) (local 3)
        c.push(op::OP_I32WRAPI64);
        i32c(&mut c, jac::ENTRIES as i32 - 1);
        c.push(op::OP_I32AND);
        i32c(&mut c, 4);
        c.push(op::OP_I32SHL);
        i32c(&mut c, gp::x64_jac_base as i32);
        c.extend_from_slice(&[op::OP_I32LOAD, 2, 0, op::OP_I32ADD, op::OP_GETLOCAL, 1]);
        i32c(&mut c, 8);
        c.push(op::OP_I32SHRU);
        i32c(&mut c, 1);
        c.push(op::OP_I32AND);
        i32c(&mut c, 15);
        c.extend_from_slice(&[op::OP_I32SHL, op::OP_I32ADD, op::OP_SETLOCAL, 3]);
        // offset in the page (local 4)
        c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_I32WRAPI64]);
        i32c(&mut c, 4095);
        c.extend_from_slice(&[op::OP_I32AND, op::OP_SETLOCAL, 4]);
        // hit: tag matches and the access stays in the page
        c.extend_from_slice(&[
            op::OP_GETLOCAL,
            3,
            op::OP_I64LOAD,
            3,
            0,
            op::OP_GETLOCAL,
            2,
            op::OP_I64EQ,
        ]);
        c.extend_from_slice(&[op::OP_GETLOCAL, 4]);
        i32c(&mut c, 4096);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.extend_from_slice(&[op::OP_I32AND, op::OP_I32SUB, op::OP_I32LEU, op::OP_I32AND]);
        c.extend_from_slice(&[op::OP_IF, op::TYPE_I32]);
        c.extend_from_slice(&[
            op::OP_GETLOCAL,
            3,
            op::OP_I32LOAD,
            2,
            8,
            op::OP_GETLOCAL,
            4,
            op::OP_I32ADD,
        ]);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            // Cores in workers access guest memory with atomics, which need
            // natural alignment (min(size, 8)). An unaligned read is copied
            // with plain loads, then a fence (x86 orders it before later
            // loads), to an aligned buffer (pages::BOUNCE) the caller reads.
            // An unaligned write host is returned as it is when the caller
            // stores unaligned itself (kind bit 9: host_store), else the
            // slow path refuses it (retried).
            c.extend_from_slice(&[op::OP_TEELOCAL, 5, op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 8);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 8);
            c.extend_from_slice(&[op::OP_I32LTU, op::OP_SELECT]);
            i32c(&mut c, 1);
            c.extend_from_slice(&[op::OP_I32SUB, op::OP_I32AND, op::OP_IF, op::TYPE_I32]);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 0x100);
            c.extend_from_slice(&[op::OP_I32AND, op::OP_IF, op::TYPE_I32]);
            // (a write whose code handles unaligned hosts, bit 9: store)
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 0x200);
            c.extend_from_slice(&[
                op::OP_I32AND,
                op::OP_IF,
                op::TYPE_I32,
                op::OP_GETLOCAL,
                5,
                op::OP_ELSE,
            ]);
            c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_GETLOCAL, 1, op::OP_CALL]);
            write_leb_u32(&mut c, slow);
            c.push(op::OP_END);
            c.push(op::OP_ELSE);
            let bounce = unsafe { super::pages::bounce_address() } as i32;
            // (sizes 2, 4, 8, 16: the first 8 bytes or fewer, then the rest)
            let copy = |c: &mut Vec<u8>, load: u8, store: u8, align: u8, offset: u32| {
                i32c(c, bounce);
                c.extend_from_slice(&[op::OP_GETLOCAL, 5, load, 0]);
                write_leb_u32(c, offset);
                c.extend_from_slice(&[store, align]);
                write_leb_u32(c, offset);
            };
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 4);
            c.extend_from_slice(&[op::OP_I32LTU, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I32LOAD16U, op::OP_I32STORE16, 1, 0);
            c.push(op::OP_ELSE);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 4);
            c.extend_from_slice(&[op::OP_I32EQ, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I32LOAD, op::OP_I32STORE, 2, 0);
            c.push(op::OP_ELSE);
            copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 0);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 16);
            c.extend_from_slice(&[op::OP_I32EQ, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 8);
            c.extend_from_slice(&[op::OP_END, op::OP_END, op::OP_END]);
            c.extend_from_slice(&[0xFE, 0x03, 0x00]); // atomic.fence
            i32c(&mut c, bounce);
            c.extend_from_slice(&[op::OP_END, op::OP_ELSE, op::OP_GETLOCAL, 5, op::OP_END]);
        }
        c.extend_from_slice(&[
            op::OP_ELSE,
            op::OP_GETLOCAL,
            0,
            op::OP_GETLOCAL,
            1,
            op::OP_CALL,
        ]);
        write_leb_u32(&mut c, slow);
        c.extend_from_slice(&[op::OP_END, op::OP_END]);
        let f = self.b.add_internal_function(
            Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            c,
        );
        self.access = Some(f);
        f
    }
    /// The host address of a store or read-modify-write of `size` bytes at
    /// ADDR (else a retry). With cores in workers it may be unaligned:
    /// store() and load_any() handle that.
    fn host_store(&mut self, size: u32, start: u64) {
        if WasmBuilder::ATOMIC_GUEST_MEMORY && unsafe { OUTLINE_ACCESS } && size > 1 {
            self.host_kind(size, 0x300, start, self.f().retry)
        }
        else {
            self.host(size, true, start)
        }
    }
    fn host_or(&mut self, size: u32, write: bool, start: u64, fallback: Label) {
        self.host_kind(size, (write as u32) << 8, start, fallback)
    }
    /// host_or() with the lookup's kind bits (write: 0x100, unaligned write
    /// hosts accepted: 0x200; outlined lookups only)
    fn host_kind(&mut self, size: u32, bits: u32, start: u64, fallback: Label) {
        let write = bits & 0x100 != 0;
        if unsafe { OUTLINE_ACCESS } {
            let f = self.access_function();
            self.g(ADDR);
            self.c32((size | bits) as i32);
            self.b.call_internal(f);
            self.ti(HH);
            self.b.eqz_i32();
            self.b.if_void();
            self.leave_to(fallback, start);
            self.b.block_end();
            self.gi(HH);
            return;
        }
        let table = if write { jac::WRITE_OFFSET } else { 0 };
        self.g(ADDR);
        self.c64(12);
        self.b.shr_u_i64();
        self.g(EP);
        self.b.or_i64();
        self.s(TAG);
        self.g(TAG);
        self.b.wrap_i64_to_i32();
        self.c32(jac::ENTRIES as i32 - 1);
        self.b.and_i32();
        self.c32(4);
        self.b.shl_i32();
        self.gi(JAC);
        self.b.add_i32();
        self.si(ENT);
        self.g(ADDR);
        self.b.wrap_i64_to_i32();
        self.c32(4095);
        self.b.and_i32();
        self.si(OFF);
        self.gi(ENT);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, table);
        self.g(TAG);
        self.b.eq_i64();
        self.gi(OFF);
        self.c32((4096 - size) as i32);
        self.b.leu_i32();
        self.b.and_i32();
        if WasmBuilder::ATOMIC_GUEST_MEMORY && size > 1 {
            // atomic accesses (cores in workers) need natural alignment; the
            // slow path refuses unaligned ones (x64_page_access)
            self.gi(OFF);
            self.c32(size.min(8) as i32 - 1);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.and_i32();
        }
        self.b.hint(true);
        self.b.if_i32();
        self.gi(ENT);
        self.b.load_aligned_i32(table + 8);
        self.gi(OFF);
        self.b.add_i32();
        self.b.else_();
        self.g(ADDR);
        self.c32(size as i32 | (write as i32) << 8);
        self.b.call_signature(
            "x64_page_access",
            Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
        );
        self.ti(HH);
        self.b.eqz_i32();
        self.b.if_void();
        self.leave_to(fallback, start);
        self.b.block_end();
        self.gi(HH);
        self.b.block_end();
    }
    fn load(&mut self, width: u8) { self.b.guest_load_i64_bits(width as u32, 0); }
    /// [host, value] -> []. With cores in workers, an unaligned host (see
    /// host_store) is a plain store after a fence (x86 orders it after the
    /// accesses before it), as the interpreter does.
    fn store(&mut self, width: u8) {
        if !WasmBuilder::ATOMIC_GUEST_MEMORY || width == 8 {
            return self.b.guest_store_i64_bits(width as u32, 0);
        }
        self.s(SV);
        self.ti(SH);
        self.c32(width as i32 / 8 - 1);
        self.b.and_i32();
        self.b.if_void();
        self.b.guest_fence();
        self.gi(SH);
        self.g(SV);
        self.b.memory_op(
            match width {
                16 => op::OP_I64STORE16,
                32 => op::OP_I64STORE32,
                _ => op::OP_I64STORE,
            },
            op::MEM_NO_ALIGN,
            0,
        );
        self.b.else_();
        self.gi(SH);
        self.g(SV);
        self.b.guest_store_i64_bits(width as u32, 0);
        self.b.block_end();
    }
    /// load() from a host of host_store: [host] -> [value]; unaligned (cores
    /// in workers) a plain load, then a fence
    fn load_any(&mut self, width: u8) {
        if !WasmBuilder::ATOMIC_GUEST_MEMORY || width == 8 {
            return self.load(width);
        }
        self.ti(SH);
        self.c32(width as i32 / 8 - 1);
        self.b.and_i32();
        self.b.if_i64();
        self.gi(SH);
        self.b.memory_op(
            match width {
                16 => op::OP_I64LOAD16U,
                32 => op::OP_I64LOAD32U,
                _ => op::OP_I64LOAD,
            },
            op::MEM_NO_ALIGN,
            0,
        );
        self.b.guest_fence();
        self.b.else_();
        self.gi(SH);
        self.load(width);
        self.b.block_end();
    }
    /// Push the (zero-extended) value of a source operand.
    fn read(&mut self, o: Opnd, width: u8, inst: &Inst) {
        match o {
            Opnd::Reg(r) => self.get_reg(r, width),
            Opnd::Imm(v) => self.c64(v & mask(width)),
            Opnd::Mem(a) => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host(width as u32 / 8, false, inst.d.start.0);
                self.load(width);
            },
        }
    }
    /// Read a destination operand; a memory one is validated for writing
    /// first when `write` (its host address stays in HOST).
    fn read_dst(&mut self, o: Opnd, width: u8, write: bool, inst: &Inst) {
        match o {
            Opnd::Mem(a) if inst.locked => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host(width as u32 / 8, true, inst.d.start.0);
                self.si(HOST);
                self.locked_load(width);
            },
            Opnd::Mem(a) if write => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host_store(width as u32 / 8, inst.d.start.0);
                self.ti(HOST);
                self.load_any(width);
            },
            Opnd::Mem(a) => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host(width as u32 / 8, false, inst.d.start.0);
                self.ti(HOST);
                self.load(width);
            },
            _ => self.read(o, width, inst),
        }
    }
    /// A locked instruction (cores in workers) with its operand's host
    /// address in HOST: from here to write_dst is a loop that computes from
    /// the value read, and commits with a compare-exchange; it starts over
    /// when another core changed the operand meanwhile. Pushes the value.
    fn locked_load(&mut self, width: u8) {
        debug_assert!(self.lock_loop.is_none());
        self.lock_loop = Some(self.b.loop_void());
        self.gi(HOST);
        self.load(width);
        self.s(OLD);
        self.g(OLD);
    }
    /// The locked instruction's write: [] -> [], leaves the loop when the
    /// compare-exchange found the value read. It commits as the
    /// interpreter's does (x64_page_lock_commit: never interleaved with a
    /// split locked operation on the same bytes).
    fn locked_store(&mut self, width: u8, value: usize) {
        let again = self.lock_loop.take().unwrap();
        self.gi(HOST);
        self.g(OLD);
        self.g(value);
        self.c32(width as i32 / 8);
        self.b.call_signature(
            "x64_page_lock_commit",
            Signature::new(
                &[WasmType::I32, WasmType::I64, WasmType::I64, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.b.eqz_i32();
        self.b.br_if(again);
        self.b.block_end();
    }
    /// Store local `value` to a destination read by read_dst.
    fn write_dst(&mut self, o: Opnd, width: u8, value: usize) {
        if self.lock_loop.is_some() {
            return self.locked_store(width, value);
        }
        match o {
            Opnd::Reg(r) => {
                self.g(value);
                self.set_reg(r, width);
            },
            Opnd::Mem(_) => {
                self.gi(HOST);
                self.g(value);
                self.store(width);
            },
            Opnd::Imm(_) => unreachable!(),
        }
    }
    /// Validate a memory destination for writing without reading it.
    fn prepare_store(&mut self, a: &AddressExpr, width: u8, inst: &Inst) {
        self.address(a, inst.d.next.0, true);
        self.s(ADDR);
        self.host_store(width as u32 / 8, inst.d.start.0);
        self.si(HOST);
    }
    fn mask_to(&mut self, width: u8) {
        if width < 64 {
            self.c64(mask(width));
            self.b.and_i64();
        }
    }
    /// Sign-extend the `width`-bit value on the stack to 64 bits.
    fn sext(&mut self, width: u8) {
        if width < 64 {
            self.c64(64 - width as u64);
            self.b.shl_i64();
            self.c64(64 - width as u64);
            self.b.shr_s_i64();
        }
    }
    /// Retry the instruction unless the address in local `i` is canonical.
    fn check_canonical(&mut self, i: usize, start: u64) {
        self.g(i);
        self.c64(16);
        self.b.shl_i64();
        self.c64(16);
        self.b.shr_s_i64();
        self.g(i);
        self.b.ne_i64();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// Push the stack slot `delta` bytes from RSP into ADDR, validated as a
    /// `write` access; host address in HOST.
    fn stack(&mut self, delta: i64, write: bool, start: u64) {
        self.g(4);
        if delta != 0 {
            self.c64(delta as u64);
            self.b.add_i64();
        }
        self.s(ADDR);
        self.host(8, write, start);
        self.si(HOST);
    }

    // EFLAGS ------------------------------------------------------------

    /// Combine the i32 terms pushed so far (see flags_begin/flags_end).
    fn join(&mut self, first: &mut bool) {
        if !*first {
            self.b.or_i32();
        }
        *first = false;
    }
    fn flags_begin(&mut self, need: u32) {
        self.gi(FL);
        self.c32(!need as i32);
        self.b.and_i32();
    }
    fn flags_end(&mut self, first: bool) {
        if first {
            self.c32(0);
        }
        self.b.or_i32();
        self.si(FL);
    }
    /// i32: bit `bit` of i64 local `i`, moved to bit `to`.
    fn bit_of(&mut self, i: usize, bit: u8, to: u8) {
        self.g(i);
        if bit != 0 {
            self.c64(bit as u64);
            self.b.shr_u_i64();
        }
        self.b.wrap_i64_to_i32();
        self.c32(1);
        self.b.and_i32();
        if to != 0 {
            self.c32(to as i32);
            self.b.shl_i32();
        }
    }
    /// i32: 1 when the low byte of local `i` has even parity.
    fn parity(&mut self, i: usize) {
        self.g(i);
        self.b.wrap_i64_to_i32();
        self.c32(0xFF);
        self.b.and_i32();
        self.b.popcnt_i32();
        self.c32(1);
        self.b.and_i32();
        self.c32(1);
        self.b.xor_i32();
    }
    fn is_zero(&mut self, i: usize) {
        self.g(i);
        self.b.op(op::OP_I64EQZ);
    }
    /// SF, ZF, PF of local `i` (masked to `width`).
    fn szp(&mut self, i: usize, need: u32, width: u8, first: &mut bool) {
        if need & PF != 0 {
            self.parity(i);
            self.c32(2);
            self.b.shl_i32();
            self.join(first);
        }
        if need & ZF != 0 {
            self.is_zero(i);
            self.c32(6);
            self.b.shl_i32();
            self.join(first);
        }
        if need & SF != 0 {
            self.bit_of(i, width - 1, 7);
            self.join(first);
        }
    }
    /// Flags of ALU `code` over TA (a), TB (b), TR (result, masked). ADC and
    /// SBB read their CF input from FL before it is replaced.
    fn alu_flags(&mut self, code: u8, width: u8, need: u32) {
        if need == 0 {
            return;
        }
        let logic = matches!(code, 1 | 4 | 6);
        let add = matches!(code, 0 | 2);
        let carry = matches!(code, 2 | 3);
        self.flags_begin(need);
        let mut first = true;
        self.szp(TR, need, width, &mut first);
        if !logic {
            if need & CF != 0 {
                let (x, y) = if add { (TR, TA) } else { (TA, TB) };
                self.g(x);
                self.g(y);
                self.b.ltu_i64();
                if carry {
                    self.g(x);
                    self.g(y);
                    self.b.eq_i64();
                    self.gi(CI);
                    self.b.and_i32();
                    self.b.or_i32();
                }
                self.join(&mut first);
            }
            if need & AF != 0 {
                self.g(TA);
                self.g(TB);
                self.b.xor_i64();
                self.g(TR);
                self.b.xor_i64();
                self.b.wrap_i64_to_i32();
                self.c32(AF as i32);
                self.b.and_i32();
                self.join(&mut first);
            }
            if need & OF != 0 {
                if add {
                    self.g(TA);
                    self.g(TR);
                    self.b.xor_i64();
                    self.g(TB);
                    self.g(TR);
                    self.b.xor_i64();
                }
                else {
                    self.g(TA);
                    self.g(TB);
                    self.b.xor_i64();
                    self.g(TA);
                    self.g(TR);
                    self.b.xor_i64();
                }
                self.b.and_i64();
                self.s(TX);
                self.bit_of(TX, width - 1, 11);
                self.join(&mut first);
            }
        }
        self.flags_end(first);
    }
    /// After a producer computed the `eager` part of the flags it `writes`:
    /// the rest becomes the lazy record (operands TA, TB; kind; carry CI).
    fn record(&mut self, code: u8, width: u8, writes: u32, eager: u32, inst: &Inst) {
        let pending = writes & !eager;
        if pending != 0 || inst.keep {
            self.g(TA);
            self.s(FA);
            self.g(TB);
            self.s(FB);
            self.g(TR);
            self.s(FR);
        }
        if pending != 0 {
            let kind = (code as u32) << 16 | (width.trailing_zeros() - 3) << 20 | pending;
            self.c32(kind as i32);
            if matches!(code, 2 | 3) {
                self.gi(CI);
                self.c32(23);
                self.b.shl_i32();
                self.b.or_i32();
            }
        }
        else {
            self.c32(0);
        }
        self.si(FK);
    }
    /// A partial writer computed all of `bits` into FL: they are no longer
    /// pending in the record.
    fn written(&mut self, bits: u32) {
        self.gi(FK);
        self.c32(!bits as i32);
        self.b.and_i32();
        self.si(FK);
    }
    /// Make `bits` of FL current before reading them.
    fn materialize_if(&mut self, bits: u32) {
        if bits & ARITH == 0 {
            return;
        }
        self.gi(FK);
        self.c32((bits & ARITH) as i32);
        self.b.and_i32();
        self.b.hint(false);
        self.b.if_void();
        self.gi(FK);
        self.g(FA);
        self.g(FB);
        self.gi(FL);
        self.b.call_signature(
            "x64_page_flags",
            Signature::new(
                &[WasmType::I32, WasmType::I64, WasmType::I64, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.si(FL);
        self.c32(0);
        self.si(FK);
        self.b.block_end();
    }
    /// Push condition `cc` (i32 0/1): from the kept producer operands when
    /// fused, else from FL.
    fn condition(&mut self, cc: u8, fused: Option<Known>) {
        match fused {
            Some(Known::Sub(w)) => match cc >> 1 {
                0 => {
                    self.g(FA);
                    self.g(FB);
                    self.b.xor_i64();
                    self.g(FA);
                    self.g(FR);
                    self.b.xor_i64();
                    self.b.and_i64();
                    self.s(TX);
                    self.bit_of(TX, w - 1, 0);
                },
                1 => {
                    self.g(FA);
                    self.g(FB);
                    self.b.ltu_i64();
                },
                2 => {
                    self.g(FA);
                    self.g(FB);
                    self.b.eq_i64();
                },
                3 => {
                    self.g(FA);
                    self.g(FB);
                    self.b.op(op::OP_I64LEU);
                },
                4 => self.bit_of(FR, w - 1, 0),
                5 => self.parity(FR),
                6 => {
                    self.g(FA);
                    self.sext(w);
                    self.g(FB);
                    self.sext(w);
                    self.b.lt_i64();
                },
                _ => {
                    self.g(FA);
                    self.sext(w);
                    self.g(FB);
                    self.sext(w);
                    self.b.op(op::OP_I64LES);
                },
            },
            Some(Known::Logic(w)) | Some(Known::Result(w)) => match cc >> 1 {
                0 | 1 => self.c32(0),
                2 | 3 => self.is_zero(FR),
                4 | 6 => self.bit_of(FR, w - 1, 0),
                5 => self.parity(FR),
                _ => {
                    self.g(FR);
                    self.sext(w);
                    self.c64(0);
                    self.b.op(op::OP_I64LES);
                },
            },
            None => {
                let bit = |e: &mut Self, shift: i32| {
                    e.gi(FL);
                    if shift != 0 {
                        e.c32(shift);
                        e.b.shr_u_i32();
                    }
                };
                match cc >> 1 {
                    0 => bit(self, 11),
                    1 => bit(self, 0),
                    2 => bit(self, 6),
                    3 => {
                        self.gi(FL);
                        self.c32((CF | ZF) as i32);
                        self.b.and_i32();
                        self.c32(0);
                        self.b.ne_i32();
                    },
                    4 => bit(self, 7),
                    5 => bit(self, 2),
                    6 => {
                        bit(self, 7);
                        bit(self, 11);
                        self.b.xor_i32();
                    },
                    _ => {
                        bit(self, 7);
                        bit(self, 11);
                        self.b.xor_i32();
                        bit(self, 6);
                        self.b.or_i32();
                    },
                }
                if cc >> 1 != 3 {
                    self.c32(1);
                    self.b.and_i32();
                }
            },
        }
        if cc & 1 != 0 {
            self.b.eqz_i32();
        }
    }
}

impl Emitter {
    fn instruction(&mut self, inst: &Inst, index: &BTreeMap<u16, usize>) {
        if unsafe { (*(&raw const SIZE_STATS)).is_none() } {
            return self.instruction_inner(inst, index);
        }
        let before = self.b.body_len();
        self.instruction_inner(inst, index);
        let name = format!("{:?}", inst.op);
        let name = name
            .split([' ', '{', '('])
            .next()
            .unwrap_or("?")
            .to_string();
        size_note(name, self.b.body_len() - before);
    }
    fn instruction_inner(&mut self, inst: &Inst, index: &BTreeMap<u16, usize>) {
        let start = inst.d.start.0;
        let next = inst.d.next.0;
        let need = inst.writes & inst.live_out;
        if let (Some((word, count)), false) = (inst.straddle, matches!(inst.op, Op::Step)) {
            // the next page still fetches as compiled, else step it
            self.c64(word);
            self.c32(count as i32);
            self.b.call_signature(
                "x64_page_straddle",
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
            self.b.eqz_i32();
            self.b.if_void();
            self.leave_to(self.f().step, start);
            self.b.block_end();
        }
        match inst.op {
            Op::Step => {
                self.leave_to(self.f().step, start);
                return;
            },
            Op::Nop => {},
            Op::Mov { width, dst, src } => match dst {
                Opnd::Reg(r) => {
                    self.read(src, width, inst);
                    self.set_reg(r, width);
                },
                Opnd::Mem(a) => {
                    self.prepare_store(&a, width, inst);
                    self.gi(HOST);
                    self.read(src, width, inst);
                    self.store(width);
                },
                Opnd::Imm(_) => unreachable!(),
            },
            Op::Extend {
                width,
                from,
                signed,
                dst,
                src,
            } => {
                self.read(src, from, inst);
                if signed {
                    self.sext(from);
                }
                self.set_reg(dst, width);
            },
            Op::Lea {
                width,
                dst,
                address,
            } => {
                self.address(&address, next, false);
                self.set_reg(dst, width);
            },
            Op::Alu {
                code,
                width,
                dst,
                src,
            } => {
                if matches!(code, 5 | 6)
                    && matches!((dst, src), (Opnd::Reg(a), Opnd::Reg(b)) if a == b)
                {
                    // SUB/XOR of a register with itself
                    self.c64(0);
                    self.set_reg(dst.reg().unwrap(), width);
                    self.gi(FL);
                    self.c32(!ARITH as i32);
                    self.b.and_i32();
                    self.c32((ZF | PF) as i32);
                    self.b.or_i32();
                    self.si(FL);
                    self.c32(0);
                    self.si(FK);
                    if inst.keep {
                        for l in [FA, FB, FR] {
                            self.c64(0);
                            self.s(l);
                        }
                    }
                }
                else {
                    if matches!(code, 2 | 3) {
                        self.materialize_if(CF);
                        self.gi(FL);
                        self.c32(1);
                        self.b.and_i32();
                        self.si(CI);
                    }
                    self.read_dst(dst, width, code != 7, inst);
                    self.s(TA);
                    self.read(src, width, inst);
                    self.s(TB);
                    self.g(TA);
                    self.g(TB);
                    match code {
                        0 | 2 => self.b.add_i64(),
                        1 => self.b.or_i64(),
                        3 | 5 | 7 => self.b.sub_i64(),
                        4 => self.b.and_i64(),
                        _ => self.b.xor_i64(),
                    }
                    if matches!(code, 2 | 3) {
                        self.gi(CI);
                        self.b.extend_unsigned_i32_to_i64();
                        if code == 2 {
                            self.b.add_i64();
                        }
                        else {
                            self.b.sub_i64();
                        }
                    }
                    if !matches!(code, 1 | 4 | 6) {
                        self.mask_to(width);
                    }
                    self.s(TR);
                    if code != 7 {
                        self.write_dst(dst, width, TR);
                    }
                    self.alu_flags(code, width, need);
                    self.record(code, width, ARITH, need, inst);
                }
            },
            Op::Test { width, a, b } => {
                self.read(a, width, inst);
                self.s(TA);
                self.read(b, width, inst);
                self.s(TB);
                self.g(TA);
                self.g(TB);
                self.b.and_i64();
                self.s(TR);
                self.alu_flags(4, width, need);
                self.record(4, width, ARITH, need, inst);
            },
            Op::IncDec { dec, width, dst } => {
                // CF survives: its pending value must not be lost with the record
                self.materialize_if(CF);
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                self.c64(1);
                self.s(TB);
                self.g(TA);
                self.c64(1);
                if dec {
                    self.b.sub_i64();
                }
                else {
                    self.b.add_i64();
                }
                self.mask_to(width);
                self.s(TR);
                self.write_dst(dst, width, TR);
                self.alu_flags(if dec { 5 } else { 0 }, width, need);
                self.record(if dec { 5 } else { 0 }, width, ARITH & !CF, need, inst);
            },
            Op::Neg { width, dst } => {
                self.read_dst(dst, width, true, inst);
                self.s(TB);
                self.c64(0);
                self.s(TA);
                self.c64(0);
                self.g(TB);
                self.b.sub_i64();
                self.mask_to(width);
                self.s(TR);
                self.write_dst(dst, width, TR);
                self.alu_flags(5, width, need);
                self.record(5, width, ARITH, need, inst);
            },
            Op::Not { width, dst } => {
                self.read_dst(dst, width, true, inst);
                self.c64(mask(width));
                self.b.xor_i64();
                self.s(TR);
                self.write_dst(dst, width, TR);
            },
            Op::Shift {
                code,
                width,
                dst,
                count: Some(count),
            } => {
                self.shift_immediate(inst, code, width, dst, count, inst.writes);
                self.written(inst.writes);
            },
            Op::Shift {
                code,
                width,
                dst,
                count: None,
            } => {
                // a zero count keeps every flag
                self.materialize_if(inst.flags_read);
                self.shift_cl(inst, code, width, dst, inst.writes);
                self.written(inst.writes);
            },
            Op::ShiftCall {
                code,
                width,
                dst,
                count,
            } => {
                self.materialize_if(ARITH);
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                self.g(TA);
                match count {
                    Some(count) => self.c32(count as i32),
                    None => {
                        self.g(1);
                        self.b.wrap_i64_to_i32();
                    },
                }
                self.gi(FL);
                self.c32(code as i32 | (width as i32) << 8);
                self.b.call_signature(
                    "x64_page_shift",
                    Signature::new(
                        &[WasmType::I64, WasmType::I32, WasmType::I32, WasmType::I32],
                        &[WasmType::I64],
                    ),
                );
                self.s(TV);
                self.g(TV);
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
                self.s(TR);
                self.write_dst(dst, width, TR);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.si(FL);
                self.written(ARITH);
            },
            Op::Imul { width, dst, a, b } => {
                self.read(a, width, inst);
                self.s(TA);
                self.read(b, width, inst);
                self.s(TB);
                if width == 64 {
                    self.g(TA);
                    self.g(TB);
                    self.b.mul_i64();
                    self.s(TR);
                }
                else {
                    self.g(TA);
                    self.sext(width);
                    self.g(TB);
                    self.sext(width);
                    self.b.mul_i64();
                    self.s(TV);
                    self.g(TV);
                    self.mask_to(width);
                    self.s(TR);
                }
                self.g(TR);
                self.set_reg(dst, width);
                let need = inst.writes;
                if need != 0 {
                    self.flags_begin(need);
                    if width == 64 {
                        // the high half is not the sign extension of the low
                        self.mul_high(TA, TB, true);
                        self.g(TR);
                        self.c64(63);
                        self.b.shr_s_i64();
                        self.b.ne_i64();
                    }
                    else {
                        self.g(TR);
                        self.sext(width);
                        self.g(TV);
                        self.b.ne_i64();
                    }
                    self.c32((CF | OF) as i32);
                    self.b.mul_i32();
                    self.c32(need as i32);
                    self.b.and_i32();
                    self.flags_end(false);
                    self.written(need);
                }
            },
            Op::MulWide { signed, width, src } => {
                self.get_reg(RAX, width);
                self.s(TA);
                self.read(src, width, inst);
                self.s(TB);
                if width == 64 {
                    self.g(TA);
                    self.g(TB);
                    self.b.mul_i64();
                    self.s(TR);
                    self.mul_high(TA, TB, signed);
                    self.s(TV);
                }
                else {
                    self.g(TA);
                    if signed {
                        self.sext(32);
                    }
                    self.g(TB);
                    if signed {
                        self.sext(32);
                    }
                    self.b.mul_i64();
                    self.s(TC);
                    self.g(TC);
                    self.mask_to(32);
                    self.s(TR);
                    self.g(TC);
                    self.c64(32);
                    self.b.shr_u_i64();
                    self.mask_to(32);
                    self.s(TV);
                }
                self.g(TR);
                self.set_reg(RAX, width);
                self.g(TV);
                self.set_reg(RDX, width);
                let need = inst.writes;
                if need != 0 {
                    self.flags_begin(need);
                    match (signed, width) {
                        (false, _) => {
                            self.g(TV);
                            self.c64(0);
                            self.b.ne_i64();
                        },
                        (true, 64) => {
                            self.g(TV);
                            self.g(TR);
                            self.c64(63);
                            self.b.shr_s_i64();
                            self.b.ne_i64();
                        },
                        (true, _) => {
                            self.g(TR);
                            self.sext(32);
                            self.g(TC);
                            self.b.ne_i64();
                        },
                    }
                    self.c32((CF | OF) as i32);
                    self.b.mul_i32();
                    self.c32(need as i32);
                    self.b.and_i32();
                    self.flags_end(false);
                    self.written(need);
                }
            },
            Op::Push { src } => {
                self.read(src, 64, inst);
                self.s(TV);
                self.stack(-8, true, start);
                self.gi(HOST);
                self.g(TV);
                self.store(64);
                self.g(ADDR);
                self.s(4);
            },
            Op::Pushf => {
                self.materialize_if(ARITH);
                self.stack(-8, true, start);
                self.gi(HOST);
                self.gi(FL);
                self.c32(!0x30000);
                self.b.and_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.store(64);
                self.g(ADDR);
                self.s(4);
            },
            Op::Pop { dst } => {
                self.stack(0, false, start);
                self.gi(HOST);
                self.load(64);
                self.s(TV);
                self.g(4);
                self.c64(8);
                self.b.add_i64();
                self.s(4);
                self.g(TV);
                self.set_reg(dst, 64);
            },
            Op::Leave => {
                self.g(5);
                self.s(ADDR);
                self.host(8, false, start);
                self.load(64);
                self.s(TV);
                self.g(5);
                self.c64(8);
                self.b.add_i64();
                self.s(4);
                self.g(TV);
                self.s(5);
            },
            Op::Call { target } => {
                self.check_target(target, start);
                self.stack(-8, true, start);
                self.gi(HOST);
                self.linear(next);
                self.store(64);
                self.g(ADDR);
                self.s(4);
                self.retired();
                self.goto(target, index);
            },
            Op::CallIndirect { src } => {
                self.read(src, 64, inst);
                self.s(TV);
                self.check_canonical(TV, start);
                self.stack(-8, true, start);
                self.gi(HOST);
                self.linear(next);
                self.store(64);
                self.g(ADDR);
                self.s(4);
                self.retired();
                self.g(TV);
                self.s(RIP);
                self.dispatch();
            },
            Op::Ret { pop } => {
                self.stack(0, false, start);
                self.gi(HOST);
                self.load(64);
                self.s(TV);
                self.check_canonical(TV, start);
                self.g(4);
                self.c64(8 + pop as u64);
                self.b.add_i64();
                self.s(4);
                self.retired();
                self.g(TV);
                self.s(RIP);
                self.dispatch();
            },
            Op::JmpIndirect { src } => {
                self.read(src, 64, inst);
                self.s(TV);
                self.check_canonical(TV, start);
                self.retired();
                self.g(TV);
                self.s(RIP);
                self.dispatch();
            },
            Op::Jmp { target } => {
                self.check_target(target, start);
                self.retired();
                self.goto(target, index);
            },
            Op::Jcc { cc, target } => {
                self.materialize_if(inst.flags_read);
                self.condition(cc, inst.fused);
                self.b.if_void();
                self.check_target(target, start);
                self.retired();
                self.goto(target, index);
                self.b.block_end();
                self.retired();
            },
            Op::Cmov {
                cc,
                width,
                dst,
                src,
            } => {
                self.materialize_if(inst.flags_read);
                self.read(src, width, inst);
                self.s(TV);
                self.condition(cc, inst.fused);
                self.b.if_void();
                self.g(TV);
                self.set_reg(dst, width);
                if width == 32 {
                    self.b.else_();
                    self.get_reg(dst, 32);
                    self.set_reg(dst, 32);
                }
                self.b.block_end();
            },
            Op::Setcc { cc, dst } => {
                self.materialize_if(inst.flags_read);
                match dst {
                    Opnd::Reg(r) => {
                        self.condition(cc, inst.fused);
                        self.b.extend_unsigned_i32_to_i64();
                        self.set_reg(r, 8);
                    },
                    Opnd::Mem(a) => {
                        self.prepare_store(&a, 8, inst);
                        self.gi(HOST);
                        self.condition(cc, inst.fused);
                        self.b.extend_unsigned_i32_to_i64();
                        self.store(8);
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
            },
            Op::Xchg { width, a, b } => {
                self.read_dst(a, width, true, inst);
                self.s(TA);
                self.get_reg(b, width);
                self.s(TB);
                self.write_dst(a, width, TB);
                self.g(TA);
                self.set_reg(b, width);
            },
            Op::Xadd { width, dst, src } => {
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                self.get_reg(src, width);
                self.s(TB);
                self.g(TA);
                self.g(TB);
                self.b.add_i64();
                self.mask_to(width);
                self.s(TR);
                self.write_dst(dst, width, TR);
                if dst.reg() != Some(src) {
                    self.g(TA);
                    self.set_reg(src, width);
                }
                self.alu_flags(0, width, need);
                self.record(0, width, ARITH, need, inst);
            },
            Op::Cmpxchg { width, dst, src } => {
                self.read_dst(dst, width, true, inst);
                self.s(TB);
                self.get_reg(RAX, width);
                self.s(TA);
                self.g(TA);
                self.g(TB);
                self.b.sub_i64();
                self.mask_to(width);
                self.s(TR);
                self.g(TA);
                self.g(TB);
                self.b.eq_i64();
                self.si(COND);
                match dst {
                    Opnd::Mem(_) if inst.locked => {
                        // (unequal: the value read is written back, no change)
                        self.get_reg(src, width);
                        self.g(TB);
                        self.gi(COND);
                        self.b.select();
                        self.s(TV);
                        self.locked_store(width, TV);
                        self.gi(COND);
                        self.b.eqz_i32();
                        self.b.if_void();
                        self.g(TB);
                        self.set_reg(RAX, width);
                        self.b.block_end();
                    },
                    Opnd::Mem(_) => {
                        // the memory operand is always written
                        self.gi(HOST);
                        self.get_reg(src, width);
                        self.g(TB);
                        self.gi(COND);
                        self.b.select();
                        self.store(width);
                        self.gi(COND);
                        self.b.eqz_i32();
                        self.b.if_void();
                        self.g(TB);
                        self.set_reg(RAX, width);
                        self.b.block_end();
                    },
                    Opnd::Reg(d) => {
                        self.gi(COND);
                        self.b.if_void();
                        self.get_reg(src, width);
                        self.set_reg(d, width);
                        self.b.else_();
                        self.g(TB);
                        self.set_reg(RAX, width);
                        self.b.block_end();
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
                self.alu_flags(7, width, need);
                self.record(7, width, ARITH, need, inst);
            },
            Op::SignAcc { width } => {
                self.get_reg(RAX, width / 2);
                self.sext(width / 2);
                self.set_reg(RAX, width);
            },
            Op::SignDx { width } => {
                self.c64(0);
                self.get_reg(RAX, width);
                self.c64(width as u64 - 1);
                self.b.shr_u_i64();
                self.b.sub_i64();
                self.set_reg(RDX, width);
            },
            Op::Bt {
                action,
                width,
                dst,
                index: bit,
            } => {
                let log = width.trailing_zeros() as u64;
                match dst {
                    Opnd::Reg(r) => {
                        self.get_reg(r, width);
                        self.s(TA);
                    },
                    Opnd::Mem(a) => {
                        self.address(&a, next, true);
                        if let Opnd::Reg(i) = bit {
                            // bit string: the index selects the operand
                            self.get_reg(i, width);
                            self.sext(width);
                            self.c64(log);
                            self.b.shr_s_i64();
                            self.c64(log - 3);
                            self.b.shl_i64();
                            self.b.add_i64();
                        }
                        self.s(ADDR);
                        self.host(width as u32 / 8, action != 0, start);
                        if inst.locked {
                            self.si(HOST);
                            self.locked_load(width);
                        }
                        else {
                            self.ti(HOST);
                            self.load(width);
                        }
                        self.s(TA);
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
                match bit {
                    Opnd::Imm(v) => self.c64(v & (width as u64 - 1)),
                    _ => {
                        self.read(bit, width, inst);
                        self.c64(width as u64 - 1);
                        self.b.and_i64();
                    },
                }
                self.s(TB);
                if action != 0 {
                    self.g(TA);
                    self.c64(1);
                    self.g(TB);
                    self.b.shl_i64();
                    match action {
                        1 => self.b.or_i64(),
                        2 => {
                            self.c64(u64::MAX);
                            self.b.xor_i64();
                            self.b.and_i64();
                        },
                        _ => self.b.xor_i64(),
                    }
                    self.s(TR);
                    self.write_dst(dst, width, TR);
                }
                self.flags_begin(CF);
                self.g(TA);
                self.g(TB);
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.c32(1);
                self.b.and_i32();
                self.flags_end(false);
                self.written(CF);
            },
            Op::BitScan {
                reverse,
                width,
                dst,
                src,
            } => {
                self.read(src, width, inst);
                self.s(TA);
                self.is_zero(TA);
                self.b.if_void();
                self.gi(FL);
                self.c32(ZF as i32);
                self.b.or_i32();
                self.si(FL);
                self.b.else_();
                if reverse {
                    self.c64(63);
                    self.g(TA);
                    self.b.clz_i64();
                    self.b.sub_i64();
                }
                else {
                    self.g(TA);
                    self.b.ctz_i64();
                }
                self.set_reg(dst, width);
                self.gi(FL);
                self.c32(!ZF as i32);
                self.b.and_i32();
                self.si(FL);
                self.b.block_end();
                self.written(ZF);
            },
            Op::Popcnt { width, dst, src } => {
                self.read(src, width, inst);
                self.s(TA);
                self.g(TA);
                self.b.popcnt_i64();
                self.set_reg(dst, width);
                self.flags_begin(ARITH);
                self.is_zero(TA);
                self.c32(6);
                self.b.shl_i32();
                self.flags_end(false);
                self.written(ARITH);
            },
            Op::Bswap { width, reg } => {
                let r = reg as usize;
                if width == 64 {
                    self.g(r);
                    self.c64(8);
                    self.b.shr_u_i64();
                    self.c64(0x00FF_00FF_00FF_00FF);
                    self.b.and_i64();
                    self.g(r);
                    self.c64(0x00FF_00FF_00FF_00FF);
                    self.b.and_i64();
                    self.c64(8);
                    self.b.shl_i64();
                    self.b.or_i64();
                    self.s(TV);
                    self.g(TV);
                    self.c64(16);
                    self.b.shr_u_i64();
                    self.c64(0x0000_FFFF_0000_FFFF);
                    self.b.and_i64();
                    self.g(TV);
                    self.c64(0x0000_FFFF_0000_FFFF);
                    self.b.and_i64();
                    self.c64(16);
                    self.b.shl_i64();
                    self.b.or_i64();
                    self.c64(32);
                    self.b.op(op::OP_I64ROTL);
                    self.s(r);
                }
                else {
                    self.g(r);
                    self.b.wrap_i64_to_i32();
                    self.si(COND);
                    // rotl(x & 0x00FF00FF, 24) | rotl(x & 0xFF00FF00, 8)
                    self.gi(COND);
                    self.c32(0x00FF_00FF);
                    self.b.and_i32();
                    self.c32(24);
                    self.b.rotl_i32();
                    self.gi(COND);
                    self.c32(0xFF00_FF00u32 as i32);
                    self.b.and_i32();
                    self.c32(8);
                    self.b.rotl_i32();
                    self.b.or_i32();
                    self.b.extend_unsigned_i32_to_i64();
                    self.s(r);
                }
            },
            Op::Flag { opcode } => {
                self.materialize_if(inst.flags_read);
                self.gi(FL);
                match opcode {
                    0xF5 => {
                        self.c32(CF as i32);
                        self.b.xor_i32();
                    },
                    0xF8 => {
                        self.c32(!CF as i32);
                        self.b.and_i32();
                    },
                    0xF9 => {
                        self.c32(CF as i32);
                        self.b.or_i32();
                    },
                    0xFC => {
                        self.c32(!0x400);
                        self.b.and_i32();
                    },
                    _ => {
                        self.c32(0x400);
                        self.b.or_i32();
                    },
                }
                self.si(FL);
                self.written(inst.writes);
            },
            Op::Cli | Op::Sti => {
                // #GP unless CPL <= IOPL
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.gi(FL);
                self.c32(12);
                self.b.shr_u_i32();
                self.c32(3);
                self.b.and_i32();
                self.b.gtu_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.gi(FL);
                if matches!(inst.op, Op::Cli) {
                    self.c32(!0x200);
                    self.b.and_i32();
                    self.si(FL);
                }
                else {
                    self.c32(0x200);
                    self.b.or_i32();
                    self.si(FL);
                    // as after the interpreter retired STI: one shadow instruction left
                    self.c32(gp::interrupt_shadow as i32);
                    self.c32(1);
                    self.b.store_u8(0);
                    self.retired();
                    self.leave_to(self.f().exit, next);
                }
            },
            Op::Swapgs => {
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                let (low, high) = (
                    gp::segment_offsets as u32 + 20,
                    gp::x64_segment_base_hi as u32 + 20,
                );
                self.load_pair(low, high);
                self.s(TV);
                self.c32(gp::x64_kernel_gs_base as i32);
                self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
                self.s(TX);
                self.store_pair(low, high, TX);
                self.c32(gp::x64_kernel_gs_base as i32);
                self.g(TV);
                self.b.store_aligned_i64(0);
            },
            Op::Rdtsc => {
                // #GP at CPL > 0 with CR4.TSD
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.c32(0);
                self.b.ne_i32();
                self.b.load_fixed_i32(gp::cr as u32 + 16);
                self.c32(2);
                self.b.shr_u_i32();
                self.c32(1);
                self.b.and_i32();
                self.b.and_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.b
                    .call_signature("x64_page_rdtsc", Signature::new(&[], &[WasmType::I64]));
                self.s(TV);
                self.g(TV);
                self.set_reg(RAX, 32);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.set_reg(RDX, 32);
            },
            Op::Div { signed, width, src } => self.divide(inst, signed, width, src),
            Op::RepCompare { width, scan, equal } => self.rep_compare(inst, width, scan, equal),
            Op::Movs { width, rep } | Op::Stos { width, rep } => {
                self.string(inst, matches!(inst.op, Op::Movs { .. }), width, rep)
            },
            Op::MovSreg {
                segment,
                width,
                dst,
            } => match dst {
                Opnd::Mem(a) => {
                    self.prepare_store(&a, 16, inst);
                    self.gi(HOST);
                    self.load_selector(segment);
                    self.store(16);
                },
                Opnd::Reg(r) => {
                    self.load_selector(segment);
                    self.set_reg(r, width);
                },
                Opnd::Imm(_) => unreachable!(),
            },
            Op::DoubleShift {
                left,
                width,
                dst,
                src,
                count,
            } => {
                let count = shift_count(width, count) as u64;
                let w = width as u64;
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                if count == 0 {
                    self.write_dst(dst, width, TA);
                }
                else {
                    self.get_reg(src, width);
                    self.s(TB);
                    self.g(TA);
                    self.c64(if left { count } else { count });
                    if left {
                        self.b.shl_i64()
                    }
                    else {
                        self.b.shr_u_i64()
                    }
                    self.g(TB);
                    self.c64(w - count);
                    if left {
                        self.b.shr_u_i64()
                    }
                    else {
                        self.b.shl_i64()
                    }
                    self.b.or_i64();
                    self.mask_to(width);
                    self.s(TR);
                    self.write_dst(dst, width, TR);
                    let writes = inst.writes;
                    self.flags_begin(writes);
                    let mut first = true;
                    self.bit_of(
                        TA,
                        if left { (w - count) as u8 } else { (count - 1) as u8 },
                        0,
                    );
                    self.join(&mut first);
                    self.szp(TR, writes, width, &mut first);
                    if count == 1 {
                        self.g(TA);
                        self.g(TR);
                        self.b.xor_i64();
                        self.s(TX);
                        self.bit_of(TX, width - 1, 11);
                        self.join(&mut first);
                    }
                    self.flags_end(first);
                    self.written(writes);
                }
            },
            Op::CompareExchange { wide, address } => self.compare_exchange(inst, wide, &address),
            Op::Vmove {
                bits,
                dst,
                src,
                aligned,
                zero,
            } => {
                self.sse_check(start);
                match (dst, src) {
                    (Xmm::Reg(d), Xmm::Reg(s)) => {
                        self.xmm_load(s, 0, bits.min(64));
                        self.xmm_store(d, 0, bits.min(64), !zero && bits == 32);
                        if bits == 128 {
                            self.xmm_load(s, 8, 64);
                            self.xmm_store(d, 8, 64, false);
                        }
                        else if zero {
                            self.clear_upper(d, bits);
                        }
                    },
                    (Xmm::Reg(d), Xmm::Mem(a)) => {
                        self.vector_address(&a, bits, aligned, false, inst);
                        for half in 0..(bits as u32).div_ceil(64) {
                            self.gi(HOST);
                            self.load_bits(bits.min(64), half * 8);
                            self.s(TA);
                            self.c32(Self::xmm(d) as i32 + half as i32 * 8);
                            self.g(TA);
                            if bits == 32 {
                                self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
                            }
                            else {
                                self.b.store_aligned_i64(0);
                            }
                        }
                        if bits < 128 {
                            self.clear_upper(d, bits);
                        }
                    },
                    (Xmm::Mem(a), Xmm::Reg(s)) => {
                        self.vector_address(&a, bits, aligned, true, inst);
                        for half in 0..(bits as u32).div_ceil(64) {
                            self.gi(HOST);
                            self.xmm_load(s, half * 8, bits.min(64));
                            self.b
                                .guest_store_i64_bits(if bits == 32 { 32 } else { 64 }, half * 8);
                        }
                    },
                    (Xmm::Mem(_), Xmm::Mem(_)) => unreachable!(),
                }
            },
            Op::Vlogic { code, dst, src } => {
                self.sse_check(start);
                if let Xmm::Mem(a) = src {
                    self.vector_address(&a, 128, true, false, inst);
                }
                for half in 0..2u32 {
                    self.xmm_load(dst, half * 8, 64);
                    if code == 1 {
                        self.c64(u64::MAX);
                        self.b.xor_i64();
                    }
                    match src {
                        Xmm::Reg(s) => self.xmm_load(s, half * 8, 64),
                        Xmm::Mem(_) => {
                            self.gi(HOST);
                            self.b.guest_load_i64_bits(64, half * 8);
                        },
                    }
                    match code {
                        0 | 1 => self.b.and_i64(),
                        2 => self.b.or_i64(),
                        _ => self.b.xor_i64(),
                    }
                    self.s(TA);
                    self.c32(Self::xmm(dst) as i32 + half as i32 * 8);
                    self.g(TA);
                    self.b.store_aligned_i64(0);
                }
            },
            Op::Vfp {
                code,
                double,
                packed,
                dst,
                src,
            } => self.vfp(inst, start, code, double, packed, dst, src),
            Op::Vpacked { op, dst, src } => {
                self.sse_check(start);
                self.vector_source(src, inst);
                let source = self.b.set_new_local_v128();
                self.c32(Self::xmm(dst) as i32);
                self.b.simd_memory(0x00, 0);
                let destination = self.b.set_new_local_v128();
                self.c32(Self::xmm(dst) as i32);
                self.packed(op, &destination, &source);
                self.b.simd_memory(0x0B, 0);
                self.b.free_local_v128(source);
                self.b.free_local_v128(destination);
            },
            Op::VshiftImm {
                dst,
                bits,
                kind,
                count,
            } => {
                self.sse_check(start);
                self.c32(Self::xmm(dst) as i32);
                self.c32(Self::xmm(dst) as i32);
                self.b.simd_memory(0x00, 0);
                let count = count as u32;
                if bits == 128 {
                    self.b.simd_zero();
                    let mut lanes = [16; 16];
                    for (k, lane) in lanes.iter_mut().enumerate() {
                        let index = if kind == 3 {
                            k as i32 + count as i32
                        }
                        else {
                            k as i32 - count as i32
                        };
                        if (0..16).contains(&index) {
                            *lane = index as u8;
                        }
                    }
                    self.b.simd_shuffle(lanes);
                }
                else if count >= bits as u32 && kind != 4 {
                    self.b.drop_();
                    self.b.simd_zero();
                }
                else {
                    self.c32(count.min(bits as u32 - 1) as i32);
                    let base = match bits {
                        16 => 0x8B,
                        32 => 0xAB,
                        _ => 0xCB,
                    };
                    self.b.simd(
                        base + match kind {
                            6 => 0,
                            4 => 1,
                            _ => 2,
                        },
                    );
                }
                self.b.simd_memory(0x0B, 0);
            },
            Op::Vcompare { double, dst, src } => self.vcompare(inst, start, double, dst, src),
            Op::Invlpg { address } => {
                // CPL > 0 is #GP (retried)
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.address(&address, next, true);
                self.b.call_signature(
                    "x64_page_invlpg",
                    Signature::new(&[WasmType::I64], &[WasmType::I32]),
                );
                self.b.if_void();
                self.retired();
                self.leave_to(self.f().exit, next);
                self.b.block_end();
            },
            Op::Mxcsr { load, address } => {
                self.sse_check(start);
                if load {
                    self.address(&address, next, true);
                    self.s(ADDR);
                    self.host(4, false, start);
                    self.load(32);
                    self.b.wrap_i64_to_i32();
                    self.si(ST);
                    // reserved bits: #GP in the interpreter
                    self.gi(ST);
                    self.c32(!crate::cpu::cpu::MXCSR_MASK);
                    self.b.and_i32();
                    self.b.if_void();
                    self.leave_to(self.f().retry, start);
                    self.b.block_end();
                    self.c32(gp::mxcsr as i32);
                    self.gi(ST);
                    self.b.store_aligned_i32(0);
                }
                else {
                    self.address(&address, next, true);
                    self.s(ADDR);
                    self.host(4, true, start);
                    self.b.load_fixed_i32(gp::mxcsr as u32);
                    self.b.extend_unsigned_i32_to_i64();
                    self.store(32);
                }
            },
            Op::MovdIn { width, dst, src } => {
                self.sse_check(start);
                self.read(src, width, inst);
                self.s(TA);
                self.c32(Self::xmm(dst) as i32);
                self.g(TA);
                self.b.store_aligned_i64(0);
                self.clear_upper(dst, 64);
            },
            Op::MovdOut { width, dst, src } => {
                self.sse_check(start);
                match dst {
                    Opnd::Reg(r) => {
                        self.xmm_load(src, 0, width);
                        self.set_reg(r, width);
                    },
                    Opnd::Mem(a) => {
                        self.prepare_store(&a, width, inst);
                        self.gi(HOST);
                        self.xmm_load(src, 0, width);
                        self.store(width);
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
            },
            Op::ReadCr { control, reg } => {
                // CPL > 0 is #GP (retried)
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.load_pair(
                    gp::cr as u32 + 4 * control as u32,
                    gp::x64_cr_hi as u32 + 4 * control as u32,
                );
                self.set_reg(reg, 64);
            },
            Op::Cr8 { write, reg } => {
                // CPL > 0 is #GP (retried)
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                if write {
                    self.get_reg(reg, 64);
                    self.b.call_signature(
                        "x64_page_set_cr8",
                        Signature::new(&[WasmType::I64], &[WasmType::I32]),
                    );
                    self.ti(ST);
                    self.c32(1);
                    self.b.eq_i32();
                    self.b.if_void();
                    self.leave_to(self.f().retry, start);
                    self.b.block_end();
                    // an interrupt the lower priority unmasks is taken after this instruction
                    self.gi(ST);
                    self.c32(2);
                    self.b.eq_i32();
                    self.b.if_void();
                    self.retired();
                    self.leave_to(self.f().exit, next);
                    self.b.block_end();
                }
                else {
                    self.b
                        .call_signature("x64_page_cr8", Signature::new(&[], &[WasmType::I64]));
                    self.set_reg(reg, 64);
                }
            },
            Op::Rdtscp => {
                // #GP at CPL > 0 with CR4.TSD, as RDTSC
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.c32(0);
                self.b.ne_i32();
                self.b.load_fixed_i32(gp::cr as u32 + 16);
                self.c32(2);
                self.b.shr_u_i32();
                self.c32(1);
                self.b.and_i32();
                self.b.and_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.b
                    .call_signature("x64_page_rdtsc", Signature::new(&[], &[WasmType::I64]));
                self.s(TV);
                self.g(TV);
                self.set_reg(RAX, 32);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.set_reg(RDX, 32);
                self.b.load_fixed_i32(gp::x64_tsc_aux as u32);
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(
                    Reg {
                        index: 1,
                        high: false,
                    },
                    32,
                );
            },
            Op::Lahf => {
                self.materialize_if(inst.flags_read);
                self.gi(FL);
                self.c32(0xD5);
                self.b.and_i32();
                self.c32(2);
                self.b.or_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(AH, 8);
            },
            Op::Sahf => {
                self.gi(FL);
                self.c32(!0xD5);
                self.b.and_i32();
                self.get_reg(AH, 8);
                self.b.wrap_i64_to_i32();
                self.c32(0xD5);
                self.b.and_i32();
                self.b.or_i32();
                self.si(FL);
                self.written(inst.writes);
            },
        }
        // Control transfers counted themselves before leaving.
        if !matches!(
            inst.op,
            Op::Call { .. }
                | Op::CallIndirect { .. }
                | Op::Ret { .. }
                | Op::JmpIndirect { .. }
                | Op::Jmp { .. }
                | Op::Jcc { .. }
                | Op::Sti
        ) {
            self.retired();
        }
    }

    // SSE ---------------------------------------------------------------

    /// Address of XMM register `n` (the legacy bank for 0..7)
    fn xmm(n: u8) -> u32 {
        if n < 8 {
            gp::reg_xmm as u32 + n as u32 * 16
        }
        else {
            gp::x64_xmm_ext as u32 + (n as u32 - 8) * 16
        }
    }
    /// Retry unless SSE may execute: CR0.EM and CR0.TS clear, CR4.OSFXSR set
    /// (the interpreter raises #UD or #NM).
    fn sse_check(&mut self, start: u64) {
        self.b.load_fixed_i32(gp::cr as u32);
        self.c32(0xC);
        self.b.and_i32();
        self.b.load_fixed_i32(gp::cr as u32 + 16);
        self.c32(0x200);
        self.b.and_i32();
        self.b.eqz_i32();
        self.b.or_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// SSE ADD/MUL/SUB/DIV natively when the result is exactly what the
    /// interpreter (SoftFloat, crate::x64::vector) produces without changing
    /// MXCSR: round to nearest, every exception masked, and PE already set
    /// (FTZ and DAZ may be set: they affect none of the operands and results
    /// admitted here) (so an inexact result changes nothing); operands finite
    /// and normal or zero; a divisor that is not zero; and a result that is
    /// normal above the smallest binade (no underflow, whichever way
    /// tininess is detected) or an exact zero. Otherwise the instruction is
    /// retried in the interpreter; no lane is written before all passed.
    fn vfp(
        &mut self,
        inst: &Inst,
        start: u64,
        code: u8,
        double: bool,
        packed: bool,
        dst: u8,
        src: Xmm,
    ) {
        self.sse_check(start);
        // (DAZ and FTZ change nothing for the operands and results below;
        // the exception flags other than PE are never set by them)
        self.b.load_fixed_i32(gp::mxcsr as u32);
        self.c32(0x7F80);
        self.b.and_i32();
        self.c32(0x1F80);
        self.b.ne_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
        self.c32(0);
        self.si(INX);
        let bits = if packed {
            128
        }
        else if double {
            64
        }
        else {
            32
        };
        if let Xmm::Mem(a) = src {
            self.vector_address(&a, bits, packed, false, inst);
        }
        self.c32(0);
        self.si(COND);
        for half in 0..if packed { 2 } else { 1 } {
            self.xmm_load(dst, half * 8, 64);
            self.s(TV);
            match src {
                Xmm::Reg(s) => self.xmm_load(s, half * 8, 64),
                Xmm::Mem(_) => {
                    self.gi(HOST);
                    self.load_bits(bits.min(64), half * 8);
                },
            }
            self.s(TC);
            let out = if half == 0 { FP0 } else { FP1 };
            if double {
                self.g(TV);
                self.s(TA);
                self.g(TC);
                self.s(TB);
                self.fp_lane(code, true);
                self.g(TR);
                self.s(out);
                continue;
            }
            for lane in 0..if packed { 2 } else { 1 } {
                for (from, to) in [(TV, TA), (TC, TB)] {
                    self.g(from);
                    if lane == 1 {
                        self.c64(32);
                        self.b.shr_u_i64();
                    }
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                    self.s(to);
                }
                self.fp_lane(code, false);
                if lane == 0 {
                    self.g(TR);
                }
                else {
                    self.g(out);
                    self.g(TR);
                    self.c64(32);
                    self.b.shl_i64();
                    self.b.or_i64();
                }
                self.s(out);
            }
        }
        self.gi(COND);
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
        // an inexact result sets PE (sticky)
        self.gi(INX);
        self.b.if_void();
        self.c32(gp::mxcsr as i32);
        self.b.load_fixed_i32(gp::mxcsr as u32);
        self.c32(0x20);
        self.b.or_i32();
        self.b.store_aligned_i32(0);
        self.b.block_end();
        self.g(FP0);
        self.xmm_store(dst, 0, if packed || double { 64 } else { 32 }, true);
        if packed {
            self.g(FP1);
            self.xmm_store(dst, 8, 64, false);
        }
    }
    /// One lane of vfp: operand bit patterns in TA and TB (zero-extended in
    /// single precision), the result's into TR; refusals or'ed into COND
    fn fp_lane(&mut self, code: u8, double: bool) {
        let (shift, max, magnitude) =
            if double { (52, 0x7FF, 0x7FFF_FFFF_FFFF_FFFF) } else { (23, 0xFF, 0x7FFF_FFFF) };
        let zero = |e: &mut Self, x: usize| {
            e.g(x);
            e.c64(magnitude);
            e.b.and_i64();
            e.b.op(op::OP_I64EQZ);
        };
        let exponent = |e: &mut Self, x: usize| {
            e.g(x);
            e.c64(shift);
            e.b.shr_u_i64();
            e.c64(max);
            e.b.and_i64();
            e.s(TX);
        };
        // operands: no NaN or infinity (exponent all ones), no denormal
        for x in [TA, TB] {
            exponent(self, x);
            self.g(TX);
            self.c64(max);
            self.b.eq_i64();
            self.g(TX);
            self.b.op(op::OP_I64EQZ);
            zero(self, x);
            self.b.eqz_i32();
            self.b.and_i32();
            self.b.or_i32();
            self.fp_refuse();
        }
        if code == 0x5E {
            // a zero divisor: #Z, or #I for 0/0
            zero(self, TB);
            self.fp_refuse();
        }
        for x in [TA, TB] {
            self.g(x);
            if double {
                self.b.reinterpret_i64_as_f64();
            }
            else {
                self.b.wrap_i64_to_i32();
                self.b.reinterpret_i32_as_f32();
            }
        }
        let operation = match code {
            0x58 => 0,
            0x5C => 1,
            0x59 => 2,
            _ => 3,
        };
        if double {
            self.b.arithmetic_f64(operation);
            self.b.reinterpret_f64_as_i64();
        }
        else {
            self.b.arithmetic_f32(operation);
            self.b.reinterpret_f32_as_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
        self.s(TR);
        // the result: its exponent 0 or 1 (possible underflow) or all ones
        // (overflow) is refused, unless it is an exact zero
        exponent(self, TR);
        self.g(TX);
        self.c64(!1);
        self.b.and_i64();
        self.b.op(op::OP_I64EQZ);
        self.g(TX);
        self.c64(max);
        self.b.eq_i64();
        self.b.or_i32();
        zero(self, TR);
        match code {
            // a zero sum or difference of finite normal operands is exact
            0x58 | 0x5C => {},
            // a zero product is exact only with a zero factor
            0x59 => {
                zero(self, TA);
                zero(self, TB);
                self.b.or_i32();
                self.b.and_i32();
            },
            // a zero quotient only with a zero dividend
            _ => {
                zero(self, TA);
                self.b.and_i32();
            },
        }
        self.b.eqz_i32();
        self.b.and_i32();
        self.fp_refuse();
        self.fp_inexact(code, double);
        self.gi(INX);
        self.b.or_i32();
        self.si(INX);
    }
    /// Push i32 1 when the lane's result (TR) is not the exact result of the
    /// operation on TA and TB (sets MXCSR.PE), for the operands and results
    /// fp_lane admits. Single precision: the operation is exact in double
    /// (TwoSum for ADD/SUB). Double: TwoSum, and Dekker's TwoProduct for MUL
    /// (and DIV: the product of quotient and divisor is the dividend), which
    /// refuse extreme exponents where its terms would overflow or underflow.
    fn fp_inexact(&mut self, code: u8, double: bool) {
        let value = |e: &mut Self, i: usize| {
            e.g(i);
            if double {
                e.b.reinterpret_i64_as_f64();
            }
            else {
                e.b.wrap_i64_to_i32();
                e.b.reinterpret_i32_as_f32();
                e.b.promote_f32_to_f64();
            }
        };
        value(self, TA);
        let x = self.b.set_new_local_f64();
        value(self, TB);
        if code == 0x5C {
            self.b.unary_f64(true);
        }
        let y = self.b.set_new_local_f64();
        value(self, TR);
        let r = self.b.set_new_local_f64();
        let f = |e: &mut Self, l: &crate::wasmgen::wasm_builder::WasmLocalF64| e.b.get_local_f64(l);
        match (code, double) {
            (0x58 | 0x5C, _) => {
                // TwoSum: s = x + y, err = (x - (s - bb)) + (y - bb), bb = s - x
                f(self, &x);
                f(self, &y);
                self.b.arithmetic_f64(0);
                let s = self.b.set_new_local_f64();
                f(self, &s);
                f(self, &x);
                self.b.arithmetic_f64(1);
                let bb = self.b.set_new_local_f64();
                f(self, &x);
                f(self, &s);
                f(self, &bb);
                self.b.arithmetic_f64(1);
                self.b.arithmetic_f64(1);
                f(self, &y);
                f(self, &bb);
                self.b.arithmetic_f64(1);
                self.b.arithmetic_f64(0);
                self.b.const_f64(0.0);
                self.b.ne_f64();
                f(self, &s);
                f(self, &r);
                self.b.ne_f64();
                self.b.or_i32();
                self.b.free_local_f64(s);
                self.b.free_local_f64(bb);
            },
            (0x59, false) => {
                f(self, &x);
                f(self, &y);
                self.b.arithmetic_f64(2);
                f(self, &r);
                self.b.ne_f64();
            },
            (_, false) => {
                f(self, &r);
                f(self, &y);
                self.b.arithmetic_f64(2);
                f(self, &x);
                self.b.ne_f64();
            },
            (_, true) => {
                // TwoProduct of (a, b) = (x, y) for MUL, (r, y) for DIV;
                // exact when the error term is 0 (and, for DIV, the product
                // is the dividend). Refused: an operand or the result (not
                // zero) outside 2^-450..2^450, where splitting could overflow
                // or the error terms lose bits to underflow.
                for i in [TA, TB, TR] {
                    self.g(i);
                    self.c64(52);
                    self.b.shr_u_i64();
                    self.c64(0x7FF);
                    self.b.and_i64();
                    self.c64(0x3FF - 450);
                    self.b.sub_i64();
                    self.c64(900);
                    self.b.gtu_i64();
                    self.g(i);
                    self.c64(0x7FFF_FFFF_FFFF_FFFF);
                    self.b.and_i64();
                    self.c64(0);
                    self.b.ne_i64();
                    self.b.and_i32();
                    self.fp_refuse();
                }
                let (a, p) = if code == 0x59 { (&x, &r) } else { (&r, &x) };
                let split = |e: &mut Self, v: &crate::wasmgen::wasm_builder::WasmLocalF64| {
                    // hi = c - (c - v), c = v * (2^27 + 1); lo = v - hi
                    e.b.const_f64(134217729.0);
                    f(e, v);
                    e.b.arithmetic_f64(2);
                    let c = e.b.set_new_local_f64();
                    f(e, &c);
                    f(e, &c);
                    f(e, v);
                    e.b.arithmetic_f64(1);
                    e.b.arithmetic_f64(1);
                    let hi = e.b.set_new_local_f64();
                    f(e, v);
                    f(e, &hi);
                    e.b.arithmetic_f64(1);
                    let lo = e.b.set_new_local_f64();
                    e.b.free_local_f64(c);
                    (hi, lo)
                };
                let (ah, al) = split(self, a);
                let (bh, bl) = split(self, &y);
                // product = a * b rounded (MUL: the result; DIV: computed)
                if code == 0x59 {
                    f(self, &r);
                }
                else {
                    f(self, a);
                    f(self, &y);
                    self.b.arithmetic_f64(2);
                }
                let product = self.b.set_new_local_f64();
                // err = ((ah*bh - product) + ah*bl + al*bh) + al*bl
                f(self, &ah);
                f(self, &bh);
                self.b.arithmetic_f64(2);
                f(self, &product);
                self.b.arithmetic_f64(1);
                f(self, &ah);
                f(self, &bl);
                self.b.arithmetic_f64(2);
                self.b.arithmetic_f64(0);
                f(self, &al);
                f(self, &bh);
                self.b.arithmetic_f64(2);
                self.b.arithmetic_f64(0);
                f(self, &al);
                f(self, &bl);
                self.b.arithmetic_f64(2);
                self.b.arithmetic_f64(0);
                self.b.const_f64(0.0);
                self.b.ne_f64();
                if code != 0x59 {
                    f(self, &product);
                    f(self, p);
                    self.b.ne_f64();
                    self.b.or_i32();
                }
                for l in [ah, al, bh, bl, product] {
                    self.b.free_local_f64(l);
                }
            },
        }
        self.b.free_local_f64(x);
        self.b.free_local_f64(y);
        self.b.free_local_f64(r);
    }
    fn fp_refuse(&mut self) {
        self.gi(COND);
        self.b.or_i32();
        self.si(COND);
    }

    /// Push the low `bits` (32 or 64) at byte `offset` of XMM register `n`.
    fn xmm_load(&mut self, n: u8, offset: u32, bits: u8) {
        self.c32((Self::xmm(n) + offset) as i32);
        if bits == 32 {
            self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        }
        else {
            self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        }
    }
    /// Store the value on the stack into XMM register `n` at byte `offset`;
    /// a 32-bit store keeps the rest of the qword when `merge`.
    fn xmm_store(&mut self, n: u8, offset: u32, bits: u8, merge: bool) {
        self.s(TA);
        self.c32((Self::xmm(n) + offset) as i32);
        self.g(TA);
        if bits == 32 && merge {
            self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
        }
        else {
            if bits == 32 {
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
            }
            self.b.store_aligned_i64(0);
        }
    }
    /// Zero XMM register `n` above its low `bits` (32 or 64).
    fn clear_upper(&mut self, n: u8, bits: u8) {
        if bits == 32 {
            self.c32(Self::xmm(n) as i32 + 4);
            self.c32(0);
            self.b.store_aligned_i32(0);
        }
        self.c32(Self::xmm(n) as i32 + 8);
        self.c64(0);
        self.b.store_aligned_i64(0);
    }
    /// Push the 128-bit source of a packed form: an XMM register, or aligned
    /// memory (misaligned: #GP, retried).
    fn vector_source(&mut self, src: Xmm, inst: &Inst) {
        match src {
            Xmm::Reg(s) => {
                self.c32(Self::xmm(s) as i32);
                self.b.simd_memory(0x00, 0);
            },
            Xmm::Mem(a) => {
                self.vector_address(&a, 128, true, false, inst);
                self.gi(HOST);
                let scratch = self.b.set_new_local();
                self.b.get_local(&scratch);
                self.b.guest_load_v128(&scratch);
                self.b.free_local(scratch);
            },
        }
    }
    /// Push op(dst, src) (ir::tier0::simd::Page::packed on XMM registers).
    fn packed(&mut self, op: Packed, dst: &WasmLocalV128, src: &WasmLocalV128) {
        let w = &mut self.b;
        match op {
            Packed::ShuffleZero(lanes) => {
                w.get_local_v128(dst);
                w.simd_zero();
                w.simd_shuffle(lanes);
            },
            Packed::Swizzle => {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.const_i32(0x8F);
                w.simd(0x0F); // i8x16.splat
                w.simd(0x4E); // v128.and
                w.simd(0x0E); // i8x16.swizzle
            },
            Packed::MulHigh(signed) => {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(if signed { 0xBC } else { 0xBE });
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(if signed { 0xBD } else { 0xBF });
                w.simd_shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
            },
            Packed::MulDwords => {
                for v in [dst, src] {
                    w.get_local_v128(v);
                    w.simd_zero();
                    w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
                }
                w.simd(0xDE);
            },
            Packed::Sad => {
                // |dst - src| per byte, summed per quadword.
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(0x79);
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(0x77);
                w.simd(0x71);
                w.simd(0x7D);
                w.simd(0x7F);
                let sums = w.set_new_local_v128();
                w.get_local_v128(&sums);
                w.get_local_v128(&sums);
                w.get_local_v128(&sums);
                w.simd_shuffle([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]);
                w.simd(0xAE);
                w.simd_zero();
                w.simd_shuffle([0, 1, 2, 3, 16, 17, 18, 19, 8, 9, 10, 11, 16, 17, 18, 19]);
                w.free_local_v128(sums);
            },
            Packed::Shift(opcode, bits, arithmetic) => {
                w.get_local_v128(src);
                w.simd_lane(0x1D, 0);
                let count = w.set_new_local_i64();
                w.get_local_i64(&count);
                w.const_i64((bits - 1) as i64);
                w.gtu_i64();
                w.if_v128();
                if arithmetic {
                    w.get_local_v128(dst);
                    w.const_i32((bits - 1) as i32);
                    w.simd(opcode);
                }
                else {
                    w.simd_zero();
                }
                w.else_();
                w.get_local_v128(dst);
                w.get_local_i64(&count);
                w.wrap_i64_to_i32();
                w.simd(opcode);
                w.block_end();
                w.free_local_i64(count);
            },
            _ => {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                match op {
                    Packed::Shuffle(lanes) => w.simd_shuffle(lanes),
                    Packed::Binary(opcode) => w.simd(opcode),
                    Packed::Pack(opcode) => w.simd(opcode),
                    Packed::Unpack(width, high) => {
                        let mut lanes = [0; 16];
                        for k in 0..16u8 {
                            let element = k / (width * 2);
                            let side = k / width % 2;
                            lanes[k as usize] = (if high { 8 } else { 0 })
                                + element * width
                                + k % width
                                + side * 16;
                        }
                        w.simd_shuffle(lanes);
                    },
                    _ => unreachable!(),
                }
            },
        }
    }
    /// COMISS/UCOMISS/COMISD/UCOMISD. With no NaN or denormal operand the
    /// interpreter changes no MXCSR bit and sets ZF (equal) or CF (less),
    /// clearing the other arithmetic flags; anything else is retried.
    fn vcompare(&mut self, inst: &Inst, start: u64, double: bool, dst: u8, src: Xmm) {
        self.sse_check(start);
        let bits = if double { 64 } else { 32 };
        match src {
            Xmm::Reg(s) => self.xmm_load(s, 0, bits),
            Xmm::Mem(a) => {
                self.vector_address(&a, bits, false, false, inst);
                self.gi(HOST);
                self.load_bits(bits, 0);
            },
        }
        self.s(TB);
        self.xmm_load(dst, 0, bits);
        self.s(TA);
        // exponent all zeros or all ones with a nonzero fraction
        let (fraction, exponent_shift, exponent_max) =
            if double { ((1u64 << 52) - 1, 52, 0x7FF) } else { ((1u64 << 23) - 1, 23, 0xFF) };
        for v in [TA, TB] {
            self.g(v);
            self.c64(fraction);
            self.b.and_i64();
            self.c64(0);
            self.b.ne_i64();
            self.g(v);
            self.c64(exponent_shift);
            self.b.shr_u_i64();
            self.c64(exponent_max);
            self.b.and_i64();
            self.s(TX);
            self.g(TX);
            self.b.op(op::OP_I64EQZ);
            self.g(TX);
            self.c64(exponent_max);
            self.b.eq_i64();
            self.b.or_i32();
            self.b.and_i32();
            self.b.if_void();
            self.leave_to(self.f().retry, start);
            self.b.block_end();
        }
        // FL = FL & ~arithmetic | ZF (a == b) | CF (a < b)
        self.gi(FL);
        self.c32(!ARITH as i32);
        self.b.and_i32();
        for (compare, flag) in [(op::OP_F64EQ, ZF), (op::OP_F64LT, CF)] {
            for v in [TA, TB] {
                self.g(v);
                if double {
                    self.b.op(op::OP_F64REINTERPRETI64);
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.b.op(op::OP_F32REINTERPRETI32);
                    self.b.op(op::OP_F64PROMOTEF32);
                }
            }
            self.b.op(compare);
            if flag != 1 {
                self.c32(flag.trailing_zeros() as i32);
                self.b.shl_i32();
            }
            self.b.or_i32();
        }
        self.si(FL);
        self.written(ARITH);
    }
    fn load_bits(&mut self, bits: u8, offset: u32) {
        self.b
            .guest_load_i64_bits(if bits == 32 { 32 } else { 64 }, offset);
    }
    /// HOST = host address of the `bits` memory operand, retried when an
    /// aligned form is misaligned (#GP) or the access cache refuses it.
    fn vector_address(
        &mut self,
        a: &AddressExpr,
        bits: u8,
        aligned: bool,
        write: bool,
        inst: &Inst,
    ) {
        self.address(a, inst.d.next.0, true);
        self.s(ADDR);
        if aligned {
            self.g(ADDR);
            self.b.wrap_i64_to_i32();
            self.c32(15);
            self.b.and_i32();
            self.b.if_void();
            self.leave_to(self.f().retry, inst.d.start.0);
            self.b.block_end();
        }
        self.host(bits as u32 / 8, write, inst.d.start.0);
        self.si(HOST);
    }

    fn shift_immediate(
        &mut self,
        inst: &Inst,
        code: u8,
        width: u8,
        dst: Opnd,
        count: u8,
        need: u32,
    ) {
        let raw = shift_count(width, count);
        let w = width as u64;
        self.read_dst(dst, width, true, inst);
        self.s(TA);
        if raw == 0 {
            // No flags; the destination is still written (32-bit zero extension).
            self.write_dst(dst, width, TA);
            return;
        }
        let raw64 = raw as u64;
        let rotate = raw64 % w;
        match code {
            4 | 6 => {
                self.g(TA);
                self.c64(raw64);
                self.b.shl_i64();
                self.mask_to(width);
            },
            5 => {
                if raw64 >= w {
                    self.c64(0);
                }
                else {
                    self.g(TA);
                    self.c64(raw64);
                    self.b.shr_u_i64();
                }
            },
            7 => {
                self.g(TA);
                self.sext(width);
                self.c64(raw64);
                self.b.shr_s_i64();
                self.mask_to(width);
            },
            _ => {
                if rotate == 0 {
                    self.g(TA);
                }
                else if width == 64 {
                    self.g(TA);
                    self.c64(rotate);
                    self.b
                        .op(if code == 0 { op::OP_I64ROTL } else { op::OP_I64ROTR });
                }
                else {
                    let (left, right) =
                        if code == 0 { (rotate, w - rotate) } else { (w - rotate, rotate) };
                    self.g(TA);
                    self.c64(left);
                    self.b.shl_i64();
                    self.g(TA);
                    self.c64(right);
                    self.b.shr_u_i64();
                    self.b.or_i64();
                    self.mask_to(width);
                }
            },
        }
        self.s(TR);
        self.write_dst(dst, width, TR);
        if need == 0 {
            return;
        }
        self.flags_begin(need);
        let mut first = true;
        if need & CF != 0 {
            match code {
                4 | 6 if raw64 <= w => self.bit_of(TA, (w - raw64) as u8, 0),
                5 if raw64 <= w => self.bit_of(TA, (raw64 - 1) as u8, 0),
                4 | 5 | 6 => self.c32(0),
                7 => self.bit_of(TA, if raw64 >= w { width - 1 } else { raw - 1 }, 0),
                0 => self.bit_of(if rotate == 0 { TA } else { TR }, 0, 0),
                _ => self.bit_of(if rotate == 0 { TA } else { TR }, width - 1, 0),
            }
            self.join(&mut first);
        }
        if code >= 4 {
            self.szp(TR, need, width, &mut first);
        }
        if raw == 1 && need & OF != 0 {
            match code {
                4 | 6 => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TA, width - 1, 0);
                    self.b.xor_i32();
                },
                5 => self.bit_of(TA, width - 1, 0),
                7 => self.c32(0),
                0 => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TR, 0, 0);
                    self.b.xor_i32();
                },
                _ => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TR, width - 2, 0);
                    self.b.xor_i32();
                },
            }
            self.c32(11);
            self.b.shl_i32();
            self.join(&mut first);
        }
        self.flags_end(first);
    }

    /// SHL/SHR/SAR r/m32/64, CL (count below the width once masked).
    fn shift_cl(&mut self, inst: &Inst, code: u8, width: u8, dst: Opnd, need: u32) {
        self.read_dst(dst, width, true, inst);
        self.s(TA);
        self.g(1);
        self.c64(width as u64 - 1);
        self.b.and_i64();
        self.s(TC);
        match code {
            // ROL ROR: the masked count is below the width
            0 | 1 if width == 64 => {
                self.g(TA);
                self.g(TC);
                self.b
                    .op(if code == 0 { op::OP_I64ROTL } else { op::OP_I64ROTR });
            },
            0 | 1 => {
                self.g(TA);
                self.b.wrap_i64_to_i32();
                self.g(TC);
                self.b.wrap_i64_to_i32();
                if code == 0 {
                    self.b.rotl_i32()
                }
                else {
                    self.b.rotr_i32()
                }
                self.b.extend_unsigned_i32_to_i64();
            },
            4 | 6 => {
                self.g(TA);
                self.g(TC);
                self.b.shl_i64();
                self.mask_to(width);
            },
            5 => {
                self.g(TA);
                self.g(TC);
                self.b.shr_u_i64();
            },
            _ => {
                self.g(TA);
                self.sext(width);
                self.g(TC);
                self.b.shr_s_i64();
                self.mask_to(width);
            },
        }
        self.s(TR);
        self.write_dst(dst, width, TR);
        if need == 0 {
            return;
        }
        if code <= 1 {
            // A nonzero count sets CF from the result, OF only for a count of 1.
            self.g(TC);
            self.b.op(op::OP_I64EQZ);
            self.b.eqz_i32();
            self.b.if_void();
            if need & CF != 0 {
                self.flags_begin(CF);
                self.bit_of(TR, if code == 0 { 0 } else { width - 1 }, 0);
                self.flags_end(false);
            }
            if need & OF != 0 {
                self.g(TC);
                self.c64(1);
                self.b.eq_i64();
                self.b.if_void();
                self.flags_begin(OF);
                self.bit_of(TR, width - 1, 0);
                self.bit_of(TR, if code == 0 { 0 } else { width - 2 }, 0);
                self.b.xor_i32();
                self.c32(11);
                self.b.shl_i32();
                self.flags_end(false);
                self.b.block_end();
            }
            self.b.block_end();
            return;
        }
        // A zero count leaves all flags unchanged.
        self.g(TC);
        self.b.op(op::OP_I64EQZ);
        self.b.eqz_i32();
        self.b.if_void();
        let base = need & (CF | PF | ZF | SF);
        if base != 0 {
            self.flags_begin(base);
            let mut first = true;
            if base & CF != 0 {
                self.g(TA);
                if matches!(code, 4 | 6) {
                    self.c64(width as u64);
                    self.g(TC);
                    self.b.sub_i64();
                }
                else {
                    self.g(TC);
                    self.c64(1);
                    self.b.sub_i64();
                }
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.c32(1);
                self.b.and_i32();
                self.join(&mut first);
            }
            self.szp(TR, base, width, &mut first);
            self.flags_end(first);
        }
        if need & OF != 0 {
            self.g(TC);
            self.c64(1);
            self.b.eq_i64();
            self.b.if_void();
            self.flags_begin(OF);
            match code {
                4 | 6 => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TA, width - 1, 0);
                    self.b.xor_i32();
                },
                5 => self.bit_of(TA, width - 1, 0),
                _ => self.c32(0),
            }
            self.c32(11);
            self.b.shl_i32();
            self.flags_end(false);
            self.b.block_end();
        }
        self.b.block_end();
    }
}

impl Emitter {
    fn load_selector(&mut self, segment: u8) {
        self.c32(gp::sreg as i32 + segment as i32 * 2);
        self.b.memory_op(op::OP_I64LOAD16U, op::MEM_ALIGN16, 0);
    }
    /// Step the instruction (in place) when the i32 on the stack is nonzero.
    fn step_if(&mut self, start: u64) {
        self.b.if_void();
        self.leave_to(self.f().step, start);
        self.b.block_end();
    }
    /// Retry when the i32 on the stack is nonzero.
    fn retry_if(&mut self, start: u64) {
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    fn divide(&mut self, inst: &Inst, signed: bool, width: u8, src: Opnd) {
        let start = inst.d.start.0;
        self.read(src, width, inst);
        self.s(TB);
        self.is_zero(TB);
        self.retry_if(start);
        if width == 64 {
            // RDX must be the (sign) extension of RAX: a wide dividend retries
            self.g(2);
            if signed {
                self.g(0);
                self.c64(63);
                self.b.shr_s_i64();
                self.b.ne_i64();
                self.retry_if(start);
                // MIN / -1 overflows
                self.g(TB);
                self.c64(u64::MAX);
                self.b.eq_i64();
                self.g(0);
                self.c64(1 << 63);
                self.b.eq_i64();
                self.b.and_i32();
                self.retry_if(start);
            }
            else {
                self.c64(0);
                self.b.ne_i64();
                self.retry_if(start);
            }
            self.g(0);
            self.s(TA);
        }
        else {
            // EDX:EAX
            self.g(2);
            self.c64(32);
            self.b.shl_i64();
            self.g(0);
            self.mask_to(32);
            self.b.or_i64();
            self.s(TA);
            if signed {
                self.g(TB);
                self.sext(32);
                self.s(TB);
                self.g(TB);
                self.c64(u64::MAX);
                self.b.eq_i64();
                self.g(TA);
                self.c64(1 << 63);
                self.b.eq_i64();
                self.b.and_i32();
                self.retry_if(start);
            }
        }
        self.g(TA);
        self.g(TB);
        self.b
            .op(if signed { op::OP_I64DIVS } else { op::OP_I64DIVU });
        self.s(TR);
        if width == 32 {
            // the quotient must fit
            self.g(TR);
            if signed {
                self.sext(32);
            }
            else {
                self.mask_to(32);
            }
            self.g(TR);
            self.b.ne_i64();
            self.retry_if(start);
        }
        self.g(TA);
        self.g(TB);
        self.b
            .op(if signed { op::OP_I64REMS } else { op::OP_I64REMU });
        self.s(TV);
        self.g(TR);
        self.set_reg(RAX, width);
        self.g(TV);
        self.set_reg(RDX, width);
    }
    /// Direction: +size, or -size with EFLAGS.DF.
    fn step_size(&mut self, size: u64) {
        self.c64(size.wrapping_neg());
        self.c64(size);
        self.gi(FL);
        self.c32(0x400);
        self.b.and_i32();
        self.b.select();
    }
    fn string(&mut self, inst: &Inst, movs: bool, width: u8, rep: bool) {
        let start = inst.d.start.0;
        let size = width as u64 / 8;
        if !rep {
            if movs {
                self.g(6);
                self.s(ADDR);
                self.host(size as u32, false, start);
                self.load(width);
                self.s(TV);
            }
            self.g(7);
            self.s(ADDR);
            self.host(size as u32, true, start);
            if movs {
                self.g(TV);
            }
            else {
                self.get_reg(RAX, width);
            }
            self.store(width);
            self.step_size(size);
            self.s(TX);
            if movs {
                self.g(6);
                self.g(TX);
                self.b.add_i64();
                self.s(6);
            }
            self.g(7);
            self.g(TX);
            self.b.add_i64();
            self.s(7);
            return;
        }
        // REP: all at once when it stays inside one page per operand, going
        // forward (and, for wide STOS, stores zero); else an interpreter step
        // (an element, or a chunk of RAM) that dispatches back to this block.
        // RCX = 0: nothing happens
        self.g(1);
        self.b.op(op::OP_I64EQZ);
        self.b.eqz_i32();
        self.b.if_void();
        self.gi(FL);
        self.c32(0x400);
        self.b.and_i32();
        self.g(1);
        self.c64(4096 / size);
        self.b.op(op::OP_I64GTU);
        self.b.or_i32();
        if !movs && width != 8 {
            self.get_reg(RAX, width);
            self.c64(0);
            self.b.ne_i64();
            self.b.or_i32();
        }
        self.step_if(start);
        // length in bytes, within 4096
        self.g(1);
        self.c64(size);
        self.b.mul_i64();
        self.b.wrap_i64_to_i32();
        self.si(COND);
        for (register, _) in
            if movs { [(6, false), (7, true)].as_slice() } else { [(7, true)].as_slice() }
        {
            self.g(*register);
            self.b.wrap_i64_to_i32();
            self.c32(4095);
            self.b.and_i32();
            self.gi(COND);
            self.b.add_i32();
            self.c32(4096);
            self.b.gtu_i32();
            self.step_if(start);
        }
        if movs {
            self.g(6);
            self.s(ADDR);
            self.host_or(1, false, start, self.f().step);
            self.si(SRC);
            self.g(7);
            self.s(ADDR);
            self.host_or(1, true, start, self.f().step);
            self.si(HOST);
            // an overlapping forward copy repeats the source (element order)
            self.gi(HOST);
            self.gi(SRC);
            self.b.gtu_i32();
            self.gi(HOST);
            self.gi(SRC);
            self.gi(COND);
            self.b.add_i32();
            self.b.ltu_i32();
            self.b.and_i32();
            self.step_if(start);
            // (a string operation's elements are not ordered among themselves,
            // but with respect to the other instructions: fenced with workers)
            self.b.guest_fence();
            self.gi(HOST);
            self.gi(SRC);
            self.gi(COND);
            self.b.op(0xFC);
            self.b.op(10);
            self.b.op(0);
            self.b.op(0);
            self.b.guest_fence();
        }
        else {
            self.g(7);
            self.s(ADDR);
            self.host_or(1, true, start, self.f().step);
            self.si(HOST);
            self.b.guest_fence();
            self.gi(HOST);
            self.g(0);
            self.b.wrap_i64_to_i32();
            self.gi(COND);
            self.b.op(0xFC);
            self.b.op(11);
            self.b.op(0);
            self.b.guest_fence();
        }
        self.gi(COND);
        self.b.extend_unsigned_i32_to_i64();
        self.s(TX);
        if movs {
            self.g(6);
            self.g(TX);
            self.b.add_i64();
            self.s(6);
        }
        self.g(7);
        self.g(TX);
        self.b.add_i64();
        self.s(7);
        self.c64(0);
        self.s(1);
        self.b.block_end();
    }
    /// Push the high 64 bits of the 128-bit product of i64 locals `a` and
    /// `b` (signed or unsigned), from 32-bit halves (TC and TX are scratch).
    fn mul_high(&mut self, a: usize, b: usize, signed: bool) {
        let half = |e: &mut Self, l: usize, high: bool| {
            e.g(l);
            if high {
                e.c64(32);
                e.b.shr_u_i64();
            }
            else {
                e.c64(0xFFFF_FFFF);
                e.b.and_i64();
            }
        };
        // TC = lo(a) * lo(b) >> 32
        half(self, a, false);
        half(self, b, false);
        self.b.mul_i64();
        self.c64(32);
        self.b.shr_u_i64();
        self.s(TC);
        // TX = hi(a) * lo(b) + TC (no carry out of 64 bits)
        half(self, a, true);
        half(self, b, false);
        self.b.mul_i64();
        self.g(TC);
        self.b.add_i64();
        self.s(TX);
        // TC = lo(a) * hi(b) + lo(TX)
        half(self, a, false);
        half(self, b, true);
        self.b.mul_i64();
        half(self, TX, false);
        self.b.add_i64();
        self.s(TC);
        // hi(a) * hi(b) + hi(TX) + hi(TC)
        half(self, a, true);
        half(self, b, true);
        self.b.mul_i64();
        half(self, TX, true);
        self.b.add_i64();
        half(self, TC, true);
        self.b.add_i64();
        if signed {
            // minus b when a is negative, minus a when b is negative
            for (x, y) in [(a, b), (b, a)] {
                self.g(x);
                self.c64(63);
                self.b.shr_s_i64();
                self.g(y);
                self.b.and_i64();
                self.b.sub_i64();
            }
        }
    }
    /// REPE/REPNE CMPS or SCAS inside one page per operand, forward: one
    /// loop over the elements, EFLAGS of the last comparison; anything else
    /// is stepped (the step dispatches back here to continue).
    fn rep_compare(&mut self, inst: &Inst, width: u8, scan: bool, equal: bool) {
        let start = inst.d.start.0;
        let size = width as u64 / 8;
        self.materialize_if(ARITH);
        // RCX = 0: nothing happens
        self.g(1);
        self.b.op(op::OP_I64EQZ);
        self.b.eqz_i32();
        self.b.if_void();
        self.gi(FL);
        self.c32(0x400);
        self.b.and_i32();
        self.g(1);
        self.c64(4096 / size);
        self.b.op(op::OP_I64GTU);
        self.b.or_i32();
        self.step_if(start);
        // at most this many bytes, within 4096
        self.g(1);
        self.c64(size);
        self.b.mul_i64();
        self.b.wrap_i64_to_i32();
        self.si(COND);
        for register in if scan { [7].as_slice() } else { [6, 7].as_slice() } {
            self.g(*register);
            self.b.wrap_i64_to_i32();
            self.c32(4095);
            self.b.and_i32();
            self.gi(COND);
            self.b.add_i32();
            self.c32(4096);
            self.b.gtu_i32();
            self.step_if(start);
        }
        if !scan {
            self.g(6);
            self.s(ADDR);
            self.host_or(1, false, start, self.f().step);
            self.si(SRC);
        }
        self.g(7);
        self.s(ADDR);
        self.host_or(1, false, start, self.f().step);
        self.si(HOST);
        // (the elements are plain loads, ordered as a whole by a fence with
        // cores in workers; any alignment)
        let plain = |e: &mut Self, base: usize| {
            e.gi(base);
            e.gi(ENT);
            e.b.add_i32();
            e.b.memory_op(
                match width {
                    8 => op::OP_I64LOAD8U,
                    16 => op::OP_I64LOAD16U,
                    32 => op::OP_I64LOAD32U,
                    _ => op::OP_I64LOAD,
                },
                op::MEM_NO_ALIGN,
                0,
            );
        };
        if scan {
            self.get_reg(RAX, width);
            self.s(TA);
        }
        self.c32(0);
        self.si(ENT);
        let again = self.b.loop_void();
        if !scan {
            plain(self, SRC);
            self.s(TA);
        }
        plain(self, HOST);
        self.s(TB);
        self.gi(ENT);
        self.c32(size as i32);
        self.b.add_i32();
        self.si(ENT);
        self.g(TA);
        self.g(TB);
        if equal {
            self.b.eq_i64();
        }
        else {
            self.b.ne_i64();
        }
        self.gi(ENT);
        self.gi(COND);
        self.b.ltu_i32();
        self.b.and_i32();
        self.b.br_if(again);
        self.b.block_end();
        self.b.guest_fence();
        // elements done: RCX, RSI, RDI
        self.gi(ENT);
        self.b.extend_unsigned_i32_to_i64();
        self.s(TX);
        self.g(1);
        self.g(TX);
        self.c64(size.trailing_zeros() as u64);
        self.b.shr_u_i64();
        self.b.sub_i64();
        self.s(1);
        for register in if scan { [7].as_slice() } else { [6, 7].as_slice() } {
            self.g(*register);
            self.g(TX);
            self.b.add_i64();
            self.s(*register);
        }
        // EFLAGS: the last comparison
        self.g(TA);
        self.g(TB);
        self.b.sub_i64();
        self.mask_to(width);
        self.s(TR);
        self.alu_flags(7, width, 0);
        self.record(7, width, ARITH, 0, inst);
        self.b.block_end();
    }
    fn compare_exchange(&mut self, inst: &Inst, wide: bool, address: &AddressExpr) {
        let start = inst.d.start.0;
        self.address(address, inst.d.next.0, true);
        self.s(ADDR);
        if wide {
            self.g(ADDR);
            self.c64(15);
            self.b.and_i64();
            self.b.wrap_i64_to_i32();
            self.retry_if(start);
        }
        self.host(if wide { 16 } else { 8 }, true, start);
        self.si(HOST);
        self.gi(HOST);
        self.load(64);
        self.s(TA);
        if wide {
            self.gi(HOST);
            self.b.guest_load_i64_bits(64, 8);
            self.s(TB);
            self.g(TA);
            self.g(0);
            self.b.eq_i64();
            self.g(TB);
            self.g(2);
            self.b.eq_i64();
            self.b.and_i32();
            self.si(COND);
            self.gi(HOST);
            self.g(3);
            self.g(TA);
            self.gi(COND);
            self.b.select();
            self.store(64);
            self.gi(HOST);
            self.g(1);
            self.g(TB);
            self.gi(COND);
            self.b.select();
            self.b.guest_store_i64_bits(64, 8);
            self.gi(COND);
            self.b.eqz_i32();
            self.b.if_void();
            self.g(TA);
            self.s(0);
            self.g(TB);
            self.s(2);
            self.b.block_end();
        }
        else {
            // EDX:EAX against the qword, ECX:EBX stored on a match
            self.g(2);
            self.c64(32);
            self.b.shl_i64();
            self.g(0);
            self.mask_to(32);
            self.b.or_i64();
            self.g(TA);
            self.b.eq_i64();
            self.si(COND);
            self.gi(HOST);
            self.g(1);
            self.c64(32);
            self.b.shl_i64();
            self.g(3);
            self.mask_to(32);
            self.b.or_i64();
            self.g(TA);
            self.gi(COND);
            self.b.select();
            self.store(64);
            self.gi(COND);
            self.b.eqz_i32();
            self.b.if_void();
            self.g(TA);
            self.set_reg(RAX, 32);
            self.g(TA);
            self.c64(32);
            self.b.shr_u_i64();
            self.set_reg(RDX, 32);
            self.b.block_end();
        }
        self.flags_begin(ZF);
        self.gi(COND);
        self.c32(6);
        self.b.shl_i32();
        self.flags_end(false);
        self.written(ZF);
    }
}
