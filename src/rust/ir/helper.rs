pub mod cpu_registry;
pub mod imports;
use super::{effects::Effects, types::Type};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExceptionOwner {
    CannotFault,
    Caller,
    Helper,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Outcome {
    Normal = 0,
    FaultNeedsDelivery = 1,
    ControlTransferred = 2,
    Yield = 3,
    Invalidated = 4,
}
#[derive(Clone, Debug)]
pub enum HelperAbi {
    /// Metadata alone does not authorize calling an interpreter helper.
    Unadapted,
    /// Outcome-only CPU ABI. On Normal, new SSA results reload GPRs, concrete
    /// and lazy FLAGS backing, then XMMs for vector adapters. Audited scalar
    /// observers verify XMM backing instead and return only 14 scalar values.
    /// The adapter preserves EIP, segments,
    /// privilege/mode, translation and counters on Normal. Faults are CPU-owned.
    CpuReload,
    /// CPU state is authoritative after this terminal call. The adapter owns
    /// one instruction commit on success and returns Invalidated; delivered
    /// faults return ControlTransferred without committing. No Normal outcome.
    CpuExit,
    /// Terminal REP batch: Yield preserves partial CPU progress without a guest
    /// instruction commit; Invalidated commits final completion once.
    CpuRep,
    /// Returns (outcome: i32, data...). Data is valid only on Normal.
    /// Caller-owned faults use the named () -> () delivery adapter, which
    /// consumes pending fault metadata and must not return to guest execution.
    Outcome {
        fault_delivery: Option<String>,
        /// An audited adapter preserves cached architectural state on Normal.
        /// Exceptional/control-transfer outcomes may update authoritative state.
        normal_preserves_state: bool,
    },
}
#[derive(Clone, Debug)]
pub struct HelperDescriptor {
    pub name: String,
    pub params: Vec<Type>,
    pub results: Vec<Type>,
    pub effects: Effects,
    pub exception_owner: ExceptionOwner,
    pub abi: HelperAbi,
}
pub fn cpu_reload_types() -> Vec<Type> { [vec![Type::I32; 14], vec![Type::V128; 8]].concat() }
impl HelperDescriptor {
    /// Unreviewed helpers observe everything. They are not eligible for DCE/CSE.
    pub fn conservative(name: String, params: Vec<Type>, results: Vec<Type>) -> Self {
        Self {
            name,
            params,
            results,
            effects: Effects::conservative(),
            exception_owner: ExceptionOwner::Helper,
            abi: HelperAbi::Unadapted,
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        cpu_registry::validate(self)?;
        if matches!(self.abi, HelperAbi::CpuReload)
            && (self.results != cpu_registry::reload_types(&self.name)
                || self.exception_owner != ExceptionOwner::Helper)
        {
            return Err("invalid CPU normal-reload contract");
        }
        if matches!(self.abi, HelperAbi::CpuExit | HelperAbi::CpuRep)
            && (self.exception_owner != ExceptionOwner::Helper
                || !self.results.is_empty()
                || !self.effects.may_transfer
                || !self.effects.invalidates_code)
        {
            return Err("invalid CPU exit helper contract");
        }
        if matches!(self.abi, HelperAbi::CpuRep) && !self.effects.may_yield {
            return Err("REP helper must allow progress yields");
        }
        if self.effects.may_fault && self.exception_owner == ExceptionOwner::CannotFault {
            return Err("faulting helper has no exception owner");
        }
        if self
            .params
            .iter()
            .chain(&self.results)
            .any(|t| matches!(t, Type::Effect | Type::GuardProof | Type::RmwTicket))
        {
            return Err("compile-time value in helper ABI");
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterAction {
    Continue,
    RestoreAndDeliver,
    ExitWithoutRestore,
}
// Adapters for yielding/invalidating helpers must materialize all observed
// state before the call. Their post-call CPU state is authoritative, including
// partial progress; never overwrite it with the pre-call StateMap.
pub fn after_call(
    descriptor: &HelperDescriptor,
    outcome: Outcome,
) -> Result<AdapterAction, &'static str> {
    descriptor.validate()?;
    if matches!(descriptor.abi, HelperAbi::CpuExit)
        && !matches!(outcome, Outcome::ControlTransferred | Outcome::Invalidated)
    {
        return Err("CPU exit helper cannot continue");
    }
    if matches!(descriptor.abi, HelperAbi::CpuRep)
        && !matches!(
            outcome,
            Outcome::ControlTransferred | Outcome::Yield | Outcome::Invalidated
        )
    {
        return Err("CPU REP helper cannot continue");
    }
    match outcome {
        Outcome::Normal => Ok(AdapterAction::Continue),
        Outcome::ControlTransferred if descriptor.effects.may_transfer => {
            Ok(AdapterAction::ExitWithoutRestore)
        },
        Outcome::FaultNeedsDelivery
            if descriptor.exception_owner == ExceptionOwner::Caller
                && descriptor.effects.may_fault =>
        {
            Ok(AdapterAction::RestoreAndDeliver)
        },
        Outcome::Yield if descriptor.effects.may_yield => Ok(AdapterAction::ExitWithoutRestore),
        Outcome::Invalidated if descriptor.effects.invalidates_code => {
            Ok(AdapterAction::ExitWithoutRestore)
        },
        _ => Err("helper outcome violates contract"),
    }
}
