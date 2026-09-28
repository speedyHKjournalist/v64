// See Intel's System Programming Guide

use crate::cpu::{cpu::js, global_pointers::acpi_enabled, ioapic, pic};

const APIC_LOG_VERBOSE: bool = false;

// should probably be kept in sync with TSC_RATE in cpu.rs
const APIC_TIMER_FREQ: f64 = 1.0 * 1000.0 * 1000.0;

const APIC_TIMER_MODE_MASK: u32 = 3 << 17;

const APIC_TIMER_MODE_ONE_SHOT: u32 = 0;
const APIC_TIMER_MODE_PERIODIC: u32 = 1 << 17;

const _APIC_TIMER_MODE_TSC: u32 = 2 << 17;

const DELIVERY_MODES: [&str; 8] = [
    "Fixed (0)",
    "Lowest Prio (1)",
    "SMI (2)",
    "Reserved (3)",
    "NMI (4)",
    "INIT (5)",
    "Start-up (6)",
    "ExtINT (7)",
];

const DESTINATION_MODES: [&str; 2] = ["physical", "logical"];

const IOAPIC_CONFIG_MASKED: u32 = 0x10000;

const IOAPIC_DELIVERY_INIT: u8 = 5;
const IOAPIC_DELIVERY_NMI: u8 = 4;
const IOAPIC_DELIVERY_FIXED: u8 = 0;
const DELIVERY_LOWEST_PRIORITY: u8 = 1;
const DELIVERY_STARTUP: u8 = 6;
const DELIVERY_EXTINT: u8 = 7;

const ICR_LEVEL_ASSERT: u32 = 1 << 14;
const APIC_SOFTWARE_ENABLE: u32 = 1 << 8;
const ESR_SEND_ILLEGAL_VECTOR: u32 = 1 << 5;
const ESR_RECEIVE_ILLEGAL_VECTOR: u32 = 1 << 6;
const ESR_ILLEGAL_REGISTER: u32 = 1 << 7;

/// Cores a machine can have; each has its own local APIC
pub const MAX_CORES: usize = 8;

/// Events for the core scheduler in JavaScript (CPU.prototype.run_cores),
/// taken with apic_take_core_events: INIT and a start-up IPI (vector in bits 8..15)
pub const CORE_EVENT_INIT: u32 = 1;
pub const CORE_EVENT_SIPI: u32 = 2;

// keep in sync with cpu.js
#[allow(dead_code)]
const APIC_STRUCT_SIZE: usize = 4 * 46;

// Note: JavaScript (cpu.get_state_apic) depens on this layout
const _: () = assert!(std::mem::offset_of!(Apic, timer_last_tick) == 6 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, lvt_timer) == 8 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, lvt_perf_counter) == 9 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, icr0) == 14 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, icr1) == 15 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, irr) == 16 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, isr) == 24 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, tmr) == 32 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, spurious_vector) == 40 * 4);
const _: () = assert!(std::mem::offset_of!(Apic, lvt_thermal_sensor) == 45 * 4);
const _: () = assert!(std::mem::size_of::<Apic>() == APIC_STRUCT_SIZE);
#[repr(C)]
pub struct Apic {
    apic_id: u32,
    timer_divider: u32,
    timer_divider_shift: u32,
    timer_initial_count: u32,
    timer_current_count: u32,
    timer_last_tick: f64,
    lvt_timer: u32,
    lvt_perf_counter: u32,
    lvt_int0: u32,
    lvt_int1: u32,
    lvt_error: u32,
    tpr: u32,
    icr0: u32,
    icr1: u32,
    irr: [u32; 8],
    isr: [u32; 8],
    tmr: [u32; 8],
    spurious_vector: u32,
    destination_format: u32,
    local_destination: u32,
    error: u32,
    read_error: u32,
    lvt_thermal_sensor: u32,
}

const APIC_RESET: Apic = Apic {
    apic_id: 0,
    timer_divider: 0,
    timer_divider_shift: 1,
    timer_initial_count: 0,
    timer_current_count: 0,
    timer_last_tick: 0.0,
    lvt_timer: IOAPIC_CONFIG_MASKED,
    lvt_thermal_sensor: IOAPIC_CONFIG_MASKED,
    lvt_perf_counter: IOAPIC_CONFIG_MASKED,
    lvt_int0: IOAPIC_CONFIG_MASKED,
    lvt_int1: IOAPIC_CONFIG_MASKED,
    lvt_error: IOAPIC_CONFIG_MASKED,
    tpr: 0,
    icr0: 0,
    icr1: 0,
    irr: [0; 8],
    isr: [0; 8],
    tmr: [0; 8],
    spurious_vector: 0xFF,
    destination_format: !0,
    local_destination: 0,
    error: 0,
    read_error: 0,
};

// One local APIC per core. Only one core runs at a time (cooperative
// multicore: the active core's state is swapped in, see
// CPU.prototype.save_core_state); CURRENT_CORE is the one whose APIC the
// MMIO window, interrupt acceptance and CPUID see.
static mut APICS: [Apic; MAX_CORES] = [APIC_RESET; MAX_CORES];
static mut CURRENT_CORE: usize = 0;
static mut CORE_COUNT: usize = 1;
static mut CORE_EVENTS: [u32; MAX_CORES] = [0; MAX_CORES];
/// NMIs latched for each core until it can take one (nmi_blocked)
static mut NMI_PENDING: [bool; MAX_CORES] = [false; MAX_CORES];

// Keep the legacy 184-byte LAPIC image stable. These additional architectural
// latches are snapshotted separately; they are not scheduler/JIT cache state.
#[repr(C)]
struct ApicAux {
    hardware_enabled: u32,
    extint_pending: u32,
    // An interrupt may be queued while its vector is still in service. Its
    // trigger mode must not overwrite the mode needed by the current EOI.
    pending_tmr: [u32; 8],
    ipi_sent: u32,
    ipi_received: u32,
}
const APIC_AUX_RESET: ApicAux = ApicAux {
    hardware_enabled: 1,
    extint_pending: 0,
    pending_tmr: [0; 8],
    ipi_sent: 0,
    ipi_received: 0,
};
static mut APIC_AUX: [ApicAux; MAX_CORES] = [APIC_AUX_RESET; MAX_CORES];

fn aux_of(core: usize) -> &'static mut ApicAux {
    dbg_assert!(core < MAX_CORES);
    unsafe { &mut *(&raw mut APIC_AUX).cast::<ApicAux>().add(core) }
}

#[no_mangle]
pub fn apic_aux_addr(core: u32) -> u32 { &raw mut *aux_of(core as usize) as u32 }
#[no_mangle]
pub fn apic_aux_size() -> u32 { std::mem::size_of::<ApicAux>() as u32 }
/// Version-6 images contain only the original LAPIC registers. Reconstruct
/// queued trigger modes before the first acknowledge, including level IRQs.
#[no_mangle]
pub fn apic_restore_legacy_aux(core: u32, enabled: bool) {
    let apic = apic_of(core as usize);
    let aux = aux_of(core as usize);
    *aux = APIC_AUX_RESET;
    aux.hardware_enabled = enabled as u32;
    for i in 0..8 {
        aux.pending_tmr[i] = apic.irr[i] & apic.tmr[i];
    }
}

#[no_mangle]
pub fn apic_core_ipi_sent(core: u32) -> u32 { aux_of(core as usize).ipi_sent }
#[no_mangle]
pub fn apic_core_ipi_received(core: u32) -> u32 { aux_of(core as usize).ipi_received }
#[no_mangle]
pub fn apic_core_hardware_enabled(core: u32) -> bool { aux_of(core as usize).hardware_enabled != 0 }
#[no_mangle]
pub fn apic_set_hardware_enabled(core: u32, enabled: bool) {
    aux_of(core as usize).hardware_enabled = enabled as u32;
}
#[no_mangle]
pub fn apic_core_extint_pending(core: u32) -> bool { aux_of(core as usize).extint_pending != 0 }
#[no_mangle]
pub fn apic_restore_extint(core: u32, pending: bool) {
    aux_of(core as usize).extint_pending = pending as u32;
}

fn apic_of(core: usize) -> &'static mut Apic {
    dbg_assert!(core < MAX_CORES);
    unsafe { &mut *(&raw mut APICS).cast::<Apic>().add(core) }
}

pub fn get_apic() -> &'static mut Apic { apic_of(current_core()) }

pub fn current_core() -> usize {
    unsafe { CURRENT_CORE }
}
pub fn core_count() -> usize {
    unsafe { CORE_COUNT }
}

#[no_mangle]
pub fn get_apic_addr() -> u32 { &raw mut *get_apic() as u32 }

/// Address of a core's local APIC (layout: see CPU.prototype.get_state_apic)
#[no_mangle]
pub fn apic_addr(core: u32) -> u32 { &raw mut *apic_of(core as usize) as u32 }

/// Power-on state of all local APICs; core i gets APIC ID i
#[no_mangle]
pub unsafe fn apic_set_core_count(count: u32) {
    dbg_assert!(count >= 1 && count as usize <= MAX_CORES);
    crate::cpu::execution::flush_core_statistics();
    CORE_COUNT = count as usize;
    CURRENT_CORE = 0;
    for core in 0..MAX_CORES {
        *apic_of(core) = APIC_RESET;
        apic_of(core).apic_id = (core as u32) << 24;
        *aux_of(core) = APIC_AUX_RESET;
        if core == 0 {
            // Platform virtual-wire power-on compatibility: the BSP receives
            // the 8259 output through LINT0 until firmware programs/masks it.
            apic_of(core).lvt_int0 = (DELIVERY_EXTINT as u32) << 8;
        }
        CORE_EVENTS[core] = 0;
        NMI_PENDING[core] = false;
    }
}

/// IA32_APIC_BASE.EN cleared: the local APIC returns to its power-on state,
/// including the initial APIC ID (as KVM does when it is enabled again)
pub unsafe fn software_disable() {
    let core = current_core();
    *apic_of(core) = APIC_RESET;
    apic_of(core).apic_id = (core as u32) << 24;
    *aux_of(core) = APIC_AUX_RESET;
    aux_of(core).hardware_enabled = 0;
    NMI_PENDING[core] = false;
    CORE_EVENTS[core] = 0;
}

/// Take a pending NMI of the active core
pub unsafe fn take_nmi() -> bool {
    let pending = NMI_PENDING[current_core()];
    NMI_PENDING[current_core()] = false;
    pending
}

pub unsafe fn nmi_pending() -> bool { NMI_PENDING[current_core()] }

#[no_mangle]
pub unsafe fn apic_core_nmi_pending(core: u32) -> bool { NMI_PENDING[core as usize] }

#[no_mangle]
pub unsafe fn apic_set_current_core(core: u32) {
    dbg_assert!((core as usize) < CORE_COUNT);
    crate::cpu::execution::flush_core_statistics();
    CURRENT_CORE = core as usize;
}

/// INIT: the local APIC returns to its power-on state except for its ID
#[no_mangle]
pub unsafe fn apic_init_core(core: u32) {
    let apic = apic_of(core as usize);
    let apic_id = apic.apic_id;
    *apic = APIC_RESET;
    apic.apic_id = apic_id;
    let aux = aux_of(core as usize);
    aux.hardware_enabled = 1;
    aux.extint_pending = 0;
    aux.pending_tmr = [0; 8];
}

#[no_mangle]
pub unsafe fn apic_take_core_events(core: u32) -> u32 {
    let events = CORE_EVENTS[core as usize];
    CORE_EVENTS[core as usize] = 0;
    events
}

/// Snapshot the pending startup events without acknowledging them.
#[no_mangle]
pub unsafe fn apic_peek_core_events(core: u32) -> u32 { CORE_EVENTS[core as usize] }

pub unsafe fn has_core_events() -> bool { (0..core_count()).any(|core| CORE_EVENTS[core] != 0) }

#[no_mangle]
pub unsafe fn apic_restore_core_events(core: u32, events: u32, nmi: bool) {
    dbg_assert!((core as usize) < CORE_COUNT);
    CORE_EVENTS[core as usize] = events;
    NMI_PENDING[core as usize] = nmi;
}

/// Whether a (halted) core has an interrupt it would accept
#[no_mangle]
pub unsafe fn apic_core_interrupt_pending(core: u32) -> bool {
    let core = core as usize;
    pending_irq(apic_of(core), aux_of(core)).is_some() || routed_pic_pending(core as u32)
}

pub fn read32(addr: u32) -> u32 {
    if unsafe { !*acpi_enabled } {
        return 0;
    }
    if !apic_core_hardware_enabled(current_core() as u32) {
        return !0;
    }
    read32_internal(get_apic(), addr)
}

fn read32_internal(apic: &mut Apic, addr: u32) -> u32 {
    match addr {
        0x20 => {
            dbg_log!("APIC read id");
            apic.apic_id
        },

        0x30 => {
            // version
            dbg_log!("APIC read version");
            0x50014
        },

        0x80 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC read tpr");
            }
            apic.tpr
        },

        0xA0 => processor_priority(apic) as u32,

        0xB0 => {
            // write-only (written by DSL)
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC read eoi register");
            }
            0
        },

        0xD0 => {
            dbg_log!("Read local destination");
            apic.local_destination
        },

        0xE0 => {
            dbg_log!("Read destination format");
            apic.destination_format
        },

        0xF0 => apic.spurious_vector,

        0x100 | 0x110 | 0x120 | 0x130 | 0x140 | 0x150 | 0x160 | 0x170 => {
            let index = ((addr - 0x100) >> 4) as usize;
            dbg_log!("Read isr {}: {:08x}", index, apic.isr[index] as u32);
            apic.isr[index]
        },

        0x180 | 0x190 | 0x1A0 | 0x1B0 | 0x1C0 | 0x1D0 | 0x1E0 | 0x1F0 => {
            let index = ((addr - 0x180) >> 4) as usize;
            dbg_log!("Read tmr {}: {:08x}", index, apic.tmr[index] as u32);
            apic.tmr[index]
        },

        0x200 | 0x210 | 0x220 | 0x230 | 0x240 | 0x250 | 0x260 | 0x270 => {
            let index = ((addr - 0x200) >> 4) as usize;
            dbg_log!("Read irr {}: {:08x}", index, apic.irr[index] as u32);
            apic.irr[index]
        },

        0x280 => {
            dbg_log!("Read error: {:08x}", apic.read_error);
            apic.read_error
        },

        0x300 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("APIC read icr0");
            }
            apic.icr0
        },

        0x310 => {
            dbg_log!("APIC read icr1");
            apic.icr1
        },

        0x320 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("read timer lvt");
            }
            apic.lvt_timer
        },

        0x330 => {
            dbg_log!("read lvt thermal sensor");
            apic.lvt_thermal_sensor
        },

        0x340 => {
            dbg_log!("read lvt perf counter");
            apic.lvt_perf_counter
        },

        0x350 => {
            dbg_log!("read lvt int0");
            apic.lvt_int0
        },

        0x360 => {
            dbg_log!("read lvt int1");
            apic.lvt_int1
        },

        0x370 => {
            dbg_log!("read lvt error");
            apic.lvt_error
        },

        0x3E0 => {
            // divider
            dbg_log!("read timer divider");
            apic.timer_divider
        },

        0x380 => {
            dbg_log!("read timer initial count");
            apic.timer_initial_count
        },

        0x390 => timer_current_count(apic, unsafe { js::microtick() }),

        _ => {
            dbg_log!("APIC read {:x}", addr);
            apic.error |= ESR_ILLEGAL_REGISTER;
            0
        },
    }
}

pub fn write32(addr: u32, value: u32) {
    if unsafe { !*acpi_enabled } {
        return;
    }
    // Routing may touch the sending APIC again. End its exclusive borrow
    // before delivering an IPI or an IOAPIC EOI that can reassert the line.
    if !apic_core_hardware_enabled(current_core() as u32) {
        return;
    }
    match write32_internal(get_apic(), aux_of(current_core()), addr, value) {
        Some(ApicAction::Eoi(vector)) => ioapic::remote_eoi(vector),
        Some(ApicAction::Ipi { value, destination }) => {
            let source = current_core();
            aux_of(source).ipi_sent = aux_of(source).ipi_sent.wrapping_add(1);
            let targets = match (value >> 18) & 3 {
                0 => destination_cores(destination, ((value >> 11) & 1) as u8),
                1 => vec![source],
                2 => (0..core_count()).collect(),
                _ => (0..core_count()).filter(|&c| c != source).collect(),
            };
            deliver_to_cores(
                &targets,
                value as u8,
                ((value >> 8) & 7) as u8,
                false, // integrated xAPIC IPIs are edge-triggered (except INIT deassert)
                true,
            );
        },
        None => {},
    }
}

enum ApicAction {
    Eoi(u8),
    Ipi { value: u32, destination: u8 },
}

fn write32_internal(
    apic: &mut Apic,
    aux: &mut ApicAux,
    addr: u32,
    value: u32,
) -> Option<ApicAction> {
    match addr {
        0x20 => {
            dbg_log!("APIC write id: {:08x}", value >> 8);
            apic.apic_id = value & 0xFF000000;
        },

        0x30 => {
            // version
            dbg_log!("APIC write version: {:08x}, ignored", value);
        },

        0x80 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("Set tpr: {:02x}", value & 0xFF);
            }
            apic.tpr = value & 0xFF;
        },

        0xB0 => {
            if let Some(highest_isr) = highest_isr(apic) {
                if APIC_LOG_VERBOSE {
                    dbg_log!("eoi: {:08x} for vector {:x}", value, highest_isr);
                }
                register_clear_bit(&mut apic.isr, highest_isr);
                // TMR records the last accepted trigger mode; EOI clears
                // ISR, not TMR. The next acknowledge installs queued mode.
                if register_get_bit(&apic.tmr, highest_isr) {
                    return Some(ApicAction::Eoi(highest_isr));
                }
            }
            else {
                dbg_log!("Bad eoi: No isr set");
            }
        },

        0xD0 => {
            dbg_log!("Set local destination: {:08x}", value);
            apic.local_destination = value & 0xFF000000;
        },

        0xE0 => {
            dbg_log!("Set destination format: {:08x}", value);
            apic.destination_format = value | 0x0FFFFFFF;
        },

        0xF0 => {
            dbg_log!("Set spurious vector: {:08x}", value);
            // Directed EOI suppression is not advertised by our version.
            apic.spurious_vector = value & 0x3FF;
            if value & APIC_SOFTWARE_ENABLE == 0 {
                apic.lvt_timer |= IOAPIC_CONFIG_MASKED;
                apic.lvt_thermal_sensor |= IOAPIC_CONFIG_MASKED;
                apic.lvt_perf_counter |= IOAPIC_CONFIG_MASKED;
                apic.lvt_int0 |= IOAPIC_CONFIG_MASKED;
                apic.lvt_int1 |= IOAPIC_CONFIG_MASKED;
                apic.lvt_error |= IOAPIC_CONFIG_MASKED;
            }
        },

        0x280 => {
            // updated readable error register with real error
            dbg_log!("Write error: {:08x}", value);
            apic.read_error = apic.error;
            apic.error = 0;
        },

        0x300 => {
            let vector = (value & 0xFF) as u8;
            let delivery_mode = ((value >> 8) & 7) as u8;
            let destination_mode = ((value >> 11) & 1) as u8;
            let is_level = value & ioapic::IOAPIC_CONFIG_TRIGGER_MODE_LEVEL
                == ioapic::IOAPIC_CONFIG_TRIGGER_MODE_LEVEL;
            let destination_shorthand = (value >> 18) & 3;
            let destination = (apic.icr1 >> 24) as u8;
            dbg_log!(
                "APIC write icr0: {:08x} vector={:02x} destination_mode={} delivery_mode={} destination_shorthand={}",
                value,
                vector,
                DESTINATION_MODES[destination_mode as usize],
                DELIVERY_MODES[delivery_mode as usize],
                ["no", "self", "all with self", "all without self"][destination_shorthand as usize]
            );

            // delivery is immediate: the status bit (12) always reads as idle
            apic.icr0 = value & !(1 << 12);

            // ExtINT is not a legal ICR delivery mode; SMI is unsupported by
            // this platform. Reserved encodings must never become fixed IRQs.
            if matches!(delivery_mode, 2 | 3 | DELIVERY_EXTINT) {
                return None;
            }
            if matches!(
                delivery_mode,
                IOAPIC_DELIVERY_FIXED | DELIVERY_LOWEST_PRIORITY
            ) && vector < 0x10
            {
                apic.error |= ESR_SEND_ILLEGAL_VECTOR;
                return None;
            }
            let is_assert = value & ICR_LEVEL_ASSERT != 0;
            if delivery_mode == IOAPIC_DELIVERY_INIT && is_level && !is_assert {
                // INIT level de-assert only synchronizes arbitration IDs
                return None;
            }
            return Some(ApicAction::Ipi { value, destination });
        },

        0x310 => {
            dbg_log!("APIC write icr1: {:08x}", value);
            apic.icr1 = value;
        },

        0x320 => {
            if APIC_LOG_VERBOSE {
                dbg_log!("timer lvt: {:08x}", value);
            }
            // Expire under the previous mask/mode before changing it: an
            // elapsed masked one-shot must not be resurrected by unmasking.
            timer(apic, aux, unsafe { js::microtick() });
            apic.lvt_timer = masked_lvt(apic, value & 0x700FF);
        },

        0x330 => {
            dbg_log!("lvt thermal sensor: {:08x}", value);
            apic.lvt_thermal_sensor = masked_lvt(apic, value);
        },

        0x340 => {
            dbg_log!("lvt perf counter: {:08x}", value);
            apic.lvt_perf_counter = masked_lvt(apic, value);
        },

        0x350 => {
            dbg_log!("lvt int0: {:08x}", value);
            apic.lvt_int0 = masked_lvt(apic, value);
        },

        0x360 => {
            dbg_log!("lvt int1: {:08x}", value);
            apic.lvt_int1 = masked_lvt(apic, value);
        },

        0x370 => {
            dbg_log!("lvt error: {:08x}", value);
            apic.lvt_error = masked_lvt(apic, value);
        },

        0x3E0 => {
            apic.timer_divider = value;

            let divide_shift = (value & 0b11) | ((value & 0b1000) >> 1);
            apic.timer_divider_shift = if divide_shift == 0b111 { 0 } else { divide_shift + 1 };
            dbg_log!(
                "APIC timer divider: {:08x} shift={} tick={:.6}ms",
                apic.timer_divider,
                apic.timer_divider_shift,
                (1 << apic.timer_divider_shift) as f64 / APIC_TIMER_FREQ
            );
        },

        0x380 => {
            if APIC_LOG_VERBOSE {
                dbg_log!(
                    "APIC timer initial: {} next_interrupt={:.2}ms",
                    value,
                    value as f64 * (1 << apic.timer_divider_shift) as f64 / APIC_TIMER_FREQ,
                );
            }
            apic.timer_initial_count = value;
            apic.timer_current_count = value;
            apic.timer_last_tick = unsafe { js::microtick() };
        },

        0x390 => {
            dbg_log!("write timer current: {:08x}", value);
            // Writes to the read-only current count are ignored.
        },

        _ => {
            dbg_log!("APIC write32 {:x} <- {:08x}", addr, value);
            apic.error |= ESR_ILLEGAL_REGISTER;
        },
    }
    None
}

fn masked_lvt(apic: &Apic, value: u32) -> u32 {
    value | if apic.spurious_vector & APIC_SOFTWARE_ENABLE == 0 { IOAPIC_CONFIG_MASKED } else { 0 }
}

/// Advance the timer of every core's local APIC
#[no_mangle]
pub fn apic_timer(now: f64) -> f64 {
    let mut next = 100.0f64;
    for core in 0..core_count() {
        next = next.min(timer(apic_of(core), aux_of(core), now));
    }
    next
}

fn timer_current_count(apic: &Apic, now: f64) -> u32 {
    if apic.timer_initial_count == 0 || apic.timer_current_count == 0 {
        return 0;
    }
    let ticks = ((now - apic.timer_last_tick).max(0.0) * APIC_TIMER_FREQ
        / (1 << apic.timer_divider_shift) as f64) as u64;
    match apic.lvt_timer & APIC_TIMER_MODE_MASK {
        APIC_TIMER_MODE_PERIODIC => {
            apic.timer_initial_count - (ticks % apic.timer_initial_count as u64) as u32
        },
        APIC_TIMER_MODE_ONE_SHOT => apic
            .timer_initial_count
            .saturating_sub(ticks.min(u32::MAX as u64) as u32),
        _ => 0, // TSC deadline is not advertised; reserved modes do not run.
    }
}

fn timer(apic: &mut Apic, aux: &mut ApicAux, now: f64) -> f64 {
    if aux.hardware_enabled == 0 || apic.timer_initial_count == 0 || apic.timer_current_count == 0 {
        return 100.0;
    }
    let mode = apic.lvt_timer & APIC_TIMER_MODE_MASK;
    if mode != APIC_TIMER_MODE_PERIODIC && mode != APIC_TIMER_MODE_ONE_SHOT {
        return 100.0;
    }
    if apic.timer_last_tick > now {
        apic.timer_last_tick = now;
    }
    let period =
        apic.timer_initial_count as f64 * (1 << apic.timer_divider_shift) as f64 / APIC_TIMER_FREQ;
    let elapsed = now - apic.timer_last_tick;
    if elapsed >= period {
        if mode == APIC_TIMER_MODE_PERIODIC {
            // Coalesce overdue expirations, preserving the timer's phase.
            apic.timer_last_tick += (elapsed / period).floor() * period;
        }
        else {
            apic.timer_current_count = 0;
        }
        if apic.lvt_timer & IOAPIC_CONFIG_MASKED == 0 {
            deliver(apic, aux, apic.lvt_timer as u8, false);
        }
    }
    if apic.timer_current_count == 0 {
        100.0
    }
    else {
        (apic.timer_last_tick + period - now).max(0.0)
    }
}

/// Deliver an interrupt from the IO APIC (or an IPI) to the local APICs its
/// destination selects
pub fn route(vector: u8, mode: u8, is_level: bool, destination: u8, destination_mode: u8) -> bool {
    deliver_to_cores(
        &destination_cores(destination, destination_mode),
        vector,
        mode,
        is_level,
        false,
    )
}

/// Cores selected by a destination field: physical (APIC ID, 0xFF = all) or
/// logical (flat or cluster model, per the core's DFR/LDR)
fn destination_cores(destination: u8, destination_mode: u8) -> Vec<usize> {
    (0..core_count())
        .filter(|&core| {
            let apic = apic_of(core);
            if destination == 0xFF && destination_mode == 0 {
                return true;
            }
            if destination_mode == 0 {
                return (apic.apic_id >> 24) as u8 == destination;
            }
            let ldr = (apic.local_destination >> 24) as u8;
            if apic.destination_format >> 28 == 0xF {
                // flat model: 8 bits, one per APIC
                ldr & destination != 0
            }
            else if apic.destination_format >> 28 == 0 {
                // Cluster 0xF broadcasts to all clusters, while low bits
                // still select members. Other DFR encodings are reserved.
                (destination >> 4 == 0xF || ldr >> 4 == destination >> 4)
                    && ldr & destination & 0xF != 0
            }
            else {
                false
            }
        })
        .collect()
}

fn fixed_enabled(apic: &Apic, aux: &ApicAux) -> bool {
    aux.hardware_enabled != 0 && apic.spurious_vector & APIC_SOFTWARE_ENABLE != 0
}

fn deliver_to_cores(cores: &[usize], vector: u8, mode: u8, is_level: bool, is_ipi: bool) -> bool {
    if mode == DELIVERY_LOWEST_PRIORITY {
        // A disabled recipient does not participate in arbitration.
        if let Some(&core) = cores
            .iter()
            .filter(|&&core| fixed_enabled(apic_of(core), aux_of(core)))
            .min_by_key(|&&core| {
                let apic = apic_of(core);
                (processor_priority(apic) & 0xF0, apic.apic_id >> 24)
            })
        {
            let accepted = deliver(apic_of(core), aux_of(core), vector, is_level);
            if accepted && is_ipi {
                aux_of(core).ipi_received = aux_of(core).ipi_received.wrapping_add(1);
            }
            return accepted;
        }
        return false;
    }
    let mut accepted = false;
    for &core in cores {
        if aux_of(core).hardware_enabled == 0 {
            continue;
        }
        let accepted_here = match mode {
            IOAPIC_DELIVERY_INIT => unsafe {
                CORE_EVENTS[core] = CORE_EVENT_INIT;
                NMI_PENDING[core] = false;
                aux_of(core).extint_pending = 0;
                true
            },
            DELIVERY_STARTUP => unsafe {
                // The BSP never waits for SIPI; AP scheduler state ignores
                // subsequent SIPIs after the first has started execution.
                if core != 0 && CORE_EVENTS[core] & CORE_EVENT_SIPI == 0 {
                    CORE_EVENTS[core] |= CORE_EVENT_SIPI | (vector as u32) << 8;
                    true
                }
                else {
                    false
                }
            },
            IOAPIC_DELIVERY_NMI => unsafe {
                NMI_PENDING[core] = true;
                true
            },
            DELIVERY_EXTINT => {
                if fixed_enabled(apic_of(core), aux_of(core)) {
                    aux_of(core).extint_pending = 1;
                    true
                }
                else {
                    false
                }
            },
            IOAPIC_DELIVERY_FIXED => deliver(apic_of(core), aux_of(core), vector, is_level),
            _ => false, // reserved and unsupported SMI: never reinterpret as fixed
        };
        if accepted_here && is_ipi {
            aux_of(core).ipi_received = aux_of(core).ipi_received.wrapping_add(1);
        }
        accepted |= accepted_here;
        if accepted_here && mode == DELIVERY_EXTINT {
            // ExtINT represents one shared 8259 acknowledge cycle.
            break;
        }
    }
    accepted
}

fn deliver(apic: &mut Apic, aux: &mut ApicAux, vector: u8, is_level: bool) -> bool {
    if !fixed_enabled(apic, aux) {
        return false;
    }
    if vector < 0x10 {
        apic.error |= ESR_RECEIVE_ILLEGAL_VECTOR;
        return false;
    }
    if register_get_bit(&apic.irr, vector) {
        return true;
    }
    register_set_bit(&mut apic.irr, vector);
    if is_level {
        register_set_bit(&mut aux.pending_tmr, vector);
    }
    else {
        register_clear_bit(&mut aux.pending_tmr, vector);
    }
    if !register_get_bit(&apic.isr, vector) {
        if is_level {
            register_set_bit(&mut apic.tmr, vector);
        }
        else {
            register_clear_bit(&mut apic.tmr, vector);
        }
    }
    true
}

/// The platform wires the PIC output to BSP LINT0 and IOAPIC input 0.
/// An IOAPIC ExtINT RTE routes that same output to its selected processor.
/// An explicit ExtINT message is also latched until the recipient accepts it.
#[no_mangle]
pub fn routed_pic_pending(core: u32) -> bool {
    if !pic::has_pending_irq() {
        return false;
    }
    let core = core as usize;
    if unsafe { !*acpi_enabled } || aux_of(core).hardware_enabled == 0 {
        return core == 0;
    }
    let apic = apic_of(core);
    if aux_of(core).extint_pending != 0 && fixed_enabled(apic, aux_of(core)) {
        return true;
    }
    if core == 0
        && apic.lvt_int0 & IOAPIC_CONFIG_MASKED == 0
        && (apic.lvt_int0 >> 8) & 7 == DELIVERY_EXTINT as u32
    {
        return true;
    }
    if let Some((destination, mode)) = ioapic::pic_destination() {
        return destination_cores(destination, mode)
            .into_iter()
            .find(|&target| fixed_enabled(apic_of(target), aux_of(target)))
            == Some(core);
    }
    false
}

pub fn acknowledge_pic_irq() -> Option<u8> {
    if !routed_pic_pending(current_core() as u32) {
        return None;
    }
    let vector = pic::pic_acknowledge_irq();
    // Only one CPU can acknowledge the shared PIC output. Retire broadcast
    // latches together, so a stale target cannot steal the next device IRQ.
    for core in 0..core_count() {
        aux_of(core).extint_pending = 0;
    }
    vector
}

fn highest_irr(apic: &Apic) -> Option<u8> {
    let highest = register_get_highest_bit(&apic.irr);
    if let Some(x) = highest {
        dbg_assert!(x >= 0x10);
    }
    highest
}

fn highest_isr(apic: &Apic) -> Option<u8> {
    let highest = register_get_highest_bit(&apic.isr);
    if let Some(x) = highest {
        dbg_assert!(x >= 0x10);
    }
    highest
}

/// PPR preserves the TPR subclass only when the task-priority class is at
/// least the highest in-service interrupt's class (Intel SDM 11.8.3.1).
fn processor_priority(apic: &Apic) -> u8 {
    let task = apic.tpr as u8;
    let service = highest_isr(apic).unwrap_or(0) & 0xF0;
    if task & 0xF0 >= service {
        task
    }
    else {
        service
    }
}

/// Read-only; does not acknowledge or reprioritize an interrupt.
pub fn has_pending_irq() -> bool { pending_irq(get_apic(), aux_of(current_core())).is_some() }
pub fn acknowledge_irq() -> Option<u8> {
    acknowledge_irq_internal(get_apic(), aux_of(current_core()))
}

// Share the exact priority policy with acknowledgement, without modifying IRR,
// ISR or TPR. Continuation must not introduce a second interrupt policy.
fn pending_irq(apic: &Apic, aux: &ApicAux) -> Option<u8> {
    if !fixed_enabled(apic, aux) {
        return None;
    }
    let highest_irr = match highest_irr(apic) {
        None => return None,
        Some(x) => x,
    };

    if highest_irr & 0xF0 <= processor_priority(apic) & 0xF0 {
        if APIC_LOG_VERBOSE {
            dbg_log!(
                "Higher ppr, ppr={:x} irr={:x}",
                processor_priority(apic),
                highest_irr
            );
        }
        return None;
    }

    Some(highest_irr)
}

fn acknowledge_irq_internal(apic: &mut Apic, aux: &mut ApicAux) -> Option<u8> {
    let highest_irr = pending_irq(apic, aux)?;
    register_clear_bit(&mut apic.irr, highest_irr);
    register_set_bit(&mut apic.isr, highest_irr);
    if register_get_bit(&aux.pending_tmr, highest_irr) {
        register_set_bit(&mut apic.tmr, highest_irr);
    }
    else {
        register_clear_bit(&mut apic.tmr, highest_irr);
    }
    register_clear_bit(&mut aux.pending_tmr, highest_irr);

    if APIC_LOG_VERBOSE {
        dbg_log!("Calling vector {:x}", highest_irr);
    }

    dbg_assert!(pending_irq(apic, aux).is_none());

    Some(highest_irr)
}

// functions operating on 256-bit registers (for irr, isr, tmr)
fn register_get_bit(v: &[u32; 8], bit: u8) -> bool { v[(bit >> 5) as usize] & 1 << (bit & 31) != 0 }

fn register_set_bit(v: &mut [u32; 8], bit: u8) { v[(bit >> 5) as usize] |= 1 << (bit & 31); }

fn register_clear_bit(v: &mut [u32; 8], bit: u8) { v[(bit >> 5) as usize] &= !(1 << (bit & 31)); }

fn register_get_highest_bit(v: &[u32; 8]) -> Option<u8> {
    dbg_assert!(v.as_ptr().addr() & std::mem::align_of::<u64>() - 1 == 0);
    let v: &[u64; 4] = unsafe { std::mem::transmute(v) };
    for i in (0..4).rev() {
        let word = v[i];

        if word != 0 {
            return Some(word.ilog2() as u8 | (i as u8) << 6);
        }
    }

    None
}

#[cfg(test)]
mod continuation_tests {
    use super::*;
    #[test]
    fn pending_query_is_pure_and_matches_acknowledgement() {
        for vector in [0x20, 0x51, 0x7F, 0xE0] {
            for service in [
                None,
                Some(0x30),
                Some(vector & 0xF0),
                Some(vector),
                Some(0xF0),
            ] {
                for tpr in [0, 0x50, 0x70, 0xF0] {
                    // Apic contains only integer and floating-point fields.
                    let mut apic = APIC_RESET;
                    let mut aux = APIC_AUX_RESET;
                    apic.spurious_vector |= APIC_SOFTWARE_ENABLE;
                    register_set_bit(&mut apic.irr, vector);
                    if let Some(service) = service {
                        register_set_bit(&mut apic.isr, service);
                    }
                    apic.tpr = tpr;
                    let before = (apic.irr, apic.isr, apic.tpr);
                    let pending = pending_irq(&apic, &aux);
                    assert_eq!((apic.irr, apic.isr, apic.tpr), before);
                    let expected = service.is_none_or(|s| s & 0xF0 < vector & 0xF0)
                        && (vector & 0xF0) > (tpr as u8 & 0xF0);
                    assert_eq!(pending, expected.then_some(vector));
                    assert_eq!(acknowledge_irq_internal(&mut apic, &mut aux), pending);
                    if !expected {
                        assert_eq!((apic.irr, apic.isr, apic.tpr), before);
                    }
                }
            }
        }
    }

    fn enabled_apic() -> (Apic, ApicAux) {
        let mut apic = APIC_RESET;
        apic.spurious_vector |= APIC_SOFTWARE_ENABLE;
        (apic, APIC_AUX_RESET)
    }

    #[test]
    fn disabled_apic_holds_pending_but_rejects_new_fixed_interrupts() {
        let (mut apic, mut aux) = enabled_apic();
        assert!(deliver(&mut apic, &mut aux, 0x51, false));
        apic.spurious_vector &= !APIC_SOFTWARE_ENABLE;
        assert_eq!(pending_irq(&apic, &aux), None);
        assert!(!deliver(&mut apic, &mut aux, 0x61, false));
        assert!(register_get_bit(&apic.irr, 0x51));
        assert!(!register_get_bit(&apic.irr, 0x61));
        apic.spurious_vector |= APIC_SOFTWARE_ENABLE;
        aux.hardware_enabled = 0;
        assert_eq!(pending_irq(&apic, &aux), None);
        aux.hardware_enabled = 1;
        assert_eq!(acknowledge_irq_internal(&mut apic, &mut aux), Some(0x51));
    }

    #[test]
    fn illegal_vectors_set_esr_and_ff_is_a_legal_interrupt_vector() {
        let (mut apic, mut aux) = enabled_apic();
        for vector in 0..16 {
            assert!(!deliver(&mut apic, &mut aux, vector, false));
        }
        assert_eq!(apic.error, ESR_RECEIVE_ILLEGAL_VECTOR);
        assert_eq!(apic.irr, [0; 8]);
        assert!(deliver(&mut apic, &mut aux, 0xFF, false));
        assert_eq!(acknowledge_irq_internal(&mut apic, &mut aux), Some(0xFF));
    }

    #[test]
    fn queued_edge_does_not_destroy_in_service_level_trigger_mode() {
        let (mut apic, mut aux) = enabled_apic();
        assert!(deliver(&mut apic, &mut aux, 0x51, true));
        assert_eq!(acknowledge_irq_internal(&mut apic, &mut aux), Some(0x51));
        assert!(register_get_bit(&apic.tmr, 0x51));
        assert!(deliver(&mut apic, &mut aux, 0x51, false));
        assert!(
            register_get_bit(&apic.tmr, 0x51),
            "EOI still requires broadcast"
        );
        register_clear_bit(&mut apic.isr, 0x51);
        assert_eq!(acknowledge_irq_internal(&mut apic, &mut aux), Some(0x51));
        assert!(
            !register_get_bit(&apic.tmr, 0x51),
            "queued edge does not require broadcast"
        );
    }

    #[test]
    fn periodic_timer_coalesces_expiry_without_losing_phase() {
        let (mut apic, mut aux) = enabled_apic();
        apic.lvt_timer = APIC_TIMER_MODE_PERIODIC | 0x60;
        apic.timer_divider_shift = 0;
        apic.timer_initial_count = 1_000_000;
        apic.timer_current_count = apic.timer_initial_count;
        assert_eq!(timer(&mut apic, &mut aux, 3.25), 0.75);
        assert_eq!(apic.timer_last_tick, 3.0);
        assert_eq!(timer_current_count(&apic, 3.25), 750_000);
        assert_eq!(acknowledge_irq_internal(&mut apic, &mut aux), Some(0x60));
        assert_eq!(timer(&mut apic, &mut aux, 3.5), 0.5);
        assert!(!register_get_bit(&apic.irr, 0x60));
        assert_eq!(timer(&mut apic, &mut aux, 4.0), 1.0);
        assert!(register_get_bit(&apic.irr, 0x60));
    }

    #[test]
    fn masked_one_shot_expires_without_being_replayed_on_unmask() {
        let (mut apic, mut aux) = enabled_apic();
        apic.lvt_timer = IOAPIC_CONFIG_MASKED | 0x60;
        apic.timer_divider_shift = 0;
        apic.timer_initial_count = 1_000_000;
        apic.timer_current_count = apic.timer_initial_count;
        assert_eq!(timer(&mut apic, &mut aux, 2.0), 100.0);
        assert_eq!(apic.timer_current_count, 0);
        assert_eq!(timer_current_count(&apic, 2.0), 0);
        apic.lvt_timer &= !IOAPIC_CONFIG_MASKED;
        assert_eq!(timer(&mut apic, &mut aux, 3.0), 100.0);
        assert_eq!(apic.irr, [0; 8]);
    }

    #[test]
    fn reserved_timer_modes_remain_stopped() {
        let (mut apic, mut aux) = enabled_apic();
        apic.timer_initial_count = 1;
        apic.timer_current_count = 1;
        for mode in [2, 3] {
            apic.lvt_timer = mode << 17 | 0x60;
            assert_eq!(timer(&mut apic, &mut aux, 10.0), 100.0);
            assert_eq!(timer_current_count(&apic, 10.0), 0);
        }
        assert_eq!(apic.irr, [0; 8]);
    }
}
