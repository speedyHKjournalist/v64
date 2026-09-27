//! CPUID topology for one package, one thread per core, contiguous APIC IDs.
//!
//! The one-core machine keeps the historic v86 CPUID profile byte-for-byte.
//! Machines with 2..=8 cores use the `smp32` profile: leaf 0 advertises 1FH,
//! 0BH/1FH enumerate SMT and core domains, and deterministic cache topology
//! agrees with the package. This describes topology, not x2APIC support.
//! Intel SDM Vol. 2, CPUID leaves 01H, 04H, 0BH, and 1FH.

/// Apply topology fields to legacy CPUID output, ordered EAX/EBX/ECX/EDX.
/// The caller must pass the original input ECX as `subleaf`.
pub fn apply(leaf: u32, subleaf: u32, cores: u32, core_id: u32, regs: &mut [u32; 4]) {
    debug_assert!((1..=8).contains(&cores));
    debug_assert!(core_id < cores);
    if cores == 1 {
        return;
    }
    match leaf {
        0 => regs[0] = regs[0].max(0x1F),
        1 => {
            regs[1] = (regs[1] & 0xFFFF) | (cores << 16) | (core_id << 24);
            // HTT qualifies the package logical-processor count. It does not
            // claim SMT siblings when the SMT domain's count is one.
            regs[3] |= 1 << 28;
        },
        4 => {
            if regs[0] & 0x1F != 0 {
                // Keep existing cache geometry. L1 data/instruction caches
                // are private; the unified L2 is shared by the package.
                let level = (regs[0] >> 5) & 7;
                let sharing = if level == 1 { 1 } else { cores };
                regs[0] = (regs[0] & 0x3FFF) | ((sharing - 1) << 14) | ((cores - 1) << 26);
            }
        },
        0xB | 0x1F => {
            let (shift, count, kind) = match subleaf {
                0 => (0, 1, 1), // SMT: one logical processor per core
                1 => (32 - (cores - 1).leading_zeros(), cores, 2),
                _ => (0, 0, 0), // terminal/unsupported level
            };
            *regs = [shift, count, (subleaf & 0xFF) | (kind << 8), core_id];
        },
        _ => {},
    }
}

#[cfg(test)]
mod tests {
    use super::apply;

    #[test]
    fn legacy_single_core_is_unchanged() {
        for leaf in [0, 1, 4, 0xB, 0x1F] {
            let mut regs = [0x16, 0x10203, 0x40506, 0x70809];
            let before = regs;
            apply(leaf, 1, 1, 0, &mut regs);
            assert_eq!(regs, before);
        }
    }

    #[test]
    fn package_shift_rounds_up_for_non_powers_of_two() {
        for (cores, shift) in [(2, 1), (3, 2), (4, 2), (5, 3), (6, 3), (7, 3), (8, 3)] {
            for id in 0..cores {
                for leaf in [0xB, 0x1F] {
                    let mut regs = [0; 4];
                    apply(leaf, 0, cores, id, &mut regs);
                    assert_eq!(regs, [0, 1, 0x100, id]);
                    apply(leaf, 1, cores, id, &mut regs);
                    assert_eq!(regs, [shift, cores, 0x201, id]);
                    apply(leaf, 2, cores, id, &mut regs);
                    assert_eq!(regs, [0, 0, 2, id]);
                    assert_eq!(id >> shift, 0, "all cores belong to package zero");
                }
            }
        }
    }

    #[test]
    fn legacy_package_count_and_cache_domains_agree() {
        let mut regs = [0, 0x10800, 0, 0];
        apply(1, 0, 3, 2, &mut regs);
        assert_eq!(regs[1], 0x02030800);
        assert_eq!(regs[3], 1 << 28);
        let mut l1 = [0x121, 0x1C0003F, 0x3F, 1];
        apply(4, 0, 3, 2, &mut l1);
        assert_eq!(l1[0], 0x08000121);
        let mut l2 = [0x143, 0x5C0003F, 0xFFF, 1];
        apply(4, 2, 3, 2, &mut l2);
        assert_eq!(l2[0], 0x08008143);
        let mut terminal = [0; 4];
        apply(4, 3, 3, 2, &mut terminal);
        assert_eq!(terminal, [0; 4]);
    }
}
