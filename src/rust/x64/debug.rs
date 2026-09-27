//! Instruction-boundary debug delivery. Pending data matches are scratch:
//! one guest instruction cannot yield or switch cores before `finish`.
use super::{memory::Fault, state};
use crate::cpu::global_pointers as gp;
static mut PENDING: u8 = 0;

fn overlaps(address: u64, size: usize, watched: u64, length: u64) -> bool {
    (0..size).any(|byte| address.wrapping_add(byte as u64).wrapping_sub(watched) < length)
}
pub unsafe fn begin() -> Result<(), Fault> {
    PENDING = 0;
    // RF is kept in the raw FLAGS word; only arithmetic flags are lazy.
    if *gp::interrupt_shadow != 0 || *gp::flags & 0x10000 != 0 { return Ok(()); }
    let control = state::read_dr(7);
    if control & 0xFF == 0 { return Ok(()); }
    let mut matched = 0;
    for index in 0..4 {
        if control >> (index * 2) & 3 != 0 && control >> (16 + index * 4) & 3 == 0
            && state::read_dr(index) == state::read_rip() { matched |= 1 << index; }
    }
    if matched != 0 {
        // Translation faults precede an execution breakpoint on that address.
        super::memory::fetch(state::read_rip())?;
        state::write_dr(6, state::read_dr(6) | matched);
        state::write_dr(7, control & !0x2000);
        state::write_flags64(state::read_flags64() | 0x10000);
        return Err(Fault { vector: 1, error: None, address: None });
    }
    Ok(())
}
pub unsafe fn data(address: u64, size: usize, write: bool) {
    let control = state::read_dr(7);
    if control & 255 == 0 { return; }
    for index in 0..4 {
        if control >> (index * 2) & 3 == 0 { continue; }
        let kind = control >> (16 + index * 4) & 3;
        if kind != 3 && !(kind == 1 && write) { continue; }
        let length = [1, 2, 8, 4][(control >> (18 + index * 4) & 3) as usize];
        // The architectural comparison uses the naturally aligned range.
        let watched = state::read_dr(index) & !(length - 1);
        if overlaps(address, size, watched, length) { PENDING |= 1 << index; }
    }
}
pub unsafe fn io(port: u16, size: usize) {
    if state::read_cr(4) & 8 == 0 { return; }
    let control = state::read_dr(7);
    for index in 0..4 {
        if control >> (index * 2) & 3 == 0 || control >> (16 + index * 4) & 3 != 2 { continue; }
        let length = [1, 2, 8, 4][(control >> (18 + index * 4) & 3) as usize];
        if overlaps(port as u64, size, state::read_dr(index) & !(length - 1), length) { PENDING |= 1 << index; }
    }
}
pub unsafe fn finish(completed: bool, single_step: bool) -> bool {
    let matches = PENDING;
    PENDING = 0;
    if !completed || *gp::interrupt_shadow != 0 || matches == 0 && !single_step { return false; }
    state::write_dr(6, state::read_dr(6) | matches as u64 | if single_step { 1 << 14 } else { 0 });
    state::write_dr(7, state::read_dr(7) & !0x2000);
    true
}
#[cfg(test)]
mod tests {
    use super::overlaps;
    #[test]
    fn byte_ranges_cover_high_addresses_without_low_aliases() {
        assert!(overlaps(0xFFFF800000001FFE, 8, 0xFFFF800000002000, 4));
        assert!(!overlaps(0x1FFE, 8, 0xFFFF800000002000, 4));
        assert!(!overlaps(0x1000, 8, 0x1008, 1));
        assert!(overlaps(u64::MAX, 2, 0, 1));
    }
}
