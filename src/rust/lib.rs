#[macro_use]
mod dbg;

#[macro_use]
mod paging;

pub mod cpu;
pub mod x64;

pub mod js_api;
pub mod parallel;
pub mod profiler;

mod config;
#[allow(dead_code)]
#[path = "ir/frontend/decode.rs"]
pub(crate) mod decode;
mod decode_rules;
mod gen;
mod ir;
mod jit;
mod jit_switches;
mod leb;
mod page;
mod prefix;
#[cfg(test)]
#[path = "../../tests/decode/simd_corpus.rs"]
mod simd_corpus;
mod softfloat;
mod state_flags;
mod wasmgen;
mod x87_profiler;
mod zstd;
