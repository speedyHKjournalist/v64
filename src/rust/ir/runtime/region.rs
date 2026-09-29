//! Tier-aware reachable-CFG source selection for automatic IR compilation.
//!
//! This chooses an immutable contiguous byte snapshot; it never performs guest
//! accesses. Reachability uses the shared decoder so Tier 1 and Tier 2 form
//! regions from the same architectural control-flow facts.
use super::{
    compile::{ImmutableCodeSnapshot, Tier},
    entry::CpuEntryKey,
    snapshot::capture,
};
use crate::ir::frontend::decode::{decode, Flow, GuestEip, LinearAddress};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Policy {
    pub max_bytes: usize,
    pub max_instructions: usize,
}
impl Policy {
    pub fn for_tier(tier: Tier, configured_window: u32) -> Self {
        match tier {
            Tier::One => Self {
                max_bytes: configured_window.clamp(15, 960) as usize,
                max_instructions: unsafe { TIER1_INSTRUCTIONS },
            },
            Tier::Two => Self {
                max_bytes: configured_window.saturating_mul(2).clamp(15, 1920) as usize,
                max_instructions: unsafe { TIER2_INSTRUCTIONS },
            },
        }
    }
}

/// Instruction caps of automatically selected regions (startup policy).
pub(super) static mut TIER1_INSTRUCTIONS: usize = 32;
pub(super) static mut TIER2_INSTRUCTIONS: usize = 96;
#[no_mangle]
pub unsafe fn ir_auto_set_region_instructions(tier1: u32, tier2: u32) -> bool {
    if !(8..=120).contains(&tier1) || !(8..=120).contains(&tier2) {
        return false;
    }
    TIER1_INSTRUCTIONS = tier1 as usize;
    TIER2_INSTRUCTIONS = tier2 as usize;
    true
}
fn target_offset(
    start: GuestEip,
    instruction: &crate::ir::frontend::decode::DecodedInstruction,
    displacement: i32,
) -> usize {
    let target = instruction.next_pc.0.wrapping_add(displacement as u32);
    let target = if instruction.operand_size == 16 { target & 0xFFFF } else { target };
    target.wrapping_sub(start.0) as usize
}

/// Returns the minimal contiguous prefix containing every reachable decoded
/// instruction that fits the policy. Direct targets outside the captured window
/// remain normal region exits.
pub fn reachable_length(
    bytes: &[u8],
    pc: GuestEip,
    linear: LinearAddress,
    default_32: bool,
    policy: Policy,
) -> usize {
    let limit = bytes.len().min(policy.max_bytes);
    if limit == 0 {
        return 0;
    }
    let bytes = &bytes[..limit];
    let mut pending = BTreeSet::from([0usize]);
    let mut visited = BTreeSet::new();
    let mut max_end = 0usize;
    while let Some(at) = pending.pop_first() {
        if at >= bytes.len() || !visited.insert(at) || visited.len() > policy.max_instructions {
            continue;
        }
        let Ok(instruction) = decode(
            &bytes[at..],
            GuestEip(pc.0.wrapping_add(at as u32)),
            LinearAddress(linear.0.wrapping_add(at as u32)),
            default_32,
        )
        else {
            continue;
        };
        let end = at + instruction.length as usize;
        if end > bytes.len() {
            continue;
        }
        max_end = max_end.max(end);
        match instruction.flow {
            // The shared decoder uses Boundary for several ordinary basic-block
            // ends (notably memory forms). The IR frontend owns the semantic
            // stop decision, so keep the fallthrough available unless the
            // shared decoder already identifies a baseline #UD form.
            Flow::Next | Flow::Boundary
                if !instruction.baseline_ud
                    && (!instruction.encoding.block_boundary
                        || matches!(instruction.encoding.opcode, 0x8E | 0xFA | 0x0F20 | 0x0F21 | 0x0F31 | 0x0FA2 | 0xE4..=0xE7 | 0xEC..=0xEF)) =>
            {
                if end < bytes.len() {
                    pending.insert(end);
                }
            },
            Flow::Relative {
                displacement,
                conditional,
                call,
            } => {
                let target = target_offset(pc, &instruction, displacement);
                if call {
                    // A callee inside the window is followed, and its RET is
                    // guarded back to the return site. After a far call, the
                    // return site is reached only from another region.
                    if target < bytes.len() {
                        pending.insert(target);
                        if end < bytes.len() {
                            pending.insert(end);
                        }
                    }
                    continue;
                }
                if target < bytes.len() {
                    pending.insert(target);
                }
                if conditional && end < bytes.len() {
                    pending.insert(end);
                }
            },
            Flow::Sti => {
                if let Ok(span) = crate::ir::frontend::sti::extent(
                    &bytes[at..],
                    instruction.instruction_pc,
                    instruction.linear_pc,
                    default_32,
                ) {
                    max_end = max_end.max(at + span);
                    if at + span < bytes.len() {
                        pending.insert(at + span);
                    }
                }
            },
            Flow::Next | Flow::Boundary | Flow::Stop => {},
        }
    }
    max_end
}

/// Capture a bounded candidate, then shrink it to the reachable CFG prefix.
/// If a cross-page candidate cannot be observed without side effects, retry the
/// current page so a safe Tier-1 region is still possible.
pub unsafe fn capture_region(
    entry: CpuEntryKey,
    tier: Tier,
    configured_window: u32,
) -> Option<ImmutableCodeSnapshot> {
    let policy = Policy::for_tier(tier, configured_window);
    let page_remaining = 4096 - (entry.linear.0 & 4095) as usize;
    let desired = policy.max_bytes;
    let mut snapshot = match capture(entry.linear.0, desired) {
        Ok(snapshot) => snapshot,
        Err(_) if desired > page_remaining => capture(entry.linear.0, page_remaining).ok()?,
        Err(_) => return None,
    };
    let selected = reachable_length(
        &snapshot.bytes,
        entry.pc,
        entry.linear,
        entry.default_32,
        policy,
    );
    if selected == 0 {
        // Keep a bounded failed-input fingerprint for unchanged-failure
        // suppression, matching the scheduler's previous behavior.
        return Some(snapshot);
    }
    if selected == snapshot.bytes.len() {
        return Some(snapshot);
    }
    snapshot = capture(entry.linear.0, selected).ok()?;
    Some(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_forward_edges_loops_and_diamonds() {
        // jmp +2 skips two dead bytes and reaches INC/JMP self.
        let bytes = [0xEB, 0x02, 0xCC, 0xCC, 0x40, 0xEB, 0xFD];
        assert_eq!(
            reachable_length(
                &bytes,
                GuestEip(0x1000),
                LinearAddress(0x2000),
                true,
                Policy {
                    max_bytes: bytes.len(),
                    max_instructions: 32,
                },
            ),
            bytes.len()
        );

        // JZ left; INC; JMP join; DEC; NOP.
        let diamond = [0x74, 0x03, 0x40, 0xEB, 0x01, 0x48, 0x90];
        assert_eq!(
            reachable_length(
                &diamond,
                GuestEip(0x1000),
                LinearAddress(0x2000),
                true,
                Policy {
                    max_bytes: diamond.len(),
                    max_instructions: 32,
                },
            ),
            diamond.len()
        );
    }

    #[test]
    fn boundary_memory_form_keeps_candidate_fallthrough() {
        // MOV EAX,[ESI]; INC EAX. The shared decoder marks the memory form as a
        // block boundary, but the IR CFG frontend can decide whether its
        // precise memory contract permits continuation.
        let bytes = [0x8B, 0x06, 0x40];
        assert_eq!(
            reachable_length(
                &bytes,
                GuestEip(0x1000),
                LinearAddress(0x2000),
                true,
                Policy {
                    max_bytes: bytes.len(),
                    max_instructions: 32,
                },
            ),
            bytes.len()
        );
    }

    #[test]
    fn explicit_semantic_boundary_stops_region_growth() {
        // POP FS is explicitly marked block_boundary by the shared encoding
        // catalogue. Automatic source selection must not speculate past that
        // decoder-owned boundary.
        let bytes = [0x0F, 0xA1, 0x40];
        assert_eq!(
            reachable_length(
                &bytes,
                GuestEip(0x1000),
                LinearAddress(0x2000),
                true,
                Policy {
                    max_bytes: bytes.len(),
                    max_instructions: 32,
                },
            ),
            2
        );
    }

    #[test]
    fn x87_register_continuations_keep_the_automatic_candidate_suffix() {
        for default_32 in [false, true] {
            for opcode in 0xD8..=0xDF {
                for modrm in 0xC0..=0xFF {
                    let bytes = [opcode, modrm, 0x40];
                    assert_eq!(selected_length(&bytes, default_32), bytes.len());
                }
            }
        }
    }

    #[test]
    fn mmx_register_continuations_keep_the_automatic_candidate_suffix() {
        use crate::ir::frontend::mmx::OPERATIONS;
        for default_32 in [false, true] {
            for &(key, _, forms) in OPERATIONS {
                let opcode = key & 0xFFFFFF;
                if forms & 5 == 0 || opcode == 0x0FF7 {
                    continue;
                }
                let mut bytes = Vec::new();
                if opcode > 0xFFFF {
                    bytes.push((opcode >> 16) as u8);
                }
                bytes.extend_from_slice(&[0x0F, opcode as u8]);
                if forms != 4 {
                    let group = if key >> 24 != 0 { key >> 24 } else { 1 };
                    bytes.push((group << 3) as u8 | 0xC0);
                }
                if key >> 24 != 0 || matches!(opcode, 0x0F70 | 0x0FC4 | 0x0FC5) {
                    bytes.push(0);
                }
                bytes.push(0x40);
                assert_eq!(
                    selected_length(&bytes, default_32),
                    bytes.len(),
                    "opcode {opcode:X}, default_32={default_32}"
                );
            }
        }
    }

    fn selected_length(bytes: &[u8], default_32: bool) -> usize {
        reachable_length(
            bytes,
            GuestEip(0x1000),
            LinearAddress(0x2000),
            default_32,
            Policy {
                max_bytes: bytes.len(),
                max_instructions: 32,
            },
        )
    }

    #[test]
    fn read_only_system_helpers_keep_automatic_suffixes() {
        for default_32 in [false, true] {
            for op in [0x20, 0x21] {
                for index in 0..8 {
                    let bytes = [0x0F, op, 0xC0 | index << 3, 0x40];
                    assert_eq!(selected_length(&bytes, default_32), bytes.len());
                }
            }
            assert_eq!(selected_length(&[0x0F, 0xA2, 0x40], default_32), 3);
            for op in [0x22, 0x23] {
                assert_eq!(selected_length(&[0x0F, op, 0xC0, 0x40], default_32), 3);
            }
        }
    }

    #[test]
    fn keeps_external_targets_as_region_exits() {
        let bytes = [0xEB, 0x7F, 0x40, 0x40];
        assert_eq!(
            reachable_length(
                &bytes,
                GuestEip(0x1000),
                LinearAddress(0x2000),
                true,
                Policy {
                    max_bytes: bytes.len(),
                    max_instructions: 32,
                },
            ),
            2
        );
    }

    #[test]
    fn tier_policy_is_bounded_and_distinct() {
        let one = Policy::for_tier(Tier::One, 192);
        let two = Policy::for_tier(Tier::Two, 192);
        assert_eq!(one.max_bytes, 192);
        assert_eq!(one.max_instructions, 32);
        assert_eq!(two.max_bytes, 384);
        assert_eq!(two.max_instructions, 96);
        assert!(two.max_bytes > one.max_bytes);
    }
}
