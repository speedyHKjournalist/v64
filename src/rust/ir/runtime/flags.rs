//! Demand-driven arithmetic FLAGS reads. Preserve the canonical CPU formulas
//! and lazy backing; each import returns its flag in architectural bit position.
use crate::cpu::misc_instr::{getaf, getcf, getof, getpf, getsf, getzf};

#[no_mangle]
pub unsafe fn ir_read_cf() -> i32 { getcf() as i32 }
#[no_mangle]
pub unsafe fn ir_read_pf() -> i32 { (getpf() as i32) << 2 }
#[no_mangle]
pub unsafe fn ir_read_af() -> i32 { (getaf() as i32) << 4 }
#[no_mangle]
pub unsafe fn ir_read_zf() -> i32 { (getzf() as i32) << 6 }
#[no_mangle]
pub unsafe fn ir_read_sf() -> i32 { (getsf() as i32) << 7 }
#[no_mangle]
pub unsafe fn ir_read_of() -> i32 { (getof() as i32) << 11 }
