//! VEX instructions in the 32-bit interpreter (docs/simd-xsave-plan.md). The
//! VEX prefix and the row it selects follow the rules the IR and x64 decoders
//! share (decode_rules::Vex, vex_row, vex_valid); rows whose semantics come in
//! later phases are #UD after the ModRM byte.
use crate::cpu::cpu::*;
use crate::cpu::global_pointers::*;
use crate::decode_rules::{vex_prefixes_ud, vex_row, vex_valid, Vex};

/// C4 or C5 (`first`) whose ModRM byte as LES/LDS, `byte1`, is a register
/// form: the first byte of a VEX prefix in protected mode. Real and
/// virtual-8086 mode have no VEX: LES/LDS, whose register form is #UD. A
/// 66/F2/F3 prefix is #UD here too, where LOCK was (decode_rules::lock_allowed).
pub unsafe fn run(first: u8, byte1: u8) {
    if !*protected_mode || vm86_mode() || vex_prefixes_ud(*prefixes) {
        trigger_ud();
        return;
    }
    let v = if first == 0xC4 {
        Vex::three(byte1, return_on_pagefault!(read_imm8()) as u8, false)
    }
    else {
        Vex::two(byte1, false)
    };
    let key = v.key(return_on_pagefault!(read_imm8()) as u8);
    let rows = crate::decode::candidates(key);
    // (a key without rows, including the reserved maps: #UD at the opcode byte)
    let Some(family) = rows.first()
    else {
        trigger_ud();
        return;
    };
    let modrm =
        if family.fetch_modrm { Some(return_on_pagefault!(read_imm8()) as u8) } else { None };
    let address_size = if is_asize_32() { 32 } else { 16 };
    let row = vex_row(rows, v, modrm, false)
        .filter(|row| row.exists() && row.implemented() && vex_valid(row, v, modrm, address_size));
    // (no VEX row has its semantics yet)
    dbg_assert!(row.is_none());
    trigger_ud();
}
