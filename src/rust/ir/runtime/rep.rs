//! Cold CPU REP batches. Runtime-only work metadata is consumed before reentry.
use crate::cpu::{
    global_pointers as gp,
    string::{execute_rep, StringOutcome},
};
use crate::ir::helper::Outcome;
static mut LAST_RESULT: u64 = 0;
pub(super) unsafe fn reset_result() { LAST_RESULT = 0; }
/// High word: completed elements. Low word: Outcome (zero means no REP this entry).
#[no_mangle]
pub unsafe fn ir_rep_result() -> u64 { LAST_RESULT }
unsafe fn batch(kind: u32, bytes: u32, asize32: u32, segment: u32, repne: u32, limit: u32) -> u32 {
    assert!(asize32 <= 1 && repne <= 1 && segment < 6 && limit <= 4096);
    LAST_RESULT = 0;
    let result = execute_rep(kind, bytes, asize32 != 0, segment as i32, repne != 0, limit);
    let outcome = match result.outcome {
        StringOutcome::Complete => {
            *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(1);
            Outcome::Invalidated
        },
        StringOutcome::Repeat => Outcome::Yield,
        StringOutcome::Fault => Outcome::ControlTransferred,
    } as u32;
    LAST_RESULT = (result.iterations as u64) << 32 | outcome as u64;
    outcome
}
macro_rules! adapter {
    ($name:ident, $kind:expr) => {
        #[no_mangle]
        pub unsafe fn $name(bytes: u32, asize32: u32, segment: u32, repne: u32, limit: u32) -> u32 {
            batch($kind, bytes, asize32, segment, repne, limit)
        }
    };
}
adapter!(ir_rep_movs, 0);
adapter!(ir_rep_cmps, 1);
adapter!(ir_rep_stos, 2);
adapter!(ir_rep_lods, 3);
adapter!(ir_rep_scas, 4);
adapter!(ir_rep_ins, 5);
adapter!(ir_rep_outs, 6);
