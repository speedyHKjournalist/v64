//! Architectural progress for the machine clock. Dispatch attempts, exceptions
//! and REP continuation batches are deliberately not retired instructions.
//!
//! The cooperative scheduler switches cores only outside begin/finish. This
//! state is therefore Machine-owned transient execution state, not vCPU state.

use crate::cpu::string::{StringExecution, StringOutcome};

struct ExecutionState {
    deterministic: bool,
    active: bool,
    faulted: bool,
    string_result: Option<StringExecution>,
    pending_work: u64,
}

impl ExecutionState {
    const fn new() -> Self {
        Self {
            deterministic: false,
            active: false,
            faulted: false,
            string_result: None,
            pending_work: 0,
        }
    }

    fn begin(&mut self) {
        dbg_assert!(!self.active);
        self.active = true;
        self.faulted = false;
        self.string_result = None;
    }

    fn mark_fault(&mut self) {
        if self.active {
            self.faulted = true;
        }
    }

    fn record_string(&mut self, result: StringExecution) {
        if self.active {
            dbg_assert!(self.string_result.is_none());
            self.string_result = Some(result);
        }
    }

    fn finish(&mut self) -> u32 {
        dbg_assert!(self.active);
        let work = match self.string_result {
            // Completed REP elements remain architectural progress even when
            // the next element faults or a page/budget boundary yields.
            Some(result) if result.iterations > 0 => result.iterations,
            Some(result) => (result.outcome == StringOutcome::Complete && !self.faulted) as u32,
            None => (!self.faulted) as u32,
        };
        self.active = false;
        self.pending_work += work as u64;
        work
    }

    fn take_progress(&mut self) -> f64 {
        // JS consumes at slice boundaries and device reads. This counter is a
        // delta, rather than a floating-point lifetime instruction accumulator.
        dbg_assert!(self.pending_work <= (1u64 << 53) - 1);
        let work = self.pending_work;
        self.pending_work = 0;
        work as f64
    }
}

#[allow(non_upper_case_globals)]
static mut execution_state: ExecutionState = ExecutionState::new();

/// This mode uses the bounded interpreter and never a JIT/IR dispatch path.
#[no_mangle]
pub unsafe fn set_deterministic_execution(enabled: bool) {
    dbg_assert!(!execution_state.active);
    execution_state.deterministic = enabled;
}

#[inline(always)]
pub unsafe fn is_deterministic() -> bool {
    execution_state.deterministic
}

/// Begin before fetching the opcode, so a fetch fault cannot retire a step.
#[inline(always)]
pub unsafe fn begin_instruction() {
    (&mut *(&raw mut execution_state)).begin()
}

/// Return successful work from this dispatch, also queued for the JS clock.
#[inline(always)]
pub unsafe fn finish_instruction() -> u32 {
    (&mut *(&raw mut execution_state)).finish()
}

/// Mark synchronous faults only; traps and asynchronous IRQs are not faults.
#[inline(always)]
pub unsafe fn mark_fault() {
    (&mut *(&raw mut execution_state)).mark_fault()
}

/// Called once by the outer interpreter string-instruction wrapper.
#[inline(always)]
pub unsafe fn record_string(result: StringExecution) {
    (&mut *(&raw mut execution_state)).record_string(result)
}

/// Consume accumulated progress without retiring the currently executing PIO.
#[no_mangle]
pub unsafe fn take_clock_progress() -> f64 {
    (&mut *(&raw mut execution_state)).take_progress()
}

/// Used after reset/restore, with the previous pending delta already consumed.
/// The machine's execution mode survives architectural reset.
pub unsafe fn reset() {
    let deterministic = execution_state.deterministic;
    execution_state = ExecutionState::new();
    execution_state.deterministic = deterministic;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string_result(outcome: StringOutcome, iterations: u32) -> StringExecution {
        StringExecution {
            outcome,
            iterations,
        }
    }

    #[test]
    fn faults_do_not_retire_but_completed_instructions_do() {
        let mut state = ExecutionState::new();
        state.mark_fault(); // fault delivery outside a dispatch is irrelevant
        state.begin();
        assert_eq!(state.finish(), 1);
        state.begin();
        state.mark_fault();
        assert_eq!(state.finish(), 0);
        assert_eq!(state.take_progress(), 1.0);
        assert_eq!(state.take_progress(), 0.0);
    }

    #[test]
    fn rep_work_survives_faults_and_continuations_without_extra_retirements() {
        let mut state = ExecutionState::new();
        for (outcome, iterations, work) in [
            (StringOutcome::Complete, 0, 1),
            (StringOutcome::Complete, 17, 17),
            (StringOutcome::Repeat, 256, 256),
            (StringOutcome::Repeat, 0, 0),
            (StringOutcome::Fault, 5, 5),
            (StringOutcome::Fault, 0, 0),
        ] {
            state.begin();
            if outcome == StringOutcome::Fault {
                state.mark_fault();
            }
            state.record_string(string_result(outcome, iterations));
            assert_eq!(state.finish(), work);
        }
        assert_eq!(state.take_progress(), 279.0);
    }

    #[test]
    fn device_read_observes_only_prior_completed_dispatches() {
        let mut state = ExecutionState::new();
        state.begin();
        state.finish();
        state.begin(); // PIO callback during the next instruction
        assert_eq!(state.take_progress(), 1.0);
        assert_eq!(state.take_progress(), 0.0);
        state.finish();
        assert_eq!(state.take_progress(), 1.0);
    }

    #[test]
    fn jit_strings_outside_interpreter_dispatch_do_not_fabricate_progress() {
        let mut state = ExecutionState::new();
        state.record_string(string_result(StringOutcome::Complete, 100));
        assert_eq!(state.take_progress(), 0.0);
        state.begin();
        assert_eq!(state.finish(), 1);
    }
}
