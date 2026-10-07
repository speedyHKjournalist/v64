//! VEX instructions in the 32-bit interpreter (docs/simd-xsave-plan.md). The
//! VEX prefix and the row it selects follow the rules the IR and x64 decoders
//! share (decode_rules::Vex, vex_row, vex_valid); rows whose semantics come in
//! later phases are #UD after the ModRM byte. The AVX forms run in the shared
//! executor (crate::cpu::avx).
use crate::cpu::avx;
use crate::cpu::cpu::*;
use crate::cpu::global_pointers::*;
use crate::cpu::modrm::resolve_offset;
use crate::decode::ImmediateKind;
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
    let Some(row) = vex_row(rows, v, modrm, false)
        .filter(|row| row.exists() && row.implemented() && vex_valid(row, v, modrm, address_size))
    else {
        trigger_ud();
        return;
    };
    // The instruction's remaining bytes, then the AVX state (#UD, #NM), then
    // the operand's segment (SDM vol. 3, 6.9: the faults of fetching and
    // decoding an instruction come before those of executing it)
    let memory = match modrm {
        Some(m) if m < 0xC0 => Some(return_on_pagefault!(resolve_offset(m as i32))),
        _ => None,
    };
    let imm8 = if row.immediate == ImmediateKind::Byte {
        return_on_pagefault!(read_imm8()) as u8
    }
    else {
        0
    };
    let mut machine = avx::Interpreter { address: 0 };
    if avx::check(&mut machine).is_err() {
        return;
    }
    machine.address = match memory {
        Some((offset, segment)) => {
            return_on_pagefault!(get_seg_prefix(segment)).wrapping_add(offset)
        },
        // VMASKMOVDQU's destination
        None if row.opcode == 0xC40101F7 => {
            return_on_pagefault!(get_seg_prefix_ds(get_reg_asize(EDI)))
        },
        None => 0,
    };
    let i = avx::Instruction {
        key: row.opcode,
        reg: modrm.map_or(0, |m| m >> 3 & 7),
        vvvv: v.vvvv,
        rm: modrm.filter(|m| *m >= 0xC0).map(|m| m & 7),
        l: v.l,
        w: v.w,
        imm8,
        long: false,
    };
    let _ = avx::execute(&mut machine, &i);
}
