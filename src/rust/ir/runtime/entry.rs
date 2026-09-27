//! The compile-time assumptions of a cold CPU entry, separate from physical code dependencies.
use crate::cpu::{cpu, global_pointers as gp};
use crate::ir::frontend::decode::{GuestEip, LinearAddress};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CpuEntryKey {
    pub pc: GuestEip,
    pub linear: LinearAddress,
    pub default_32: bool,
}
impl CpuEntryKey {
    pub fn cs_base(self) -> u32 { self.linear.0.wrapping_sub(self.pc.0) }
}

/// A standalone artifact cannot be admitted as a CPU entry (or vice versa).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryContract {
    Standalone,
    Cpu(CpuEntryKey),
}

// Normal edges and audited, committed observer exits can request a successor.
// Fault, invalidation and budget exits never authorize unchecked continuation.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ExitKind {
    None = 0,
    Normal = 1,
    Observer = 2,
    Poll = 3,
}
static mut EXIT_KIND: ExitKind = ExitKind::None;
/// Where generated code may store an ExitKind byte itself instead of calling
/// ir_request_link/ir_request_poll_exit: only code generated in the running
/// Wasm instance (natively generated fixtures must call the imports).
pub fn exit_kind_address() -> Option<u32> {
    if cfg!(target_arch = "wasm32") { Some(std::ptr::addr_of!(EXIT_KIND) as u32) } else { None }
}
// A byte-validation certificate is valid only in a synchronous CPU interval
// without unobserved host writes. No certificate survives a new CPU batch,
// interpretation, an observing import, or code/reset invalidation. Saturation
// disables reuse permanently rather than allowing an ABA through wraparound.
static mut ADMISSION_EPOCH: u64 = 1;
// Fused continuation also stops on known code writes, while unrelated entry
// byte certificates survive: dirty_page retires every affected physical owner.
static mut CONTINUATION_EPOCH: u64 = 1;
pub(super) fn code_write_barrier() {
    unsafe {
        CONTINUATION_EPOCH = CONTINUATION_EPOCH.saturating_add(1);
    }
}
#[no_mangle]
pub fn ir_admission_barrier() {
    unsafe {
        ADMISSION_EPOCH = ADMISSION_EPOCH.saturating_add(1);
    }
    code_write_barrier();
}
/// Fused artifacts read this non-shared CPU-owned epoch at recovery polls. Any
/// observer revokes continuation before entering another guest instruction.
#[no_mangle]
pub fn ir_admission_epoch_address() -> u32 { core::ptr::addr_of!(CONTINUATION_EPOCH) as u32 }
/// Advances on every known code write and admission barrier.
pub(crate) fn continuation_epoch() -> u64 { unsafe { CONTINUATION_EPOCH } }
pub(super) fn admission_epoch() -> u64 { unsafe { ADMISSION_EPOCH } }
pub(super) fn link_requested() -> bool {
    unsafe { matches!(EXIT_KIND, ExitKind::Normal | ExitKind::Observer) }
}
pub(super) fn profile_link_requested() -> bool { unsafe { EXIT_KIND == ExitKind::Normal } }
pub(super) fn poll_exit() -> bool { unsafe { EXIT_KIND == ExitKind::Poll } }
#[no_mangle]
pub unsafe fn ir_request_link() { EXIT_KIND = ExitKind::Normal; }
/// This successor starts from fully committed CPU state after an observer.
/// It is not a normal SSA edge and must not seed a fusion prediction.
#[no_mangle]
pub unsafe fn ir_request_observer_link() { EXIT_KIND = ExitKind::Observer; }
/// A recovered budget/epoch poll has no hidden observer of its own. This is NOT
/// a successor request: control returns to the original CPU dispatcher and its
/// batch/IRQ limits. Earlier barriers remain authoritative; no epoch is refreshed.
#[no_mangle]
pub unsafe fn ir_request_poll_exit() { EXIT_KIND = ExitKind::Poll; }
pub unsafe fn take_link_request() -> bool {
    let requested = matches!(EXIT_KIND, ExitKind::Normal | ExitKind::Observer);
    EXIT_KIND = ExitKind::None;
    requested
}

/// No state writes, memory translation, lazy-FLAGS evaluation or exception delivery.
/// This guard does NOT validate code versions or grant permission to call a stale slot.
#[no_mangle]
pub unsafe fn ir_entry_matches(linear: u32, cs_base: u32, default_32: u32) -> bool {
    matches_current(linear, cs_base, default_32)
}
// The generated module still calls the guarded ABI above. Internal admission
// can inline this exact predicate instead of crossing a second Wasm call.
#[inline(always)]
pub(super) unsafe fn matches_current(linear: u32, cs_base: u32, default_32: u32) -> bool {
    *gp::prefixes == 0
        && !*gp::in_hlt
        && *gp::instruction_pointer as u32 == linear
        && cpu::get_seg_cs() as u32 == cs_base
        && u32::from(*gp::is_32) == default_32
}
