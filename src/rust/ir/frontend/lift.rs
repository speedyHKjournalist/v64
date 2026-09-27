use super::{
    decode::*,
    integer::{width_type, IntegerBuilder},
};
use crate::ir::{
    hir::*,
    ids::*,
    lowering::CompileError,
    state::{ResumeKind, StateMap},
    types::Type,
};
pub(super) fn snapshot(
    b: &mut IntegerBuilder,
    pc: GuestEip,
    next: GuestEip,
    count: u32,
) -> StateId {
    b.region.state(StateMap {
        instruction_pc: pc,
        next_pc: next,
        next_value: None,
        resume: ResumeKind::AfterInstruction,
        gpr: b.gpr,
        flags: b.flags.clone(),
        xmm: b.xmm.clone(),
        x87: vec![],
        committed_instructions: count,
        count_base: None,
        rep_progress: None,
    })
}
/// Lower a bounded register-only sequence. Control branches must end the snapshot.
/// Unsupported instructions return an error; no partially lifted artifact can be published.
pub fn lift(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
) -> Result<Region, CompileError> {
    lift_inner(bytes, pc, linear, default_32, false, 128, false)
}
pub fn lift_cpu(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
) -> Result<Region, CompileError> {
    lift_cpu_with_rep_budget(bytes, pc, linear, default_32, 128)
}
pub fn lift_cpu_with_rep_budget(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    rep_budget: u32,
) -> Result<Region, CompileError> {
    lift_inner(bytes, pc, linear, default_32, true, rep_budget, false)
}
/// Compact CFG fragments retain the original per-instruction budget checks,
/// without materializing a separate phi frame and block for each instruction.
pub(super) fn lift_cpu_with_polls(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    rep_budget: u32,
) -> Result<Region, CompileError> {
    lift_inner(bytes, pc, linear, default_32, true, rep_budget, true)
}
fn lift_inner(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    cpu: bool,
    rep_budget: u32,
    instruction_polls: bool,
) -> Result<Region, CompileError> {
    if rep_budget > 4096 {
        return Err(CompileError::Budget("REP iteration budget"));
    }
    let mut b = IntegerBuilder::new();
    let mut offset = 0;
    let mut count = 0;
    if bytes.is_empty() {
        return Err(CompileError::Unsupported("empty region"));
    }
    while offset < bytes.len() {
        if count == 128 || b.region.instructions.len() > 4096 {
            return Err(CompileError::Budget("integer frontend region"));
        }
        let i = decode(
            &bytes[offset..],
            GuestEip(pc.0.wrapping_add(offset as u32)),
            LinearAddress(linear.0.wrapping_add(offset as u32)),
            default_32,
        )
        .map_err(|_| CompileError::Unsupported("decode stop"))?;
        if instruction_polls && count != 0 {
            let state = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
            b.region.states[state.index()].resume = ResumeKind::BeforeInstruction;
            b.effect = b.region.append(
                b.block,
                Op::PollBudget,
                vec![b.effect],
                &[Type::Effect],
                Some(state),
            )[0];
        }
        offset += i.length as usize;
        count += 1;
        if cfg!(debug_assertions)
            && (i.debug_prefix_assert
                || i.encoding.opcode == 0x0FAE && i.encoding.group == 2 && i.ea.is_none())
        {
            return Err(CompileError::Unsupported("baseline debug prefix assertion"));
        }
        if i.prefixes.lock && !super::exchange::lock_supported(&i) {
            return Err(CompileError::Unsupported("LOCK or invalid operand"));
        }
        if i.baseline_ud {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "invalid form requires terminal CPU region",
                ));
            }
            let state = snapshot(&mut b, i.instruction_pc, i.next_pc, count - 1);
            b.region.states[state.index()].resume = crate::ir::state::ResumeKind::BeforeInstruction;
            let guard = b.constant(
                if i.encoding.sse { 2 } else { i.encoding.task_switch_test as u32 },
                Type::I32,
            );
            let (offset, segment) = if let Some(ea) = i.ea {
                (
                    effective_offset(&mut b, &ea),
                    b.constant(ea.segment as u32, Type::I32),
                )
            }
            else {
                (b.constant(0, Type::I32), b.constant(u32::MAX, Type::I32))
            };
            super::adapters::call(
                &mut b,
                "ir_invalid_form",
                vec![guard, offset, segment],
                state,
                true,
            );
            return Ok(b.region);
        }
        if i.encoding.opcode == 0xFB {
            if !cpu {
                return Err(CompileError::Unsupported("STI requires CPU ABI"));
            }
            let start = offset - i.length as usize;
            if start
                + super::sti::extent(&bytes[start..], i.instruction_pc, i.linear_pc, default_32)?
                != bytes.len()
            {
                return Err(CompileError::Unsupported(
                    "STI fragment must end after shadow",
                ));
            }
            super::sti::lift(&mut b, &i, count);
            continue;
        }
        let op = i.encoding.opcode;
        let rm = i.modrm.map_or(0, |m| m & 7);
        let reg = i.modrm.map_or(0, |m| m >> 3 & 7);
        if super::simd_moves::supports(&i)
            || super::simd_integer::supports(&i)
            || super::simd_immediate::supports(&i)
            || super::simd_shuffle::supports(&i)
            || super::simd_transfer::supports(&i)
            || super::simd_lane::supports(&i)
            || super::simd_masked::supports(&i)
        {
            if !cpu {
                return Err(CompileError::Unsupported("XMM operations require CPU ABI"));
            }
            let moves = super::simd_moves::supports(&i);
            if moves {
                super::simd_moves::lift(&mut b, &i, count);
            }
            else if super::simd_masked::supports(&i) {
                super::simd_masked::lift(&mut b, &i, count);
            }
            else if super::simd_lane::supports(&i) {
                super::simd_lane::lift(&mut b, &i, count);
            }
            else if super::simd_transfer::supports(&i) {
                super::simd_transfer::lift(&mut b, &i, count);
            }
            else if super::simd_shuffle::supports(&i) {
                super::simd_shuffle::lift(&mut b, &i, count);
            }
            else if super::simd_immediate::supports(&i) {
                super::simd_immediate::lift(&mut b, &i, count);
            }
            else {
                super::simd_integer::lift(&mut b, &i, count);
            }
            // Native same-page vector stores may continue under the MIR RAM
            // guard and immutable-code-page alias check. Slow paths still own
            // their precise commit and exit; do not truncate the whole region.
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
                return Ok(b.region);
            }
            continue;
        }
        if super::coverage::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "coverage adapter requires terminal CPU region",
                ));
            }
            super::coverage::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::mmx::supports(&i) {
            if !cpu || super::mmx::terminal(&i) && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "MMX memory requires terminal CPU region",
                ));
            }
            super::mmx::lift(&mut b, &i, count);
            if super::mmx::terminal(&i) {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::sse_fp::supports(&i) {
            if !cpu {
                return Err(CompileError::Unsupported("SSE FP requires CPU ABI"));
            }
            super::sse_fp::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
                return Ok(b.region);
            }
            continue;
        }
        if super::x87::supports(&i) {
            let continues = super::x87::continues(&i);
            if !cpu || !continues && i.ea.is_some() && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "x87 memory requires terminal CPU region",
                ));
            }
            super::x87::lift(&mut b, &i, count);
            if !continues && i.ea.is_some() {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::misc::supports(&i) {
            if !cpu && super::misc::needs_cpu(&i) {
                return Err(CompileError::Unsupported(
                    "implicit memory/AAM requires CPU ABI",
                ));
            }
            super::misc::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::branch::supports(&i) {
            if offset != bytes.len() {
                return Err(CompileError::Unsupported("branch inside linear region"));
            }
            super::branch::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::control::supports(&i) {
            if !cpu {
                return Err(CompileError::Unsupported(
                    "near control transfer requires CPU ABI",
                ));
            }
            if offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "control transfer inside linear region",
                ));
            }
            super::control::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if op == 0x0FC7 && reg == 1 {
            if !cpu || i.ea.is_none() || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "CMPXCHG8B requires terminal CPU memory region",
                ));
            }
            let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count - 1);
            b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
            let ea = i.ea.unwrap();
            let offset = effective_offset(&mut b, &ea);
            let address = segmented(&mut b, offset, ea.segment, map);
            b.effect = b.region.append(
                b.block,
                Op::CompareExchange8B {
                    order: if i.prefixes.lock { RmwOrder::Locked } else { RmwOrder::Plain },
                },
                vec![address, b.effect],
                &[Type::Effect],
                Some(map),
            )[0];
            b.region.terminate(b.block, Terminator::Exit(map));
            return Ok(b.region);
        }
        if super::selector_query::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "selector query requires terminal CPU region",
                ));
            }
            super::selector_query::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::task_regs::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "task/LDTR operation requires terminal CPU region",
                ));
            }
            super::task_regs::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::descriptor::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "descriptor operation requires terminal CPU region",
                ));
            }
            super::descriptor::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::control_regs::supports(&i) {
            let terminal = super::control_regs::terminal(&i);
            if !cpu || terminal && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "CR/DR write requires terminal CPU region",
                ));
            }
            super::control_regs::lift(&mut b, &i, count);
            if terminal {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::fp_state::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "FP state requires terminal CPU region",
                ));
            }
            super::fp_state::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::far_control::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "far control requires terminal CPU region",
                ));
            }
            super::far_control::lift(&mut b, &i, count);
            return Ok(b.region);
        }
        if super::cpu_system::supports(&i) {
            if !cpu || i.encoding.opcode != 0xFA && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "system helper requires terminal CPU region",
                ));
            }
            super::cpu_system::lift(&mut b, &i, count);
            if i.encoding.opcode != 0xFA {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::cpu_info::supports(&i) {
            let continuing = !super::cpu_info::terminal(&i);
            if !cpu || !continuing && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "CPU information helper requires terminal CPU region",
                ));
            }
            super::cpu_info::lift(&mut b, &i, count);
            if !continuing {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::rep::supports(&i) {
            if !cpu || offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "REP requires terminal CPU region",
                ));
            }
            super::rep::lift(&mut b, &i, count, rep_budget);
            return Ok(b.region);
        }
        if super::io::supports(&i) {
            let continuing = i.encoding.opcode >= 0xE4;
            if !cpu || !continuing && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "I/O requires terminal CPU region",
                ));
            }
            super::io::lift(&mut b, &i, count)?;
            if !continuing {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::string::supports(&i) {
            if !cpu {
                return Err(CompileError::Unsupported("string requires CPU ABI"));
            }
            super::string::lift(&mut b, &i, count)?;
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::segment::supports(&i) {
            if !cpu {
                return Err(CompileError::Unsupported(
                    "segment instruction requires CPU ABI",
                ));
            }
            if super::segment::terminal(&i) && offset != bytes.len() {
                return Err(CompileError::Unsupported("segment change must end region"));
            }
            super::segment::lift(&mut b, &i, count)?;
            if super::segment::terminal(&i) {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::system_stack::supports(&i) {
            if !cpu {
                return Err(CompileError::Unsupported("system stack requires CPU ABI"));
            }
            if super::system_stack::pops(&i) && offset != bytes.len() {
                return Err(CompileError::Unsupported(
                    "state-changing stack pop must end region",
                ));
            }
            super::system_stack::lift(&mut b, &i, count);
            if super::system_stack::pops(&i) {
                return Ok(b.region);
            }
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::stack::supports(&i) {
            if !cpu {
                return Err(CompileError::Unsupported("stack requires CPU ABI"));
            }
            super::stack::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::exchange::supports(&i) {
            if !cpu && i.ea.is_some() {
                return Err(CompileError::Unsupported("guest memory requires CPU ABI"));
            }
            super::exchange::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::bits::supports(&i) {
            if !cpu && i.ea.is_some() {
                return Err(CompileError::Unsupported("guest memory requires CPU ABI"));
            }
            super::bits::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::multiply::supports(&i) {
            if !cpu && (i.ea.is_some() || super::multiply::divides(&i)) {
                return Err(CompileError::Unsupported(
                    "multiply memory/divide requires CPU ABI",
                ));
            }
            super::multiply::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if super::shift::supports(&i) {
            if !cpu && i.ea.is_some() {
                return Err(CompileError::Unsupported("guest memory requires CPU ABI"));
            }
            super::shift::lift(&mut b, &i, count);
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        if i.ea.is_some() && op != 0x8D {
            if !cpu {
                return Err(CompileError::Unsupported("guest memory requires CPU ABI"));
            }
            memory_instruction(&mut b, &i, count)?;
            if offset == bytes.len() {
                let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
                b.region.terminate(b.block, Terminator::Exit(map));
            }
            continue;
        }
        let width = if op & 1 == 0 { 8 } else { i.operand_size };
        match op {
            0x90 => (),
            0xB0..=0xBF => {
                let width = if op < 0xB8 { 8 } else { i.operand_size };
                let value = b.constant(i.immediate.unwrap(), width_type(width));
                b.write(op as u8 & 7, width, value);
            },
            0x88..=0x8B => {
                let (dst, src) = if op & 2 == 0 { (rm, reg) } else { (reg, rm) };
                let value = b.read(src, width);
                b.write(dst, width, value);
            },
            0xC6 | 0xC7 => {
                let value = b.constant(i.immediate.unwrap(), width_type(width));
                b.write(rm, width, value);
            },
            0x86 | 0x87 | 0x91..=0x97 => {
                let (a, c, width) =
                    if op >= 0x91 { (0, op as u8 & 7, i.operand_size) } else { (rm, reg, width) };
                let va = b.read(a, width);
                let vc = b.read(c, width);
                b.write(a, width, vc);
                b.write(c, width, va);
            },
            0x8D => {
                let ea = i.ea.unwrap();
                let mut value = b.constant(ea.displacement, Type::I32);
                if let Some(reg) = ea.base {
                    value = b.binary(Binary::Add, value, b.gpr[reg as usize]);
                }
                if let Some(reg) = ea.index {
                    let shift = b.constant(ea.scale as u32, Type::I32);
                    let index = b.binary(Binary::Shl, b.gpr[reg as usize], shift);
                    value = b.binary(Binary::Add, value, index);
                }
                if ea.address_size == 16 {
                    let mask = b.constant(0xFFFF, Type::I32);
                    value = b.binary(Binary::And, value, mask);
                }
                if i.operand_size == 16 {
                    value = b.node(Op::Truncate, vec![value], Type::I16);
                }
                b.write(reg, i.operand_size, value);
            },
            0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF => {
                let src_width = if op & 1 == 0 { 8 } else { 16 };
                let value = b.read(rm, src_width);
                let value = if src_width == i.operand_size {
                    value
                }
                else {
                    b.node(
                        Op::Extend {
                            signed: op & 8 != 0,
                        },
                        vec![value],
                        width_type(i.operand_size),
                    )
                };
                b.write(reg, i.operand_size, value);
            },
            0x0F90..=0x0F9F => {
                let cc = b.condition(op as u8 & 15);
                let byte = b.node(Op::Extend { signed: false }, vec![cc], Type::I8);
                b.write(rm, 8, byte);
            },
            0x0F40..=0x0F4F => {
                let cc = b.condition(op as u8 & 15);
                let a = b.read(rm, i.operand_size);
                let old = b.read(reg, i.operand_size);
                let value = b.node(Op::Select, vec![cc, a, old], width_type(i.operand_size));
                b.write(reg, i.operand_size, value);
            },
            0xF8 | 0xF9 => {
                let carry = b.constant((op == 0xF9) as u32, Type::I1);
                b.flags.arithmetic[0] = carry;
                b.preserve_cf_backing(carry);
            },
            0xF5 => {
                let one = b.constant(1, Type::I1);
                let carry = b.binary(Binary::Xor, b.flags.arithmetic[0], one);
                b.flags.arithmetic[0] = carry;
                b.preserve_cf_backing(carry);
            },
            0x40..=0x4F | 0xFE | 0xFF if op < 0xFE || reg < 2 => {
                let (dst, width, dec) = if op < 0xFE {
                    (op as u8 & 7, i.operand_size, op >= 0x48)
                }
                else {
                    (rm, width, reg == 1)
                };
                let carry = b.flags.arithmetic[0];
                let a = b.read(dst, width);
                let one = b.constant(1, width_type(width));
                let value = b.arithmetic(if dec { 5 } else { 0 }, a, one);
                b.flags.arithmetic[0] = carry;
                b.preserve_incdec_backing(carry, dec);
                b.write(dst, width, value);
            },
            0xF6 | 0xF7 if reg == 2 || reg == 3 => {
                let a = b.read(rm, width);
                let value = if reg == 2 {
                    let ones = b.constant(u32::MAX, width_type(width));
                    b.binary(Binary::Xor, a, ones)
                }
                else {
                    let zero = b.constant(0, width_type(width));
                    b.arithmetic(5, zero, a)
                };
                b.write(rm, width, value);
            },
            0x00..=0x3D if op & 7 <= 5 => {
                let group = (op >> 3) as u8;
                let ty = width_type(width);
                let (dst, a, source) = if op & 7 >= 4 {
                    (0, b.read(0, width), b.constant(i.immediate.unwrap(), ty))
                }
                else {
                    let (dst, src) = if op & 2 == 0 { (rm, reg) } else { (reg, rm) };
                    (dst, b.read(dst, width), b.read(src, width))
                };
                let value = b.arithmetic(group, a, source);
                if group != 7 {
                    b.write(dst, width, value);
                }
            },
            0x80 | 0x81 | 0x82 | 0x83 => {
                let a = b.read(rm, width);
                let source = b.constant(i.immediate.unwrap(), width_type(width));
                let value = b.arithmetic(reg, a, source);
                if reg != 7 {
                    b.write(rm, width, value);
                }
            },
            0x84 | 0x85 | 0xA8 | 0xA9 | 0xF6 | 0xF7 if op < 0xF6 || reg <= 1 => {
                let (a, source) = if op == 0x84 || op == 0x85 {
                    (b.read(rm, width), b.read(reg, width))
                }
                else {
                    (
                        b.read(if op < 0xF6 { 0 } else { rm }, width),
                        b.constant(i.immediate.unwrap(), width_type(width)),
                    )
                };
                b.arithmetic(4, a, source);
            },
            _ => return Err(CompileError::Unsupported("instruction lowering pending")),
        }
        if offset == bytes.len() {
            let map = snapshot(&mut b, i.instruction_pc, i.next_pc, count);
            b.region.terminate(b.block, Terminator::Exit(map));
        }
    }
    Ok(b.region)
}

fn memory_instruction(
    b: &mut IntegerBuilder,
    i: &DecodedInstruction,
    count: u32,
) -> Result<(), CompileError> {
    let op = i.encoding.opcode;
    let group = i.modrm.unwrap() >> 3 & 7;
    let alu = op <= 0x3B && op & 7 <= 3;
    let unary = matches!(op, 0xFE | 0xFF) && group < 2
        || matches!(op, 0xF6 | 0xF7) && matches!(group, 2 | 3);
    let test = matches!(op, 0x84 | 0x85) || matches!(op, 0xF6 | 0xF7) && group <= 1;
    if !alu
        && !unary
        && !test
        && !matches!(op,
        0x80 | 0x81 | 0x82 | 0x83 | 0x88..=0x8B | 0xC6 | 0xC7 | 0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF | 0x0F40..=0x0F4F | 0x0F90..=0x0F9F)
    {
        return Err(CompileError::Unsupported(
            "memory instruction lowering pending",
        ));
    }
    let map = snapshot(b, i.instruction_pc, i.next_pc, count - 1);
    b.region.states[map.index()].resume = ResumeKind::BeforeInstruction;
    let ea = i.ea.unwrap();
    let offset = effective_offset(b, &ea);
    let address = b.region.append(
        b.block,
        Op::SegmentAddress {
            segment: ea.segment,
        },
        vec![offset, b.effect],
        &[Type::LinearAddress, Type::Effect],
        Some(map),
    );
    b.effect = address[1];
    let address = address[0];
    let extended = matches!(op, 0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF);
    let width = if (0x0F90..=0x0F9F).contains(&op) {
        8
    }
    else if (0x0F40..=0x0F4F).contains(&op) {
        i.operand_size
    }
    else if op & 1 == 0 {
        8
    }
    else if extended {
        16
    }
    else {
        i.operand_size
    };
    let ty = width_type(width);
    let reg = group;
    if matches!(op, 0x88 | 0x89 | 0xC6 | 0xC7 | 0x0F90..=0x0F9F) {
        let value = if op > 255 {
            let flag = b.condition(op as u8 & 15);
            b.node(Op::Extend { signed: false }, vec![flag], Type::I8)
        }
        else if op >= 0xC6 {
            b.constant(i.immediate.unwrap(), ty)
        }
        else {
            b.read(reg, width)
        };
        memory_store(b, address, value, width, map, i, count, false);
    }
    else if matches!(op, 0x8A | 0x8B) || extended || (0x0F40..=0x0F4F).contains(&op) {
        let (value, _) = memory_read(b, address, width, map, false);
        let value = if extended && width != i.operand_size {
            b.node(
                Op::Extend {
                    signed: op & 8 != 0,
                },
                vec![value],
                width_type(i.operand_size),
            )
        }
        else if (0x0F40..=0x0F4F).contains(&op) {
            let condition = b.condition(op as u8 & 15);
            let old = b.read(reg, width);
            b.node(Op::Select, vec![condition, value, old], ty)
        }
        else {
            value
        };
        b.write(reg, if extended { i.operand_size } else { width }, value);
    }
    else {
        let immediate = matches!(op, 0x80 | 0x81 | 0x82 | 0x83);
        let alu_group = if alu { (op >> 3) as u8 } else { group };
        let memory_destination = unary || immediate || alu && op & 2 == 0;
        let rmw = unary || memory_destination && alu_group != 7 && !test;
        let (memory, ticket) = memory_read(b, address, width, map, rmw);
        let result = if unary {
            if matches!(op, 0xFE | 0xFF) {
                let carry = b.flags.arithmetic[0];
                let one = b.constant(1, ty);
                let value = b.arithmetic(if group == 0 { 0 } else { 5 }, memory, one);
                b.flags.arithmetic[0] = carry;
                b.preserve_incdec_backing(carry, group == 1);
                value
            }
            else if group == 2 {
                let ones = b.constant(u32::MAX, ty);
                b.binary(Binary::Xor, memory, ones)
            }
            else {
                let zero = b.constant(0, ty);
                b.arithmetic(5, zero, memory)
            }
        }
        else {
            let other = if immediate || matches!(op, 0xF6 | 0xF7) {
                b.constant(i.immediate.unwrap(), ty)
            }
            else {
                b.read(reg, width)
            };
            let (a, source) =
                if memory_destination || test { (memory, other) } else { (other, memory) };
            b.arithmetic(if test { 4 } else { alu_group }, a, source)
        };
        if rmw {
            memory_store(b, ticket.unwrap(), result, width, map, i, count, true);
        }
        else if !test && alu_group != 7 {
            b.write(reg, width, result);
        }
    }
    Ok(())
}
pub(super) fn memory_read(
    b: &mut IntegerBuilder,
    address: ValueId,
    width: u8,
    map: StateId,
    rmw: bool,
) -> (ValueId, Option<ValueId>) {
    let types = if rmw {
        vec![width_type(width), Type::RmwTicket, Type::Effect]
    }
    else {
        vec![width_type(width), Type::Effect]
    };
    let values = b.region.append(
        b.block,
        if rmw {
            Op::RmwLoad {
                bytes: width / 8,
                order: RmwOrder::Plain,
            }
        }
        else {
            Op::GuestLoad { bytes: width / 8 }
        },
        vec![address, b.effect],
        &types,
        Some(map),
    );
    b.effect = *values.last().unwrap();
    (values[0], rmw.then(|| values[1]))
}
pub(super) fn memory_store(
    b: &mut IntegerBuilder,
    address: ValueId,
    value: ValueId,
    width: u8,
    map: StateId,
    i: &DecodedInstruction,
    count: u32,
    rmw: bool,
) {
    let order = if i.prefixes.lock || matches!(i.encoding.opcode, 0x86 | 0x87) {
        RmwOrder::Locked
    }
    else {
        RmwOrder::Plain
    };
    if rmw {
        let Definition::Instruction(producer, _) = b.region.values[address.index()].definition
        else {
            unreachable!()
        };
        let Op::RmwLoad {
            order: load_order, ..
        } = &mut b.region.instructions[producer.index()].op
        else {
            unreachable!()
        };
        *load_order = order;
    }
    b.effect = b.region.append(
        b.block,
        if rmw {
            Op::RmwStore {
                bytes: width / 8,
                order,
            }
        }
        else {
            Op::GuestStore { bytes: width / 8 }
        },
        vec![address, value, b.effect],
        &[Type::Effect],
        Some(map),
    )[0];
    let commit = snapshot(b, i.instruction_pc, i.next_pc, count);
    let store = *b.region.blocks[b.block.index()]
        .instructions
        .last()
        .unwrap();
    b.region.instructions[store.index()].commit = Some(commit);
}

pub(super) fn effective_offset(b: &mut IntegerBuilder, ea: &EffectiveAddress) -> ValueId {
    let mut offset = b.constant(ea.displacement, Type::I32);
    if let Some(base) = ea.base {
        offset = b.binary(Binary::Add, offset, b.gpr[base as usize]);
    }
    if let Some(index) = ea.index {
        let scale = b.constant(ea.scale as u32, Type::I32);
        let index = b.binary(Binary::Shl, b.gpr[index as usize], scale);
        offset = b.binary(Binary::Add, offset, index);
    }
    if ea.address_size == 16 {
        let mask = b.constant(65535, Type::I32);
        offset = b.binary(Binary::And, offset, mask);
    }
    offset
}
pub(super) fn segmented(
    b: &mut IntegerBuilder,
    offset: ValueId,
    segment: u8,
    map: StateId,
) -> ValueId {
    let values = b.region.append(
        b.block,
        Op::SegmentAddress { segment },
        vec![offset, b.effect],
        &[Type::LinearAddress, Type::Effect],
        Some(map),
    );
    b.effect = values[1];
    values[0]
}
