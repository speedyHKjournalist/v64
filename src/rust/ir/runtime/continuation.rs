//! CPU observer continuation contracts. A raw host write need not change an
//! epoch: successful continuation also verifies the active immutable code owner.
use crate::cpu::global_pointers as gp;
use crate::ir::helper::Outcome;

#[derive(PartialEq, Eq)]
pub(super) struct ContinuationContext {
    pub(super) epoch: u64,
    pc: i32,
    previous_pc: i32,
    count: u32,
    controls: [i32; 5],
    mode: [u32; 8],
    segments: [(u16, i32, u32, u8, bool); 8],
    descriptors: [i32; 5],
}
impl ContinuationContext {
    pub(super) unsafe fn capture() -> Self {
        Self {
            epoch: super::live::continuation_epoch(),
            pc: *gp::instruction_pointer,
            previous_pc: *gp::previous_ip,
            count: *gp::instruction_counter,
            controls: std::array::from_fn(|i| *gp::cr.add(i)),
            mode: [
                *gp::protected_mode as u32,
                *gp::is_32 as u32,
                *gp::stack_size_32 as u32,
                *gp::cpl as u32,
                *gp::in_hlt as u32,
                *gp::prefixes as u32,
                (*gp::state_flags).to_u32(),
                (*gp::flags as u32) & !0x8D5, // all non-arithmetic FLAGS affect continuation policy
            ],
            descriptors: [
                *gp::gdtr_offset,
                *gp::gdtr_size,
                *gp::idtr_offset,
                *gp::idtr_size,
                *gp::tss_size_32 as i32,
            ],
            segments: std::array::from_fn(|i| {
                (
                    *gp::sreg.add(i),
                    *gp::segment_offsets.add(i),
                    *gp::segment_limits.add(i),
                    *gp::segment_access_bytes.add(i),
                    *gp::segment_is_null.add(i),
                )
            }),
        }
    }
    /// Compare authoritative backing directly. Building a second full context
    /// first copies every segment/control array and introduces generic memcmp
    /// calls on each port or clock observer, although no second snapshot lives
    /// beyond this check. Keep exactly the same field set and FLAGS mask.
    pub(super) unsafe fn matches_current(&self) -> bool {
        self.epoch == super::live::continuation_epoch()
            && self.pc == *gp::instruction_pointer
            && self.previous_pc == *gp::previous_ip
            && self.count == *gp::instruction_counter
            && self
                .controls
                .iter()
                .enumerate()
                .all(|(i, value)| *value == *gp::cr.add(i))
            && self.mode[0] == *gp::protected_mode as u32
            && self.mode[1] == *gp::is_32 as u32
            && self.mode[2] == *gp::stack_size_32 as u32
            && self.mode[3] == *gp::cpl as u32
            && self.mode[4] == *gp::in_hlt as u32
            && self.mode[5] == *gp::prefixes as u32
            && self.mode[6] == (*gp::state_flags).to_u32()
            && self.mode[7] == (*gp::flags as u32) & !0x8D5
            && self.descriptors[0] == *gp::gdtr_offset
            && self.descriptors[1] == *gp::gdtr_size
            && self.descriptors[2] == *gp::idtr_offset
            && self.descriptors[3] == *gp::idtr_size
            && self.descriptors[4] == *gp::tss_size_32 as i32
            && self.segments.iter().enumerate().all(|(i, segment)| {
                segment.0 == *gp::sreg.add(i)
                    && segment.1 == *gp::segment_offsets.add(i)
                    && segment.2 == *gp::segment_limits.add(i)
                    && segment.3 == *gp::segment_access_bytes.add(i)
                    && segment.4 == *gp::segment_is_null.add(i)
            })
    }
}

/// Scalar reloads intentionally avoid requiring Wasm SIMD for integer code.
/// XMM backing must survive the observer unchanged before those SSA values may
/// be retained. GPRs and arithmetic FLAGS instead receive new SSA definitions.
struct ScalarSnapshot {
    context: ContinuationContext,
    xmm: [u32; 32],
}
pub(super) struct ScalarObserver(Option<ScalarSnapshot>);
impl ScalarObserver {
    pub(super) unsafe fn capture() -> Self {
        // Declining before the callback is always safe: completion still owns
        // post-state even if the callback clears the pending request. Avoid
        // copying state when we already know this activation will return cold.
        Self(no_pending_irq().then(|| ScalarSnapshot {
            context: ContinuationContext::capture(),
            xmm: std::array::from_fn(|i| *(gp::reg_xmm as *const u32).add(i)),
        }))
    }
    pub(super) unsafe fn finish(self) -> u32 {
        let current = self.0.is_some_and(|snapshot| {
            no_pending_irq()
                && snapshot.context.epoch != u64::MAX
                && snapshot.context.matches_current()
                && super::snapshot::same_bytes(
                    std::slice::from_raw_parts(snapshot.xmm.as_ptr().cast(), 128),
                    std::slice::from_raw_parts(gp::reg_xmm.cast(), 128),
                )
                && super::cache::observer_continuation()
        });
        if current {
            Outcome::Normal as u32
        }
        else {
            // Completion has happened. A failed certificate returns CPU-owned
            // post-state and retires exactly once, never replays the observer.
            *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
            Outcome::Invalidated as u32
        }
    }
}
/// Release observer under the notified code-validity contract. A device or
/// clock callback cannot change CPU mode, descriptor or XMM state: a reset
/// rewrites EIP, CR0 and the instruction counter, and every notified code write
/// (DMA through write_blob, jit_dirty_cache) or reset advances the live
/// continuation epoch, which retires any dependent owner. Strict validation,
/// diagnostics and debug builds keep the complete ScalarObserver certificate.
pub(super) struct NotifiedObserver {
    quiet: bool,
    epoch: u64,
    pc: i32,
    previous_pc: i32,
    count: u32,
    cr0: i32,
}
impl NotifiedObserver {
    #[inline(always)]
    pub(super) unsafe fn enabled() -> bool {
        !cfg!(debug_assertions)
            && !super::cache::strict_validation()
            && !super::diagnostics::enabled()
    }
    #[inline(always)]
    pub(super) unsafe fn capture() -> Self {
        Self {
            quiet: no_pending_irq(),
            epoch: super::live::continuation_epoch(),
            pc: *gp::instruction_pointer,
            previous_pc: *gp::previous_ip,
            count: *gp::instruction_counter,
            cr0: *gp::cr,
        }
    }
    #[inline(always)]
    pub(super) unsafe fn finish(self) -> u32 {
        if self.quiet
            && no_pending_irq()
            && self.epoch != u64::MAX
            && self.epoch == super::live::continuation_epoch()
            && self.pc == *gp::instruction_pointer
            && self.previous_pc == *gp::previous_ip
            && self.count == *gp::instruction_counter
            && self.cr0 == *gp::cr
        {
            Outcome::Normal as u32
        }
        else {
            *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
            Outcome::Invalidated as u32
        }
    }
}
/// No controller can currently acknowledge a request. Do not consult backed
/// FLAGS here: STI's emitter may still carry IF in SSA. A masked request remains
/// in IRR; an observer which unmasks it is checked again after completion.
pub(super) unsafe fn no_pending_irq() -> bool {
    !*gp::in_hlt
        && !crate::cpu::cpu::core_yield
        && !crate::cpu::apic::has_core_events()
        && !crate::cpu::apic::apic_core_nmi_pending(crate::cpu::apic::current_core() as u32)
        && !crate::cpu::apic::routed_pic_pending(crate::cpu::apic::current_core() as u32)
        && (!*gp::acpi_enabled || !crate::cpu::apic::has_pending_irq())
}
