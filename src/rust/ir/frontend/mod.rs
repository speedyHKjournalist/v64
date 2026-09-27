pub(crate) use crate::decode;
mod bits;
mod control;
mod exchange;
mod far_control;
pub mod integer;
pub mod lift;
mod multiply;
pub mod region;
mod shift;
mod stack;

mod misc;

mod branch;
mod system_stack;

mod adapters;
mod segment;

mod string;

pub mod io;

mod rep;

pub mod cpu_info;

pub mod cpu_system;

pub mod control_regs;

pub mod descriptor;

pub mod task_regs;

pub mod selector_query;

mod x87;

mod simd_integer;
mod simd_moves;

mod simd_immediate;

mod simd_shuffle;

mod simd_transfer;

mod simd_lane;

pub mod simd_masked;

pub mod fp_state;

pub(crate) mod sse_fp;

pub(crate) mod mmx;

pub(crate) mod coverage;

pub(crate) mod sti;
