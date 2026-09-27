//! Bounded side-entry selection. Only a shared body may include cold observed
//! entries; independent fallback modules retain the original heat/byte budget.
use super::{compile::Tier, entry::CpuEntryKey};

pub(super) struct Selection {
    pub shared: Vec<CpuEntryKey>,
    pub fallback: Vec<CpuEntryKey>,
}

pub(super) fn select(
    origin: CpuEntryKey,
    length: usize,
    tier: Tier,
    threshold: u32,
    mut candidates: Vec<(CpuEntryKey, u32)>,
) -> Selection {
    candidates.retain(|(entry, hits)| {
        entry.cs_base() == origin.cs_base()
            && entry.default_32 == origin.default_32
            && entry.linear.0.wrapping_sub(origin.linear.0) > 0
            && (entry.linear.0.wrapping_sub(origin.linear.0) as usize) < length
            && *hits > 0
    });
    candidates.sort_by_key(|(entry, hits)| (std::cmp::Reverse(*hits), entry.linear.0));
    let limit = if tier == Tier::One { 3 } else { 1 };
    let mut bytes = 0;
    let fallback: Vec<_> = candidates
        .iter()
        .filter(|(_, hits)| *hits >= threshold)
        .filter_map(|(entry, _)| {
            let suffix = length - entry.linear.0.wrapping_sub(origin.linear.0) as usize;
            if bytes + suffix > length {
                return None;
            }
            bytes += suffix;
            Some(*entry)
        })
        .take(limit)
        .collect();
    let shared = if tier == Tier::One {
        candidates
            .into_iter()
            .take(limit)
            .map(|(entry, _)| entry)
            .collect()
    }
    else {
        fallback.clone()
    };
    Selection { shared, fallback }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::frontend::decode::{GuestEip, LinearAddress};

    fn key(pc: u32) -> CpuEntryKey {
        CpuEntryKey {
            pc: GuestEip(pc),
            linear: LinearAddress(pc),
            default_32: true,
        }
    }

    #[test]
    fn observed_aliases_share_one_body_but_cannot_amplify_fallback_work() {
        let origin = key(0x1000);
        let entries = vec![
            (key(0x1008), 64),
            (key(0x1010), 63),
            (key(0x1018), 1),
            (key(0x1020), 1),
        ];
        let selected = select(origin, 128, Tier::One, 64, entries.clone());
        assert_eq!(selected.shared, vec![key(0x1008), key(0x1010), key(0x1018)]);
        assert_eq!(selected.fallback, vec![key(0x1008)]);
        let promoted = select(origin, 128, Tier::Two, 64, entries);
        assert_eq!(promoted.shared, promoted.fallback);
        assert_eq!(promoted.shared, vec![key(0x1008)]);
    }

    #[test]
    fn fallback_keeps_hot_suffix_budget_and_full_entry_context() {
        let origin = key(0x1000);
        let mut wrong_cs = key(0x1020);
        wrong_cs.pc = GuestEip(0x20);
        let mut wrong_mode = key(0x1020);
        wrong_mode.default_32 = false;
        let selected = select(
            origin,
            128,
            Tier::One,
            64,
            vec![
                (wrong_cs, 1000),
                (wrong_mode, 1000),
                (key(0x1000), 1000),
                (key(0x1080), 1000),
                (key(0x1020), 0),
                (key(0x1008), 100),
                (key(0x1010), 90),
                (key(0x1018), 80),
                (key(0x1078), 64),
            ],
        );
        assert_eq!(selected.shared, vec![key(0x1008), key(0x1010), key(0x1018)]);
        // A lower-ranked hot suffix may fit even when the shared attempt's
        // other two hot peers exceed the old aggregate input budget.
        assert_eq!(selected.fallback, vec![key(0x1008), key(0x1078)]);
        let wrap = select(key(0xFFFF_FFF0), 32, Tier::One, 64, vec![(key(0), 1)]);
        assert_eq!(wrap.shared, vec![key(0)]);
        assert!(wrap.fallback.is_empty());
    }
}
