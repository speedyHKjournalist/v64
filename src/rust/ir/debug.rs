//! Opt-in compiler inspection. Copies are bounded and never participate in
//! publication, execution, snapshots or guest state.
use std::{collections::VecDeque, sync::Mutex};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VerifyMode {
    Off,
    #[default]
    Debug,
    EveryPass,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DumpMode {
    #[default]
    Off,
    Hir,
    Mir,
    Wasm,
    All,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Config {
    pub verify: VerifyMode,
    pub dump: DumpMode,
}
impl Config {
    pub fn from_raw(verify: u32, dump: u32) -> Option<Self> {
        Some(Self {
            verify: match verify {
                0 => VerifyMode::Off,
                1 => VerifyMode::Debug,
                2 => VerifyMode::EveryPass,
                _ => return None,
            },
            dump: match dump {
                0 => DumpMode::Off,
                1 => DumpMode::Hir,
                2 => DumpMode::Mir,
                3 => DumpMode::Wasm,
                4 => DumpMode::All,
                _ => return None,
            },
        })
    }
    pub fn hir(self) -> bool { matches!(self.dump, DumpMode::Hir | DumpMode::All) }
    pub fn mir(self) -> bool { matches!(self.dump, DumpMode::Mir | DumpMode::All) }
    pub fn wasm(self) -> bool { matches!(self.dump, DumpMode::Wasm | DumpMode::All) }
    /// HIR pipeline boundaries are correctness checks in every mode. Only
    /// diagnostic rescans between trusted, bounded passes are optional.
    pub fn check_hir(self, region: &super::hir::Region, boundary: bool) -> Result<(), String> {
        if boundary && audit()
            || self.verify == VerifyMode::EveryPass
            || self.verify == VerifyMode::Debug && cfg!(debug_assertions)
        {
            super::verify::verify(region).map_err(|error| error.0)?;
        }
        Ok(())
    }
    pub fn check(
        self,
        mir: &super::mir::MirRegion,
        boundary: bool,
    ) -> Result<(), super::lowering::CompileError> {
        if self.verify == VerifyMode::EveryPass
            || boundary && self.verify == VerifyMode::Debug && cfg!(debug_assertions)
        {
            mir.verify()?;
        }
        Ok(())
    }
}

/// Redundant audits of already verified compiler transactions (re-verifying
/// the HIR at pass boundaries and after lifting, and recomputing every lowered
/// plan in Draft::finish). Always on in debug/test builds and with
/// `ir_verify: "every_pass"`; release production keeps the single HIR
/// verification at the lowering input plus every structural identity check.
static mut AUDIT: bool = cfg!(any(test, debug_assertions));
pub fn audit() -> bool { unsafe { AUDIT } }
/// `every_pass` forces audits; otherwise they follow the build profile.
pub fn set_audit(every_pass: bool) {
    unsafe {
        AUDIT = every_pass || cfg!(any(test, debug_assertions));
    }
}
/// Benchmarks of the release pipeline inside test builds only.
#[cfg(test)]
pub fn force_audit(enabled: bool) {
    unsafe {
        AUDIT = enabled;
    }
}
#[cfg(test)]
mod hir_tests {
    use super::*;
    use crate::ir::{
        backend::wasm::emit_cpu,
        frontend::{
            decode::{GuestEip, LinearAddress},
            region::lift_cpu_cfg,
        },
        lowering::lower,
        passes::{run, PassConfig},
    };

    fn region(bytes: &[u8]) -> crate::ir::hir::Region {
        lift_cpu_cfg(bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 8).unwrap()
    }

    #[test]
    fn hir_boundaries_reject_invalid_inputs_in_every_diagnostic_mode() {
        for mode in [VerifyMode::Off, VerifyMode::Debug, VerifyMode::EveryPass] {
            let debug = Config {
                verify: mode,
                dump: DumpMode::Off,
            };
            let mut broken = region(&[0x40, 0x49, 0x75, 0xFC]);
            broken.blocks[0].terminator = None;
            assert!(debug.check_hir(&broken, true).is_err());
            assert_eq!(
                debug.check_hir(&broken, false).is_err(),
                mode == VerifyMode::EveryPass
                    || mode == VerifyMode::Debug && cfg!(debug_assertions)
            );
            let before = crate::ir::dump::text(&broken);
            for rounds in [0, 2] {
                assert!(run(
                    &mut broken,
                    PassConfig {
                        debug,
                        rounds,
                        ..PassConfig::default()
                    },
                ).is_err());
                assert_eq!(crate::ir::dump::text(&broken), before);
            }
        }
    }

    #[test]
    fn hir_verification_modes_preserve_optimized_programs_and_recovery() {
        for bytes in [
            &[0x40, 0x49, 0x75, 0xFC][..],
            &[0x31, 0xC0, 0x74, 0x02, 0x8B, 0x06, 0x43][..],
            &[0x40, 0x89, 0x06, 0x49, 0x8B, 0x06][..],
            &[0x66, 0x0F, 0xEF, 0xC0, 0x66, 0x0F, 0xEB, 0xC1][..],
        ] {
            let mut baseline = None;
            for mode in [VerifyMode::EveryPass, VerifyMode::Debug, VerifyMode::Off] {
                let mut hir = region(bytes);
                run(
                    &mut hir,
                    PassConfig {
                        debug: Config {
                            verify: mode,
                            dump: DumpMode::Off,
                        },
                        ..PassConfig::default()
                    },
                ).unwrap();
                let observed = (
                    crate::ir::dump::text(&hir),
                    emit_cpu(&lower(&hir).unwrap(), 32).unwrap().bytes,
                );
                if let Some(expected) = &baseline {
                    assert_eq!(&observed, expected);
                }
                else {
                    baseline = Some(observed);
                }
            }
        }
    }
}
struct Record {
    pc: u32,
    tier: u32,
    hir: String,
    mir: String,
    wasm: Vec<u8>,
    truncated: u32,
}
const CAPACITY: usize = 16;
const TEXT_LIMIT: usize = 65536;
const WASM_LIMIT: usize = 262144;
static RECORDS: Mutex<VecDeque<Record>> = Mutex::new(VecDeque::new());
fn bounded(mut text: String, truncated: &mut u32, bit: u32) -> String {
    if text.len() > TEXT_LIMIT {
        let mut end = TEXT_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        *truncated |= bit;
    }
    text
}
pub(crate) fn record(pc: u32, tier: u32, hir: String, mir: String, wasm: &[u8]) {
    let mut truncated = 0;
    let hir = bounded(hir, &mut truncated, 1);
    let mir = bounded(mir, &mut truncated, 2);
    if wasm.len() > WASM_LIMIT {
        truncated |= 4;
    }
    let wasm = wasm[..wasm.len().min(WASM_LIMIT)].to_vec();
    let mut records = RECORDS.try_lock().unwrap();
    if records.len() == CAPACITY {
        records.pop_front();
    }
    records.push_back(Record {
        pc,
        tier,
        hir,
        mir,
        wasm,
        truncated,
    });
}
#[no_mangle]
pub fn ir_dump_count() -> u32 { RECORDS.try_lock().unwrap().len() as u32 }
#[no_mangle]
pub fn ir_dump_clear() { RECORDS.try_lock().unwrap().clear(); }
/// Pointers are only valid until the next compiler call or clear. JS copies all
/// fields synchronously before yielding; Worker RPC returns those copies.
#[no_mangle]
pub fn ir_dump_info(index: u32, field: u32) -> u32 {
    let records = RECORDS.try_lock().unwrap();
    let Some(r) = records.get(index as usize)
    else {
        return 0;
    };
    match field {
        0 => r.pc,
        1 => r.tier,
        2 => r.hir.as_ptr() as u32,
        3 => r.hir.len() as u32,
        4 => r.mir.as_ptr() as u32,
        5 => r.mir.len() as u32,
        6 => r.wasm.as_ptr() as u32,
        7 => r.wasm.len() as u32,
        8 => r.truncated,
        _ => 0,
    }
}
