use super::*;
use std::collections::BTreeMap;

fn snapshot(linear: u32, length: usize) -> ImmutableCodeSnapshot {
    let mut source = ImmutableCodeSnapshot {
        bytes: Vec::new(),
        dependencies: Vec::new(),
        mappings: Vec::new(),
    };
    for offset in 0..length {
        let address = linear.wrapping_add(offset as u32);
        let page = address & !4095;
        // Deliberate aliases above the first 4 MiB exercise distinct logical
        // mapping obligations even when the physical bytes happen to coincide.
        let physical = page & 0x3FFFFF;
        if source.mappings.last().is_none_or(|m| m.linear.0 != page) {
            source.mappings.push(CodeMapping {
                linear: LinearAddress(page),
                physical: PhysicalAddress(physical),
            });
        }
        source
            .bytes
            .push((physical.wrapping_add(address & 4095).wrapping_mul(173) + 11) as u8);
    }
    source
}

fn obligations(sources: &[(u32, &ImmutableCodeSnapshot)]) -> BTreeMap<(u32, u32), u8> {
    let mut result = BTreeMap::new();
    for &(linear, source) in sources {
        for (offset, byte) in source.bytes.iter().copied().enumerate() {
            let address = linear.wrapping_add(offset as u32);
            let mapping = source
                .mappings
                .iter()
                .find(|m| m.linear.0 == address & !4095)
                .unwrap();
            let physical = mapping.physical.0 + (address & 4095);
            if let Some(old) = result.insert((address, physical), byte) {
                assert_eq!(old, byte);
            }
        }
    }
    result
}

fn check_union(sources: &[(u32, &ImmutableCodeSnapshot)]) {
    let merged = MergedValidation::build(sources.iter().copied()).unwrap();
    let expected = obligations(sources);
    let mut actual = BTreeMap::new();
    for span in &merged.spans {
        assert!(!span.bytes.is_empty());
        assert!(span.bytes.len() <= 4096 - (span.linear & 4095) as usize);
        for (offset, byte) in span.bytes.iter().copied().enumerate() {
            assert!(actual
                .insert(
                    (span.linear + offset as u32, span.physical + offset as u32),
                    byte
                )
                .is_none());
        }
    }
    assert_eq!(actual, expected);
    let mut mappings = BTreeMap::new();
    for (_, source) in sources {
        for mapping in &source.mappings {
            mappings.insert(mapping.linear.0, mapping.physical.0);
        }
    }
    assert_eq!(merged.mappings.len(), mappings.len());
    for mapping in &merged.mappings {
        assert_eq!(mappings[&mapping.linear.0], mapping.physical.0);
    }
    let mut memory = BTreeMap::new();
    for (&(_, physical), &byte) in &expected {
        assert!(memory.insert(physical, byte).is_none_or(|old| old == byte));
    }
    // Independent reference follows every source's original logical mapping
    // and byte order, rather than reading the spans it is meant to check.
    let original_matches = |memory: &BTreeMap<u32, u8>, mappings: &BTreeMap<u32, u32>| {
        sources.iter().all(|&(linear, source)| {
            source
                .mappings
                .iter()
                .all(|m| mappings.get(&m.linear.0) == Some(&m.physical.0))
                && source.bytes.iter().enumerate().all(|(offset, byte)| {
                    let address = linear.wrapping_add(offset as u32);
                    memory.get(&(mappings[&(address & !4095)] + (address & 4095))) == Some(byte)
                })
        })
    };
    let merged_matches = |memory: &BTreeMap<u32, u8>, mappings: &BTreeMap<u32, u32>| {
        merged
            .mappings
            .iter()
            .all(|m| mappings.get(&m.linear.0) == Some(&m.physical.0))
            && merged.spans.iter().all(|span| {
                let current: Vec<_> = (0..span.bytes.len())
                    .map(|offset| memory[&(span.physical + offset as u32)])
                    .collect();
                same_bytes(&current, &span.bytes)
            })
    };
    assert!(original_matches(&memory, &mappings));
    assert!(merged_matches(&memory, &mappings));
    let count: usize = sources.iter().map(|(_, source)| source.bytes.len()).sum();
    assert_eq!(merged.saved_bytes as usize, count - actual.len());
    // Every individual physical-byte mutation must be rejected by both the
    // source-by-source oracle and the merged comparison, including alias bytes.
    for changed in memory.keys().copied().collect::<Vec<_>>() {
        *memory.get_mut(&changed).unwrap() ^= 1;
        let reference = original_matches(&memory, &mappings);
        let fast = merged_matches(&memory, &mappings);
        assert_eq!(fast, reference);
        assert!(!fast);
        *memory.get_mut(&changed).unwrap() ^= 1;
    }
    // Both removing a visible translation and remapping to another physical
    // page must reject, including an alias whose physical bytes are covered.
    for logical in mappings.keys().copied().collect::<Vec<_>>() {
        let physical = mappings.remove(&logical).unwrap();
        assert!(!original_matches(&memory, &mappings));
        assert!(!merged_matches(&memory, &mappings));
        mappings.insert(logical, physical ^ 4096);
        assert!(!original_matches(&memory, &mappings));
        assert!(!merged_matches(&memory, &mappings));
        mappings.insert(logical, physical);
    }
}

#[test]
fn merged_validation_exact_union_crosses_pages_wraps_and_aliases() {
    for start in [0x1000, 0x1001, 0x1FC0, 0x1FFF, 0xFFFF_FFC0, 0xFFFF_FFFF] {
        for length in [8, 17, 65, 128] {
            let root = snapshot(start, length);
            let other_start = start.wrapping_add(length as u32 / 2);
            let peer = snapshot(other_start, length);
            check_union(&[(start, &root), (other_start, &peer)]);
            let contained = snapshot(start.wrapping_add(1), length - 2);
            check_union(&[
                (other_start, &peer),
                (start, &root),
                (start.wrapping_add(1), &contained),
            ]);
            let shorter = snapshot(start, length - 1);
            check_union(&[(start, &shorter), (start, &root)]);
        }
    }
    let root = snapshot(0x1020, 128);
    let peer = snapshot(0x1040, 128);
    let alias = snapshot(0x401020, 128);
    check_union(&[(0x1020, &root), (0x1040, &peer), (0x401020, &alias)]);
}

#[test]
fn merged_validation_rejects_conflicts_invalid_shape_and_no_savings() {
    let root = snapshot(0x1000, 128);
    let peer = snapshot(0x1020, 128);
    assert!(MergedValidation::build([(0x1000, &root)]).is_none());
    let disjoint = snapshot(0x1080, 128);
    assert!(MergedValidation::build([(0x1000, &root), (0x1080, &disjoint)]).is_none());
    for mutation in 0..6 {
        let mut bad = peer.clone();
        match mutation {
            0 => bad.bytes[0] ^= 1,
            1 => bad.mappings[0].physical.0 += 4096,
            2 => bad.mappings[0].physical.0 += 1,
            3 => bad.mappings[0].linear.0 += 4096,
            4 => bad.mappings.clear(),
            _ => bad.mappings.push(bad.mappings[0]),
        }
        assert!(
            MergedValidation::build([(0x1000, &root), (0x1020, &bad)]).is_none(),
            "mutation={mutation}"
        );
    }
    let empty = snapshot(0x1000, 0);
    let large = snapshot(0x1000, 1921);
    assert!(MergedValidation::build([(0x1000, &root), (0x1000, &empty)]).is_none());
    assert!(MergedValidation::build([(0x1000, &root), (0x1000, &large)]).is_none());
    assert!(MergedValidation::build([(0x1000, &root); 5]).is_none());
}
