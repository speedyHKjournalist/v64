//! Precise long-mode integer interpreter. Every memory destination is validated
//! before a read/modify/write, and architectural registers/flags commit only
//! after the last faultable access. REP retires one restartable element at a time.
use super::{
    decode::{self, ByteRegister, DecodeError, Decoded},
    memory::{self, Fault},
    state,
};
const CF: u64 = 1;
const PF: u64 = 4;
const AF: u64 = 16;
const ZF: u64 = 64;
const SF: u64 = 128;
const OF: u64 = 2048;
const ARITH: u64 = CF | PF | AF | ZF | SF | OF;
fn mask(w: u8) -> u64 {
    if w == 64 {
        u64::MAX
    }
    else {
        (1u64 << w) - 1
    }
}
fn signed(v: u64, w: u8) -> i128 { ((v << (64 - w)) as i64 >> (64 - w)) as i128 }
fn szp(v: u64, w: u8) -> u64 {
    let v = v & mask(w);
    (if v == 0 { ZF } else { 0 })
        | if v >> (w - 1) != 0 { SF } else { 0 }
        | if (v as u8).count_ones() & 1 == 0 { PF } else { 0 }
}
/// operation codes match the x86 ALU /digit encoding.
pub fn alu(op: u8, a: u64, b: u64, w: u8, flags: u64) -> (u64, u64) {
    let a = a & mask(w);
    let b = b & mask(w);
    let carry = if op == 2 || op == 3 { flags & CF } else { 0 };
    let (r, cf, of, af) = match op {
        0 | 2 => {
            let sum = a as u128 + b as u128 + carry as u128;
            let r = sum as u64 & mask(w);
            (
                r,
                sum >> w != 0,
                (!(a ^ b) & (a ^ r)) >> (w - 1) != 0,
                (a ^ b ^ r) & 16 != 0,
            )
        },
        3 | 5 | 7 => {
            let sub = b as u128 + carry as u128;
            let r = a.wrapping_sub(b).wrapping_sub(carry) & mask(w);
            (
                r,
                (a as u128) < sub,
                ((a ^ b) & (a ^ r)) >> (w - 1) != 0,
                (a ^ b ^ r) & 16 != 0,
            )
        },
        1 => (a | b, false, false, false),
        4 => (a & b, false, false, false),
        6 => (a ^ b, false, false, false),
        _ => unreachable!(),
    };
    (
        r,
        flags & !ARITH
            | szp(r, w)
            | if cf { CF } else { 0 }
            | if of { OF } else { 0 }
            | if af { AF } else { 0 },
    )
}
pub fn condition(cc: u8, f: u64) -> bool {
    let base = match cc >> 1 {
        0 => f & OF != 0,
        1 => f & CF != 0,
        2 => f & ZF != 0,
        3 => f & (CF | ZF) != 0,
        4 => f & SF != 0,
        5 => f & PF != 0,
        6 => (f & SF != 0) != (f & OF != 0),
        7 => f & ZF != 0 || (f & SF != 0) != (f & OF != 0),
        _ => unreachable!(),
    };
    base ^ (cc & 1 != 0)
}
pub fn shift(op: u8, a: u64, count: u8, w: u8, flags: u64) -> (u64, u64) {
    let a = a & mask(w);
    let raw = count & if w == 64 { 63 } else { 31 };
    let count = match op {
        0 | 1 => raw % w,
        2 | 3 => {
            if w < 32 {
                raw % (w + 1)
            }
            else {
                raw
            }
        },
        _ => raw,
    };
    if count == 0 {
        // ROL/ROR mask the rotate amount modulo operand width, but their
        // carry output is still defined when the masked raw count is nonzero.
        if raw != 0 && op <= 1 {
            let carry = if op == 0 { a & 1 } else { a >> (w - 1) };
            return (a, flags & !CF | carry);
        }
        return (a, flags);
    }
    let sign = 1u64 << (w - 1);
    let (r, cf) = match op {
        0 => {
            let r = (((a as u128) << count) | (a as u128 >> (w - count))) as u64 & mask(w);
            (r, r & 1 != 0)
        },
        1 => {
            let r = ((a >> count) | (a << (w - count))) & mask(w);
            (r, r & sign != 0)
        },
        2 | 3 => {
            let total = w + 1;
            let ext = a as u128 | (((flags & CF) as u128) << w);
            let m = (1u128 << total) - 1;
            let r = if op == 2 {
                (ext << count | ext >> (total - count)) & m
            }
            else {
                (ext >> count | ext << (total - count)) & m
            };
            (r as u64 & mask(w), r >> w != 0)
        },
        4 | 6 => (
            a.wrapping_shl(count as u32) & mask(w),
            count <= w && (a >> (w - count)) & 1 != 0,
        ),
        5 => (
            if count >= w { 0 } else { a >> count },
            count <= w && a >> (count - 1) & 1 != 0,
        ),
        7 => (
            (signed(a, w) >> count) as u64 & mask(w),
            if count >= w { a & sign != 0 } else { a >> (count - 1) & 1 != 0 },
        ),
        _ => unreachable!(),
    };
    let mut f = flags & !CF | if cf { CF } else { 0 };
    if op >= 4 {
        f = f & !(SF | ZF | PF) | szp(r, w);
    }
    if raw == 1 {
        let overflow = match op {
            0 | 2 | 4 | 6 => (r & sign != 0) ^ cf,
            1 | 3 => ((r >> (w - 1)) ^ (r >> (w - 2))) & 1 != 0,
            5 => a & sign != 0,
            7 => false,
            _ => unreachable!(),
        };
        f = f & !OF | if overflow { OF } else { 0 };
    }
    (r, f)
}
pub fn popf_flags(old: u64, value: u64, width: u8, cpl: u8) -> u64 {
    let mut preserve = 0x1B0000; // RF, VM, VIF and VIP cannot be loaded by POPF.
    if width == 16 {
        preserve |= !0xFFFF;
    }
    if cpl != 0 {
        preserve |= 0x3000;
    }
    if cpl as u64 > (old >> 12 & 3) {
        preserve |= 0x200;
    }
    (value & !preserve | old & preserve) & crate::cpu::cpu::FLAGS_MASK as u64 | 2
}
unsafe fn register(r: u8, w: u8, rex: bool) -> u64 {
    if w == 8 {
        match decode::byte_register(r, rex) {
            ByteRegister::Low(r) => state::read_gpr(r as usize) & 255,
            ByteRegister::HighLegacy(r) => state::read_high_byte(r as usize) as u64,
        }
    }
    else {
        state::read_gpr(r as usize) & mask(w)
    }
}
unsafe fn set_register(r: u8, v: u64, w: u8, rex: bool) {
    if w == 8 {
        match decode::byte_register(r, rex) {
            ByteRegister::Low(r) => state::write_gpr(r as usize, v, w),
            ByteRegister::HighLegacy(r) => state::write_high_byte(r as usize, v as u8),
        }
    }
    else {
        state::write_gpr(r as usize, v, w)
    }
}
pub unsafe fn address(d: &Decoded) -> (u64, bool) { address_rsp(d, None) }
unsafe fn address_rsp(d: &Decoded, rsp: Option<u64>) -> (u64, bool) {
    let a = d.address.unwrap();
    let mut regs = [0; 16];
    for r in 0..16 {
        regs[r] = state::read_gpr(r);
    }
    if let Some(v) = rsp {
        regs[4] = v;
    }
    let offset = a.offset(&regs, d.next);
    let base = if a.segment >= 4 { state::read_segment_base(a.segment as usize) } else { 0 };
    (offset.wrapping_add(base), a.segment == 2)
}
unsafe fn rm(d: &Decoded, w: u8, writing: bool) -> Result<u64, Fault> {
    if let Some(r) = d.rm_register {
        Ok(register(r, w, d.prefixes.rex.is_some()))
    }
    else {
        let (a, s) = address(d);
        if writing {
            memory::probe_write(a, w, s)?;
        }
        memory::read(a, w, s)
    }
}
unsafe fn put_rm(d: &Decoded, w: u8, value: u64) -> Result<(), Fault> {
    if let Some(r) = d.rm_register {
        set_register(r, value, w, d.prefixes.rex.is_some());
        Ok(())
    }
    else {
        let (a, s) = address(d);
        memory::write(a, w, value, s)
    }
}
unsafe fn push(v: u64, w: u8) -> Result<(), Fault> {
    let rsp = state::read_gpr(4).wrapping_sub((w / 8) as u64);
    memory::write(rsp, w, v, true)?;
    state::write_gpr(4, rsp, 64);
    Ok(())
}
unsafe fn peek(w: u8) -> Result<u64, Fault> { memory::read(state::read_gpr(4), w, true) }
fn branch(target: u64) -> Result<u64, Fault> {
    if state::canonical(target, 48) {
        Ok(target)
    }
    else {
        Err(Fault::gp())
    }
}
fn relative(d: &Decoded) -> u64 {
    let i = d.immediate.unwrap();
    let disp = if i.encoded_bytes == 1 { i.value as i8 as i64 } else { i.value as i32 as i64 };
    d.next.0.wrapping_add(disp as u64)
}
unsafe fn string(d: &Decoded, op: u32) -> Result<bool, Fault> {
    let repeat = d.prefixes.rep.is_some();
    let aw = d.address_size;
    let count = state::read_gpr(1) & mask(aw);
    if repeat && count == 0 {
        crate::cpu::execution::record_string(crate::cpu::string::StringExecution {
            iterations: 0,
            outcome: crate::cpu::string::StringOutcome::Complete,
        });
        return Ok(false);
    }
    let w = if op & 1 == 0 {
        8
    }
    else if op <= 0x6F {
        d.operand_size.min(32)
    }
    else {
        d.operand_size
    };
    let src = state::read_gpr(6) & mask(aw);
    let dst = state::read_gpr(7) & mask(aw);
    let seg = d.prefixes.segment.unwrap_or(3);
    let source =
        src.wrapping_add(if seg >= 4 { state::read_segment_base(seg as usize) } else { 0 });
    let f = state::read_flags64();
    if repeat && matches!(op, 0xA4 | 0xA5 | 0xAA | 0xAB) && state::read_dr(7) & 255 == 0 {
        if let Some(continuing) = bulk_string(
            op,
            w,
            aw,
            count,
            src,
            dst,
            source.wrapping_sub(src),
            f & 0x400 != 0,
        )? {
            return Ok(continuing);
        }
    }
    let mut nf = f;
    match op {
        0x6C..=0x6F => {
            let port = state::read_gpr(2) as u16;
            super::system::check_io_access(port, w)?;
            if op & 2 == 0 {
                // The entire destination must be writable before a device
                // read consumes data, including a second-page fault.
                memory::probe_write(dst, w, false)?;
                let value = match w {
                    8 => crate::cpu::cpu::io_port_read8(port as i32),
                    16 => crate::cpu::cpu::io_port_read16(port as i32),
                    _ => crate::cpu::cpu::io_port_read32(port as i32),
                };
                memory::write(dst, w, value as u32 as u64, false)?;
            }
            else {
                let value = memory::read(source, w, false)? as i32;
                match w {
                    8 => crate::cpu::cpu::io_port_write8(port as i32, value & 255),
                    16 => crate::cpu::cpu::io_port_write16(port as i32, value & 65535),
                    _ => crate::cpu::cpu::io_port_write32(port as i32, value),
                }
            }
            super::debug::io(port, (w / 8) as usize);
        },
        0xA4 | 0xA5 => {
            memory::probe_write(dst, w, false)?;
            let v = memory::read(source, w, false)?;
            memory::write(dst, w, v, false)?;
        },
        0xA6 | 0xA7 => {
            let a = memory::read(source, w, false)?;
            let b = memory::read(dst, w, false)?;
            nf = alu(7, a, b, w, f).1;
        },
        0xAA | 0xAB => memory::write(dst, w, state::read_gpr(0), false)?,
        0xAC | 0xAD => {
            let v = memory::read(source, w, false)?;
            set_register(0, v, w, true);
        },
        0xAE | 0xAF => {
            let b = memory::read(dst, w, false)?;
            nf = alu(7, state::read_gpr(0), b, w, f).1;
        },
        _ => return Err(Fault::ud()),
    }
    let delta = if f & 0x400 == 0 { (w / 8) as u64 } else { 0u64.wrapping_sub((w / 8) as u64) };
    if matches!(op, 0x6E | 0x6F | 0xA4..=0xA7 | 0xAC | 0xAD) {
        state::write_gpr(6, src.wrapping_add(delta), aw);
    }
    if matches!(op, 0x6C | 0x6D | 0xA4..=0xA7 | 0xAA | 0xAB | 0xAE | 0xAF) {
        state::write_gpr(7, dst.wrapping_add(delta), aw);
    }
    state::write_flags64(nf);
    if repeat {
        state::write_gpr(1, count - 1, aw);
        let cmp = matches!(op, 0xA6 | 0xA7 | 0xAE | 0xAF);
        let continuing = count > 1 && (!cmp || (nf & ZF != 0) == (d.prefixes.rep == Some(0xF3)));
        crate::cpu::execution::record_string(crate::cpu::string::StringExecution {
            iterations: 1,
            outcome: if continuing {
                crate::cpu::string::StringOutcome::Repeat
            }
            else {
                crate::cpu::string::StringOutcome::Complete
            },
        });
        return Ok(continuing);
    }
    Ok(false)
}
/// Elements of one REP MOVS/STOS step over RAM (about one page of data).
const BULK_BYTES: u64 = 4096;
/// REP MOVS/STOS over RAM pages without data breakpoints: each chunk is the
/// whole elements inside the current source and destination pages, copied
/// at once, or in element order when an element would read an earlier one's
/// store (so overlapping MOVS keeps its element semantics), and RCX/RSI/RDI
/// then advance as if the elements ran one by one. None when the
/// first element needs the element path (a fault, device memory, an element
/// crossing a page); a later chunk that cannot proceed just ends this step.
unsafe fn bulk_string(
    op: u32,
    w: u8,
    aw: u8,
    count: u64,
    src: u64,
    dst: u64,
    source_base: u64,
    down: bool,
) -> Result<Option<bool>, Fault> {
    let size = (w / 8) as u64;
    let movs = op <= 0xA5;
    let value = state::read_gpr(0);
    let (mut src, mut dst, mut remaining, mut done) = (src, dst, count, 0u64);
    while remaining != 0 && done * size < BULK_BYTES {
        // Whole elements in the current page, in the direction of travel.
        let room = |address: u64| {
            let offset = address & 4095;
            if offset + size > 4096 {
                0
            }
            else if down {
                offset / size + 1
            }
            else {
                (4096 - offset) / size
            }
        };
        let source = src.wrapping_add(source_base);
        let mut n = room(dst)
            .min(remaining)
            .min((BULK_BYTES / size).max(1) - done.min((BULK_BYTES / size).max(1) - 1));
        if movs {
            n = n.min(room(source));
        }
        // Host addresses: RAM through its backing, extended RAM through its
        // frame (which stays until the dispatch loop's next safe point,
        // crate::x64::extended::cache_frame). The flag: RAM (code may watch it).
        let mem8 = crate::cpu::memory::mem8 as u32;
        let mapped = |address: u64, access| -> Option<(u32, bool)> {
            let physical = memory::translate(address, access, false, false).ok()?;
            match super::jac::ram_backing(physical) {
                Some(page) => Some((mem8.wrapping_add(page + (address & 4095) as u32), true)),
                None => super::extended::cache_frame(
                    physical & !4095,
                    access == super::paging::Access::Write,
                )
                .map(|frame| (frame + (address & 4095) as u32, false)),
            }
        };
        let target = if n == 0 { None } else { mapped(dst, super::paging::Access::Write) };
        let from = if movs && target.is_some() {
            mapped(source, super::paging::Access::Read)
        }
        else {
            Some((0, false))
        };
        let (Some((target, target_ram)), Some((from, _))) = (target, from)
        else {
            if done == 0 {
                return Ok(None);
            }
            break;
        };
        // (a backward chunk's lowest byte is below its first element)
        let span = (n * size) as u32;
        let low = |first: u32| {
            if down {
                first.wrapping_add(size as u32).wrapping_sub(span)
            }
            else {
                first
            }
        };
        if movs {
            // One copy, unless an element reads what an earlier one wrote: a
            // forward move whose destination starts inside the source, a
            // backward one whose source starts inside the destination (LZ
            // backreferences; as cpu::string)
            let interferes = if down {
                from > target && from - target < span
            }
            else {
                target > from && target - from < span
            };
            if interferes {
                for i in 0..n {
                    let step = if down { (i * size).wrapping_neg() } else { i * size };
                    std::ptr::copy(
                        from.wrapping_add(step as u32) as usize as *const u8,
                        target.wrapping_add(step as u32) as usize as *mut u8,
                        size as usize,
                    );
                }
            }
            else {
                std::ptr::copy(
                    low(from) as usize as *const u8,
                    low(target) as usize as *mut u8,
                    span as usize,
                );
            }
        }
        else {
            // (every element stores the same value, in any order)
            let t = low(target) as usize as *mut u8;
            match size {
                1 => std::ptr::write_bytes(t, value as u8, n as usize),
                2 => (0..n as usize)
                    .for_each(|i| (t as *mut u16).add(i).write_unaligned(value as u16)),
                4 => (0..n as usize)
                    .for_each(|i| (t as *mut u32).add(i).write_unaligned(value as u32)),
                _ => (0..n as usize).for_each(|i| (t as *mut u64).add(i).write_unaligned(value)),
            }
        }
        if target_ram {
            let target = target.wrapping_sub(mem8);
            let (low, high) = if down {
                (
                    target + size as u32 - (n * size) as u32,
                    target + size as u32,
                )
            }
            else {
                (target, target + (n * size) as u32)
            };
            if crate::jit::page_watched(low >> 12) || crate::jit::page_watched((high - 1) >> 12) {
                crate::jit::jit_dirty_cache(low, high);
            }
        }
        let delta = if down { (n * size).wrapping_neg() } else { n * size };
        src = src.wrapping_add(delta) & mask(aw);
        dst = dst.wrapping_add(delta) & mask(aw);
        remaining -= n;
        done += n;
        if movs {
            state::write_gpr(6, src, aw);
        }
        state::write_gpr(7, dst, aw);
        state::write_gpr(1, remaining, aw);
    }
    crate::cpu::execution::record_string(crate::cpu::string::StringExecution {
        iterations: done as u32,
        outcome: if remaining != 0 {
            crate::cpu::string::StringOutcome::Repeat
        }
        else {
            crate::cpu::string::StringOutcome::Complete
        },
    });
    Ok(Some(remaining != 0))
}
/// Execute one architectural instruction or restartable REP element. The
/// caller delivers faults and accounts the retirement; this function never
/// recursively executes or yields to another core inside an atomic operation.
pub unsafe fn step() -> Result<(), Fault> {
    let start = state::GuestIp(state::read_rip());
    state::write_previous_rip(start.0);
    super::profile::tick(start.0);
    let mode = state::mode();
    // The first byte's translation is the same fault point as a fresh decode.
    let physical = memory::translate(start.0, super::paging::Access::Execute, false, false)?;
    let slot = (start.0 ^ start.0 >> 10) as usize & (DECODE_CACHE_SIZE - 1);
    if let Some(entry) = &(*(&raw const DECODE_CACHE))[slot] {
        if entry.rip == start.0
            && entry.physical == physical
            && entry.decoded.mode == mode
            && code_unchanged(physical, &entry.decoded)
        {
            let d = entry.decoded;
            let mut family = entry.family;
            let result = dispatch(&d, &mut family);
            if let Some(entry) = &mut (*(&raw mut DECODE_CACHE))[slot] {
                if entry.rip == start.0 {
                    entry.family = family;
                }
            }
            return result;
        }
    }
    let mut page = Some((start.0 >> 12, physical & !4095));
    let d = decode::decode_with(start, mode, |offset| {
        memory::fetch_cached(start.0.wrapping_add(offset as u64), &mut page)
    })
    .map_err(|e| match e {
        DecodeError::Fetch { error, .. } => error,
        DecodeError::TooLong => Fault::gp(),
        _ => Fault::ud(),
    })?;
    let mut family = UNKNOWN;
    let result = dispatch(&d, &mut family);
    if (physical & 4095) + d.length as u64 <= 4096
        && super::physical::plain_ram(physical, d.length as usize)
    {
        (*(&raw mut DECODE_CACHE))[slot] = Some(CachedDecode {
            rip: start.0,
            physical,
            decoded: d,
            family,
        });
    }
    result
}
// The executor that owns a decoded instruction. system/vector decline an
// instruction from its decoded fields alone, so the owner can be cached.
const UNKNOWN: u8 = 0;
const SYSTEM: u8 = 1;
const VECTOR: u8 = 2;
const INTEGER: u8 = 3;
unsafe fn dispatch(d: &Decoded, family: &mut u8) -> Result<(), Fault> {
    // LOCK, and XCHG with memory (implicitly locked), with other cores in workers
    if crate::parallel::active()
        && d.rm_register.is_none()
        && d.modrm.is_some()
        && (d.prefixes.lock || matches!(d.base_opcode(), 0x86 | 0x87))
    {
        return memory::run_locked(|| dispatch_unlocked(d, family));
    }
    dispatch_unlocked(d, family)
}
unsafe fn dispatch_unlocked(d: &Decoded, family: &mut u8) -> Result<(), Fault> {
    match *family {
        SYSTEM => {
            if super::system::execute(d)? {
                return Ok(());
            }
        },
        VECTOR => {
            if super::vector::execute(d)? {
                return Ok(());
            }
        },
        INTEGER => return execute(d),
        _ => {},
    }
    match super::system::execute(d) {
        Ok(false) => {},
        result => {
            *family = SYSTEM;
            return result.map(|_| ());
        },
    }
    match super::vector::execute(d) {
        Ok(false) => {},
        result => {
            *family = VECTOR;
            return result.map(|_| ());
        },
    }
    *family = INTEGER;
    execute(d)
}
/// Decoded instructions keyed by full RIP, physical address and mode. Every
/// hit revalidates the translation and the live code bytes, so a stale entry
/// after SMC, DMA or remapping is only a miss.
struct CachedDecode {
    rip: u64,
    physical: u64,
    decoded: Decoded,
    family: u8,
}
const DECODE_CACHE_SIZE: usize = 1024;
static mut DECODE_CACHE: [Option<CachedDecode>; DECODE_CACHE_SIZE] =
    [const { None }; DECODE_CACHE_SIZE];
unsafe fn code_unchanged(physical: u64, d: &Decoded) -> bool {
    let length = d.length as usize;
    super::physical::plain_ram(physical, length)
        && std::slice::from_raw_parts(crate::cpu::memory::mem8.add(physical as usize), length)
            == &d.bytes[..length]
}
/// Opcodes whose `execute` arm neither reads nor merges the FLAGS value.
fn flag_free(op: u32, group: u8) -> bool {
    matches!(op, 0x88..=0x8B | 0x8D | 0xB0..=0xBF | 0xC6 | 0xC7 | 0xA0..=0xA3 | 0x63
        | 0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF | 0x86 | 0x87 | 0x90..=0x97 | 0x50..=0x5F | 0x68 | 0x6A
        | 0x8F | 0xC8 | 0xC9 | 0xE8 | 0xE9 | 0xEB | 0xC2 | 0xC3 | 0x98 | 0x99 | 0x0FC8..=0x0FCF
        | 0x0F0D | 0x0F18..=0x0F1F | 0x0FC3 | 0x0F38F0 | 0x0F38F1)
        || op == 0xFF && matches!(group, 2 | 4 | 6)
}
pub unsafe fn execute(d: &Decoded) -> Result<(), Fault> {
    if !d.mode.is_long() {
        return Err(Fault::ud());
    }
    let op = d.base_opcode();
    let w = d.operand_size;
    let rex = d.prefixes.rex.is_some();
    let group = d.modrm.map_or(0, |m| m >> 3 & 7);
    let imm = d.immediate.map_or(0, |i| i.value);
    // Materializing lazy FLAGS is skipped for arms that never read them.
    let flags = if flag_free(op, group) { 0 } else { state::read_flags64() };
    let mut next = d.next.0;
    match op {
        // Cache hints never access the hinted data and do not raise a page
        // fault even for unmapped or noncanonical addresses.
        0x0F0D | 0x0F18 => {},
        0x0FC3 => {
            if w == 16 || d.address.is_none() {
                return Err(Fault::ud());
            }
            let (addr, stack) = address(d);
            memory::write(addr, w, state::read_gpr(d.reg.unwrap() as usize), stack)?;
        },
        0x00..=0x3D if op & 7 <= 5 => {
            let aluop = (op >> 3) as u8;
            let width = if op & 1 == 0 { 8 } else { w };
            let form = op & 7;
            let (a, b) = if form <= 1 {
                (
                    rm(d, width, aluop != 7)?,
                    register(d.reg.unwrap(), width, rex),
                )
            }
            else if form <= 3 {
                (register(d.reg.unwrap(), width, rex), rm(d, width, false)?)
            }
            else {
                (register(0, width, rex), imm)
            };
            let (r, f) = alu(aluop, a, b, width, flags);
            if aluop != 7 {
                if form <= 1 {
                    put_rm(d, width, r)?;
                }
                else {
                    set_register(if form <= 3 { d.reg.unwrap() } else { 0 }, r, width, rex);
                }
            }
            state::write_flags64(f);
        },
        0x80 | 0x81 | 0x83 => {
            let width = if op == 0x80 { 8 } else { w };
            let a = rm(d, width, group != 7)?;
            let (r, f) = alu(group, a, imm, width, flags);
            if group != 7 {
                put_rm(d, width, r)?;
            }
            state::write_flags64(f);
        },
        0x84 | 0x85 | 0xA8 | 0xA9 => {
            let width = if op & 1 == 0 { 8 } else { w };
            let (a, b) = if op < 0xA0 {
                (rm(d, width, false)?, register(d.reg.unwrap(), width, rex))
            }
            else {
                (register(0, width, rex), imm)
            };
            state::write_flags64(alu(4, a, b, width, flags).1);
        },
        0x88..=0x8B => {
            let width = if op & 1 == 0 { 8 } else { w };
            if op & 2 == 0 {
                put_rm(d, width, register(d.reg.unwrap(), width, rex))?;
            }
            else {
                let v = rm(d, width, false)?;
                set_register(d.reg.unwrap(), v, width, rex);
            }
        },
        0x8D => {
            if d.address.is_none() {
                return Err(Fault::ud());
            }
            let mut regs = [0; 16];
            for i in 0..16 {
                regs[i] = state::read_gpr(i);
            }
            set_register(
                d.reg.unwrap(),
                d.address.unwrap().offset(&regs, d.next),
                w,
                rex,
            );
        },
        0xB0..=0xBF => set_register(
            d.opcode_register.unwrap(),
            imm,
            if op < 0xB8 { 8 } else { w },
            rex,
        ),
        0xC6 | 0xC7 => put_rm(d, if op == 0xC6 { 8 } else { w }, imm)?,
        0xA0..=0xA3 => {
            let width = if op & 1 == 0 { 8 } else { w };
            let seg = d.prefixes.segment.unwrap_or(3);
            let a =
                imm.wrapping_add(if seg >= 4 { state::read_segment_base(seg as usize) } else { 0 });
            if op & 2 == 0 {
                let v = memory::read(a, width, false)?;
                set_register(0, v, width, rex);
            }
            else {
                memory::write(a, width, register(0, width, rex), false)?;
            }
        },
        0x63 => {
            let sw = if w == 16 { 16 } else { 32 };
            let v = rm(d, sw, false)?;
            set_register(d.reg.unwrap(), signed(v, sw) as u64, w, rex);
        },
        0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF => {
            let sw = if op & 1 == 0 { 8 } else { 16 };
            let v = rm(d, sw, false)?;
            set_register(
                d.reg.unwrap(),
                if op & 8 != 0 { signed(v, sw) as u64 } else { v },
                w,
                rex,
            );
        },
        0x86 | 0x87 => {
            let width = if op == 0x86 { 8 } else { w };
            let a = rm(d, width, true)?;
            let b = register(d.reg.unwrap(), width, rex);
            put_rm(d, width, b)?;
            set_register(d.reg.unwrap(), a, width, rex);
        },
        0x90..=0x97 => {
            let r = d.opcode_register.unwrap();
            // PAUSE (F3 90) is a spin-wait hint: as in the legacy interpreter,
            // end this core's slice so the lock holder can run.
            if r == 0 && d.prefixes.rep == Some(0xF3) && crate::cpu::apic::core_count() > 1 {
                crate::cpu::cpu::yield_to_other_cores();
            }
            if r != 0 {
                let a = register(0, w, rex);
                let b = register(r, w, rex);
                set_register(0, b, w, rex);
                set_register(r, a, w, rex);
            }
        },
        0x50..=0x57 => push(register(d.opcode_register.unwrap(), w, rex), w)?,
        0x58..=0x5F => {
            let v = peek(w)?;
            state::write_gpr(4, state::read_gpr(4).wrapping_add((w / 8) as u64), 64);
            set_register(d.opcode_register.unwrap(), v, w, rex);
        },
        0x68 | 0x6A => push(imm, w)?,
        0x8F => {
            let v = peek(w)?;
            let rsp = state::read_gpr(4).wrapping_add((w / 8) as u64);
            if let Some(r) = d.rm_register {
                state::write_gpr(4, rsp, 64);
                set_register(r, v, w, rex);
            }
            else {
                let (a, s) = address_rsp(d, Some(rsp));
                memory::write(a, w, v, s)?;
                state::write_gpr(4, rsp, 64);
            }
        },
        0x9C => push(flags & !0x30000, w)?,
        0x9D => {
            let v = peek(w)?;
            state::write_gpr(4, state::read_gpr(4).wrapping_add((w / 8) as u64), 64);
            state::write_flags64(popf_flags(flags, v, w, *crate::cpu::global_pointers::cpl));
        },
        0xC8 => {
            let nesting = d.extra_immediate.unwrap_or(0) & 31;
            let old_rsp = state::read_gpr(4);
            let old_rbp = state::read_gpr(5);
            let bytes = (w / 8) as u64;
            let frame = old_rsp.wrapping_sub(bytes);
            let count = if nesting == 0 { 1 } else { nesting as usize + 1 };
            let mut values = [0u64; 32];
            values[0] = old_rbp;
            for i in 0..count {
                memory::probe_write(old_rsp.wrapping_sub(bytes * (i as u64 + 1)), w, true)?;
            }
            for i in 1..nesting as usize {
                values[i] = memory::read(old_rbp.wrapping_sub(bytes * i as u64), w, true)?;
            }
            if nesting != 0 {
                values[nesting as usize] = frame;
            }
            let final_rsp = old_rsp.wrapping_sub(bytes * count as u64).wrapping_sub(imm);
            memory::probe_write(final_rsp, w, true)?;
            for i in 0..count {
                memory::write(
                    old_rsp.wrapping_sub(bytes * (i as u64 + 1)),
                    w,
                    values[i],
                    true,
                )?;
            }
            state::write_gpr(5, frame, w);
            state::write_gpr(4, final_rsp, 64);
        },
        0xC9 => {
            let rsp = state::read_gpr(5);
            let v = memory::read(rsp, w, true)?;
            state::write_gpr(4, rsp.wrapping_add((w / 8) as u64), 64);
            state::write_gpr(5, v, w);
        },
        0xE8 => {
            next = branch(relative(d))?;
            push(d.next.0, 64)?;
        },
        0xE9 | 0xEB => next = branch(relative(d))?,
        0xC2 | 0xC3 => {
            next = branch(peek(64)?)?;
            state::write_gpr(4, state::read_gpr(4).wrapping_add(8 + imm), 64);
        },
        0x70..=0x7F | 0x0F80..=0x0F8F => {
            if condition(op as u8 & 15, flags) {
                next = branch(relative(d))?;
            }
        },
        0xE0..=0xE3 => {
            let old = state::read_gpr(1) & mask(d.address_size);
            let count = old.wrapping_sub(1) & mask(d.address_size);
            let take = match op {
                0xE0 => count != 0 && flags & ZF == 0,
                0xE1 => count != 0 && flags & ZF != 0,
                0xE2 => count != 0,
                _ => old == 0,
            };
            if take {
                next = branch(relative(d))?;
            }
            if op != 0xE3 {
                state::write_gpr(1, count, d.address_size);
            }
        },
        0x0F40..=0x0F4F => {
            let v = rm(d, w, false)?;
            if condition(op as u8 & 15, flags) {
                set_register(d.reg.unwrap(), v, w, rex);
            }
            else if w == 32 {
                // A false 32-bit CMOV still clears the destination's upper
                // half; the source remains faultable regardless of condition.
                let old = register(d.reg.unwrap(), w, rex);
                set_register(d.reg.unwrap(), old, w, rex);
            }
        },
        0x0F90..=0x0F9F => put_rm(d, 8, condition(op as u8 & 15, flags) as u64)?,
        0xC0 | 0xC1 | 0xD0..=0xD3 => {
            let width = if op & 1 == 0 { 8 } else { w };
            let count = if op <= 0xC1 {
                imm as u8
            }
            else if op <= 0xD1 {
                1
            }
            else {
                state::read_gpr(1) as u8
            };
            let a = rm(d, width, true)?;
            let (r, f) = shift(group, a, count, width, flags);
            put_rm(d, width, r)?;
            state::write_flags64(f);
        },
        0xFE | 0xFF if group <= 1 => {
            let width = if op == 0xFE { 8 } else { w };
            let a = rm(d, width, true)?;
            let (r, f) = alu(if group == 0 { 0 } else { 5 }, a, 1, width, flags);
            put_rm(d, width, r)?;
            state::write_flags64(f & !CF | flags & CF);
        },
        0xFF if group == 2 || group == 4 => {
            next = branch(rm(d, 64, false)?)?;
            if group == 2 {
                push(d.next.0, 64)?;
            }
        },
        0xFF if group == 6 => {
            let v = rm(d, w, false)?;
            push(v, w)?;
        },
        0xF6 | 0xF7 => {
            let width = if op == 0xF6 { 8 } else { w };
            let a = rm(d, width, matches!(group, 2 | 3))?;
            match group {
                // F6/F7 /1 is an alias of TEST
                0 | 1 => state::write_flags64(alu(4, a, imm, width, flags).1),
                2 => put_rm(d, width, !a)?,
                3 => {
                    let (r, f) = alu(5, 0, a, width, flags);
                    put_rm(d, width, r)?;
                    state::write_flags64(f);
                },
                4 | 5 => {
                    let lhs = register(0, width, rex);
                    let full = if group == 4 {
                        lhs as u128 * a as u128
                    }
                    else {
                        (signed(lhs, width) * signed(a, width)) as u128
                    };
                    let lo = full as u64 & mask(width);
                    let hi = (full >> width) as u64 & mask(width);
                    let overflow = if group == 4 {
                        hi != 0
                    }
                    else {
                        signed(lo, width) != (signed(lhs, width) * signed(a, width))
                    };
                    if width == 8 {
                        state::write_gpr(0, full as u64, 16);
                    }
                    else {
                        state::write_gpr(0, lo, width);
                        state::write_gpr(2, hi, width);
                    }
                    state::write_flags64(flags & !(CF | OF) | if overflow { CF | OF } else { 0 });
                },
                6 | 7 => {
                    if a == 0 {
                        return Err(Fault::de());
                    }
                    let full = if width == 8 {
                        state::read_gpr(0) & 65535
                    }
                    else {
                        register(0, width, rex) | 0
                    };
                    let dividend = if width == 8 {
                        full as u128
                    }
                    else {
                        full as u128 | ((register(2, width, rex) as u128) << width)
                    };
                    let (q, r) = if group == 6 {
                        let q = dividend / (a as u128);
                        if q > mask(width) as u128 {
                            return Err(Fault::de());
                        }
                        (q as u64, (dividend % (a as u128)) as u64)
                    }
                    else {
                        let bits = width as u32 * 2;
                        let dividend = if bits == 128 {
                            dividend as i128
                        }
                        else {
                            ((dividend << (128 - bits)) as i128) >> (128 - bits)
                        };
                        let divisor = signed(a, width);
                        let q = dividend.checked_div(divisor).ok_or_else(Fault::de)?;
                        if q < -(1i128 << (width - 1)) || q > (1i128 << (width - 1)) - 1 {
                            return Err(Fault::de());
                        }
                        (q as u64, (dividend % divisor) as u64)
                    };
                    if width == 8 {
                        state::write_gpr(0, (q & 255) | ((r & 255) << 8), 16);
                    }
                    else {
                        state::write_gpr(0, q, width);
                        state::write_gpr(2, r, width);
                    }
                },
                _ => return Err(Fault::ud()),
            }
        },
        0x69 | 0x6B | 0x0FAF => {
            let a = rm(d, w, false)?;
            let b = if op == 0x0FAF { register(d.reg.unwrap(), w, rex) } else { imm };
            let full = signed(a, w) * signed(b, w);
            let r = full as u64 & mask(w);
            set_register(d.reg.unwrap(), r, w, rex);
            state::write_flags64(
                flags & !(CF | OF) | if signed(r, w) != full { CF | OF } else { 0 },
            );
        },
        0x98 => {
            let sw = w / 2;
            state::write_gpr(0, signed(state::read_gpr(0), sw) as u64, w);
        },
        0x99 => state::write_gpr(
            2,
            if signed(state::read_gpr(0), w) < 0 { u64::MAX } else { 0 },
            w,
        ),
        0x0FC0 | 0x0FC1 => {
            let width = if op == 0x0FC0 { 8 } else { w };
            let a = rm(d, width, true)?;
            let b = register(d.reg.unwrap(), width, rex);
            let (r, f) = alu(0, a, b, width, flags);
            put_rm(d, width, r)?;
            if d.rm_register != d.reg {
                set_register(d.reg.unwrap(), a, width, rex);
            }
            state::write_flags64(f);
        },
        0x0FB0 | 0x0FB1 => {
            let width = if op == 0x0FB0 { 8 } else { w };
            let old = rm(d, width, true)?;
            let a = register(0, width, rex);
            let (_, f) = alu(7, a, old, width, flags);
            // A failed register compare does not write DEST (and therefore
            // preserves its inaccessible upper half). Memory still gets the
            // mandatory write cycle even when the comparison fails.
            if a == old || d.rm_register.is_none() {
                put_rm(
                    d,
                    width,
                    if a == old { register(d.reg.unwrap(), width, rex) } else { old },
                )?;
            }
            if a != old {
                set_register(0, old, width, rex);
            }
            state::write_flags64(f);
        },
        // XRSTORS, XSAVEC, XSAVES (the decoder required their features)
        0x0FC7 if (3..=5).contains(&group) => crate::x64::vector::compacted_state(d, group)?,
        0x0FC7 if group == 6 => {
            // RDRAND is NFx: an F2/F3 prefix is #UD
            if d.prefixes.rep.is_some() {
                return Err(Fault::ud());
            }
            let r = d.rm_register.ok_or(Fault::ud())?;
            let low = crate::cpu::cpu::js::get_rand_int() as u32 as u64;
            let value = if w == 64 {
                low | (crate::cpu::cpu::js::get_rand_int() as u32 as u64) << 32
            }
            else {
                low
            };
            set_register(r, value, w, rex);
            state::write_flags64(flags & !ARITH | CF);
        },
        0x0FC7 if group == 1 => {
            let (a, s) = address(d);
            if w == 128 {
                if a & 15 != 0 {
                    return Err(Fault::gp());
                }
                memory::probe_write(a, 128, s)?;
                let old = memory::read128(a, s)?;
                let expected = state::read_gpr(0) as u128 | ((state::read_gpr(2) as u128) << 64);
                let equal = old == expected;
                let value = if equal {
                    state::read_gpr(3) as u128 | ((state::read_gpr(1) as u128) << 64)
                }
                else {
                    old
                };
                memory::write128(a, value, s)?;
                if !equal {
                    state::write_gpr(0, old as u64, 64);
                    state::write_gpr(2, (old >> 64) as u64, 64);
                }
                state::write_flags64(flags & !ZF | if equal { ZF } else { 0 });
            }
            else {
                memory::probe_write(a, 64, s)?;
                let old = memory::read(a, 64, s)?;
                let expected =
                    state::read_gpr(0) as u32 as u64 | ((state::read_gpr(2) as u32 as u64) << 32);
                let equal = old == expected;
                let value = if equal {
                    state::read_gpr(3) as u32 as u64 | ((state::read_gpr(1) as u32 as u64) << 32)
                }
                else {
                    old
                };
                memory::write(a, 64, value, s)?;
                if !equal {
                    state::write_gpr(0, old, 32);
                    state::write_gpr(2, old >> 32, 32);
                }
                state::write_flags64(flags & !ZF | if equal { ZF } else { 0 });
            }
        },
        0x0FA3 | 0x0FAB | 0x0FB3 | 0x0FBB | 0x0FBA => {
            let action = if op == 0x0FBA { group - 4 } else { ((op >> 3) & 3) as u8 };
            let index = if op == 0x0FBA { imm } else { register(d.reg.unwrap(), w, rex) };
            let bit = index & (w as u64 - 1);
            let mut memory_address = None;
            let old = if d.rm_register.is_some() {
                rm(d, w, action != 0)?
            }
            else {
                let (a, stack) = address(d);
                let displacement = if op == 0x0FBA {
                    0
                }
                else {
                    (signed(index, w) >> (w.trailing_zeros())) * (w as i128 / 8)
                };
                let a = a.wrapping_add(displacement as u64);
                if action != 0 {
                    memory::probe_write(a, w, stack)?;
                }
                memory_address = Some((a, stack));
                memory::read(a, w, stack)?
            };
            let value = match action {
                0 => old,
                1 => old | (1 << bit),
                2 => old & !(1 << bit),
                3 => old ^ (1 << bit),
                _ => unreachable!(),
            };
            if action != 0 {
                if let Some((a, stack)) = memory_address {
                    memory::write(a, w, value, stack)?;
                }
                else {
                    put_rm(d, w, value)?;
                }
            }
            state::write_flags64(flags & !CF | ((old >> bit) & CF));
        },
        // TZCNT and LZCNT (F3 0F BC/BD: rows of their features; BSF and BSR
        // without): the operand's size for 0, CF
        0x0FBC | 0x0FBD if d.opcode >> 16 == 0xF3 => {
            let v = rm(d, w, false)?;
            let (value, arithmetic) = if op == 0x0FBD {
                crate::cpu::bmi::lzcnt(v, w as u32)
            }
            else {
                crate::cpu::bmi::tzcnt(v, w as u32)
            };
            set_register(d.reg.unwrap(), value, w, rex);
            state::write_flags64(flags & !ARITH | arithmetic as u64);
        },
        0x0FBC | 0x0FBD => {
            let v = rm(d, w, false)?;
            if v == 0 {
                state::write_flags64(flags | ZF);
            }
            else {
                let value = if op == 0x0FBC { v.trailing_zeros() } else { 63 - v.leading_zeros() };
                set_register(d.reg.unwrap(), value as u64, w, rex);
                state::write_flags64(flags & !ZF);
            }
        },
        0x0FB8 if d.opcode == 0xF30FB8 => {
            let v = rm(d, w, false)?;
            set_register(d.reg.unwrap(), v.count_ones() as u64, w, rex);
            state::write_flags64(flags & !ARITH | if v == 0 { ZF } else { 0 });
        },
        // MOVBE (0F 38 F0: load, F1: store; memory only): one access of the
        // operand size, its bytes reversed
        0x0F38F0 if d.opcode == 0x0F38F0 => {
            let v = crate::cpu::bmi::byte_swap(rm(d, w, false)?, w as u32);
            set_register(d.reg.unwrap(), v, w, rex);
        },
        0x0F38F1 if d.opcode == 0x0F38F1 => {
            let v = register(d.reg.unwrap(), w, rex);
            put_rm(d, w, crate::cpu::bmi::byte_swap(v, w as u32))?;
        },
        // CRC32 r32/r64, r/m8 (F2 0F 38 F0) and r/m16/32/64 (F1): the CRC-32C
        // in the low half of the destination, the rest zero; no flags
        0x0F38F0 | 0x0F38F1 if d.opcode >> 24 == 0xF2 => {
            let width = if op == 0x0F38F0 { 8 } else { w };
            let v = rm(d, width, false)?;
            let r = d.reg.unwrap();
            let crc =
                crate::cpu::simd_int::crc32c(register(r, 32, rex) as u32, v, width as u32 / 8);
            set_register(r, crc as u64, 32, rex);
        },
        0x0FA4 | 0x0FA5 | 0x0FAC | 0x0FAD => {
            let count = (if op & 1 == 0 { imm } else { state::read_gpr(1) }) as u8
                & if w == 64 { 63 } else { 31 };
            let a = rm(d, w, true)?;
            let b = register(d.reg.unwrap(), w, rex);
            if count != 0 {
                let count = count % w;
                let left = op & 8 == 0;
                let r = if count == 0 {
                    b
                }
                else if left {
                    (a << count) | (b >> (w - count))
                }
                else {
                    (a >> count) | (b << (w - count))
                };
                let r = r & mask(w);
                let cf = if count == 0 {
                    a & 1 != 0
                }
                else if left {
                    a >> (w - count) & 1 != 0
                }
                else {
                    a >> (count - 1) & 1 != 0
                };
                let mut f = flags & !(CF | SF | ZF | PF) | szp(r, w) | if cf { CF } else { 0 };
                if count == 1 {
                    f = f & !OF | if (a ^ r) >> (w - 1) != 0 { OF } else { 0 };
                }
                put_rm(d, w, r)?;
                state::write_flags64(f);
            }
            else {
                put_rm(d, w, a)?;
            }
        },
        0x0FC8..=0x0FCF => {
            let r = (op as u8 & 7) | d.prefixes.b();
            let v = state::read_gpr(r as usize);
            state::write_gpr(
                r as usize,
                if w == 64 { v.swap_bytes() } else { (v as u32).swap_bytes() as u64 },
                w,
            );
        },
        0x6C..=0x6F | 0xA4..=0xA7 | 0xAA..=0xAF => {
            if string(d, op)? {
                next = d.start.0;
            }
        },
        0xF5 => state::write_flags64(flags ^ CF),
        0xF8 => state::write_flags64(flags & !CF),
        0xF9 => state::write_flags64(flags | CF),
        0xFC => state::write_flags64(flags & !0x400),
        0xFD => state::write_flags64(flags | 0x400),
        0x9E => state::write_flags64(
            flags & !(SF | ZF | AF | PF | CF)
                | (state::read_high_byte(0) as u64) & (SF | ZF | AF | PF | CF),
        ),
        0x9F => state::write_high_byte(0, (flags as u8 & 0xD5) | 2),
        // hint space 0F19-0F1F: reserved NOPs without the matching extension
        0x0F19..=0x0F1F => {},
        0xD7 => {
            // XLAT: AL = [seg:rBX + AL]
            let seg = d.prefixes.segment.unwrap_or(3);
            let offset =
                state::read_gpr(3).wrapping_add(state::read_gpr(0) & 0xFF) & mask(d.address_size);
            let base = if seg >= 4 { state::read_segment_base(seg as usize) } else { 0 };
            let v = memory::read(offset.wrapping_add(base), 8, seg == 2)?;
            set_register(0, v, 8, false);
        },
        0x0FB9 | 0x0FFF => return Err(Fault::ud()),
        _ => return Err(Fault::ud()),
    }
    state::write_rip(next);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn alu_width_boundaries() {
        for w in [8, 16, 32, 64] {
            let m = mask(w);
            let sign = 1u64 << (w - 1);
            assert_eq!(alu(0, m, 1, w, 0).0, 0);
            assert_eq!(alu(0, m, 1, w, 0).1 & (CF | ZF), CF | ZF);
            assert_ne!(alu(0, sign - 1, 1, w, 0).1 & OF, 0);
            assert_ne!(alu(5, sign, 1, w, 0).1 & OF, 0);
            assert_eq!(alu(2, m, 0, w, CF).0, 0);
            assert_ne!(alu(3, 0, m, w, CF).1 & CF, 0);
            assert_eq!(alu(6, m, m, w, u64::MAX).1 & ARITH, ZF | PF);
        }
    }
    #[test]
    fn byte_alu_exhaustive() {
        for a in 0..256 {
            for b in 0..256 {
                for carry in 0..2 {
                    for op in [0, 2, 3, 5, 7] {
                        let (r, f) = alu(op, a, b, 8, carry);
                        let c = if op == 2 || op == 3 { carry as i32 } else { 0 };
                        let exact = if op == 0 || op == 2 {
                            a as i32 + b as i32 + c
                        }
                        else {
                            a as i32 - b as i32 - c
                        };
                        let signed_exact = if op == 0 || op == 2 {
                            a as i8 as i32 + b as i8 as i32 + c
                        }
                        else {
                            a as i8 as i32 - b as i8 as i32 - c
                        };
                        assert_eq!(r, exact as u8 as u64);
                        assert_eq!(f & CF != 0, exact < 0 || exact > 255);
                        assert_eq!(f & OF != 0, !(-128..=127).contains(&signed_exact));
                    }
                }
            }
        }
    }
    #[test]
    fn shifts_counts_and_sign() {
        for w in [8, 16, 32, 64] {
            for count in 0..=255 {
                for op in 0..8 {
                    let (r, f) = shift(op, mask(w), count, w, 0x8D5);
                    assert_eq!(r & !mask(w), 0);
                    if count & (if w == 64 { 63 } else { 31 }) == 0 {
                        assert_eq!(r, mask(w));
                        assert_eq!(f, 0x8D5);
                    }
                }
            }
            assert_eq!(
                shift(7, 1 << (w - 1), 1, w, 0).0,
                (1 << (w - 1)) | (1 << (w - 2))
            );
        }
    }
    #[test]
    fn popf_privilege_masks_and_full_width_rotate_carry() {
        assert_eq!(shift(0, 0x98, 8, 8, CF).1 & CF, 0);
        assert_eq!(shift(1, 0x80, 8, 8, 0).1 & CF, CF);
        assert_eq!(shift(2, 0x98, 9, 8, CF).1 & CF, CF);
        let old = 0x1B0202;
        assert_eq!(popf_flags(old, 0, 64, 3) & 0x1B3200, old & 0x1B3200);
        assert_eq!(popf_flags(0x3202, 0, 64, 0) & 0x3200, 0);
        assert_ne!(popf_flags(2, 0x102, 64, 3) & 0x100, 0);
        assert_eq!(popf_flags(0x240002, 0, 16, 0) & !65535, 0x240000);
    }
}
