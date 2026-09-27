//! CPU-only liveness derived from owned MIR at the point it is enabled.
//! State write/helper trimming is reflected in demand; no HIR is retained.
//! Both tiers derive a single mask from their enabled state certificates.
use super::MirData;
use crate::ir::{hir::Region, ids::InstId, lowering::CompileError};
pub const DEFAULT_WORK_LIMIT: usize = 262_144;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    live: Vec<bool>,
    demanded: Vec<bool>,
    control: Option<Vec<super::control::Terminator>>,
    enabled: bool,
}
impl Plan {
    pub(crate) fn disabled(instructions: usize) -> Self {
        Self {
            live: vec![true; instructions],
            demanded: vec![],
            control: None,
            enabled: false,
        }
    }
}
pub(super) fn verify(region: &Region, data: &MirData) -> Result<(), CompileError> {
    if data.cpu_liveness != Plan::disabled(region.instructions.len()) {
        return Err(CompileError::InvalidIr(
            "invalid initial CPU liveness plan".into(),
        ));
    }
    Ok(())
}
pub(super) fn verify_owned(data: &MirData) -> Result<(), CompileError> {
    if data.cpu_liveness.live.len() != data.values.len() {
        return Err(CompileError::InvalidIr(
            "invalid CPU liveness length".into(),
        ));
    }
    if data.cpu_liveness.enabled {
        if data.cpu_liveness.demanded.len() != data.value_types.len() {
            return Err(CompileError::InvalidIr("invalid CPU value demand length".into()));
        }
        // A bounded-demand fallback keeps every instruction/value and generic
        // edge schedule. It needs no failed analysis to be repeated by verify.
        if data.cpu_liveness.live.iter().all(|&live| live)
            && data.cpu_liveness.demanded.iter().all(|&live| live)
            && data.cpu_liveness.control.is_none()
        {
            return Ok(());
        }
        let required = super::allocation::cpu_demand(data, DEFAULT_WORK_LIMIT)?;
        if required
            .instructions
            .iter()
            .zip(&data.cpu_liveness.live)
            .any(|(&need, &live)| need && !live)
            || required.values.iter().zip(&data.cpu_liveness.demanded)
                .any(|(&need, &live)| need && !live)
        {
            return Err(CompileError::InvalidIr(
                "CPU liveness drops a required machine value".into(),
            ));
        }
        if let Some(control) = &data.cpu_liveness.control {
            if *control != super::allocation::cpu_copy_control(
                data, &data.cpu_liveness.demanded, DEFAULT_WORK_LIMIT,
            )? {
                return Err(CompileError::InvalidIr("invalid CPU edge-copy schedule".into()));
            }
        }
    }
    else if !data.cpu_liveness.demanded.is_empty() || data.cpu_liveness.control.is_some() {
        return Err(CompileError::InvalidIr("disabled CPU demand has edge facts".into()));
    }
    Ok(())
}
pub(super) fn enable(data: &mut MirData, work_limit: usize) -> Result<usize, CompileError> {
    if data.values.len() > work_limit {
        return Err(CompileError::Budget("CPU liveness work"));
    }
    let (live, demanded, control) = match super::allocation::cpu_demand(data, work_limit) {
        Ok(demand) => {
            let control = match super::allocation::cpu_copy_control(data, &demand.values, work_limit) {
                Ok(control) => Some(control),
                Err(CompileError::Budget(_)) => None,
                Err(error) => return Err(error),
            };
            (demand.instructions, demand.values, control)
        },
        Err(CompileError::Budget(_)) => (vec![true; data.values.len()], vec![true; data.value_types.len()], None),
        Err(error) => return Err(error),
    };
    let count = live
        .iter()
        .enumerate()
        .filter(|(i, live)| !**live && data.values[*i].is_some())
        .count();
    data.cpu_liveness = Plan {
        live,
        demanded,
        control,
        enabled: true,
    };
    Ok(count)
}
pub(super) fn invalidate_control(data: &mut MirData) { data.cpu_liveness.control = None; }
pub(super) fn terminator(data: &MirData, id: crate::ir::ids::BlockId) -> &super::control::Terminator {
    data.cpu_liveness.control.as_ref()
        .map_or(&data.control.blocks[id.index()].terminator, |blocks| &blocks[id.index()])
}
pub(super) fn instruction_live(data: &MirData, id: InstId) -> bool {
    !data.cpu_liveness.enabled
        || data.cpu_liveness.live[id.index()]
        || data.values[id.index()].is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{
        backend::wasm::{emit, emit_cpu, StateLayout},
        frontend::{
            decode::{GuestEip, LinearAddress},
            region::lift_cpu_cfg,
        },
        lowering::lower,
        passes::{run, PassConfig},
    };

    fn region(bytes: &[u8]) -> crate::ir::hir::Region {
        let mut region =
            lift_cpu_cfg(bytes, GuestEip(0x1000), LinearAddress(0x100000), true, 8).unwrap();
        run(&mut region, PassConfig::default()).unwrap();
        region
    }

    fn layout() -> StateLayout {
        StateLayout {
            gpr: 256,
            flags: 288,
            eip: 292,
            committed: 296,
            flag_operand: 300,
        }
    }

    #[test]
    fn incoming_arithmetic_flags_are_read_only_when_demanded() {
        for (bytes, expected) in [
            (&[0x01, 0xD8][..], &[][..]),
            (&[0x40][..], &["ir_read_cf"][..]),
            (&[0x11, 0xC8][..], &["ir_read_cf"][..]),
            (&[0x74, 0x10][..], &["ir_read_zf"][..]),
            (&[0x9E][..], &["ir_read_of"][..]),
        ] {
            let hir = region(bytes);
            let mut mir = lower(&hir).unwrap();
            mir.elide_entry_cpu_state_writes(DEFAULT_WORK_LIMIT).unwrap();
            mir.elide_dead_cpu_values(DEFAULT_WORK_LIMIT).unwrap();
            mir.verify().unwrap();
            let wasm = emit_cpu(&mir, 32).unwrap().bytes;
            let imports = |name: &str| wasm.windows(name.len()).any(|bytes| bytes == name.as_bytes());
            assert!(!imports("get_eflags"), "full FLAGS read must not remain: {bytes:02X?}");
            for name in ["ir_read_cf", "ir_read_pf", "ir_read_af", "ir_read_zf", "ir_read_sf", "ir_read_of"] {
                assert_eq!(imports(name), expected.contains(&name), "{bytes:02X?}: {name}");
            }
        }
    }

    fn phi_cycle() -> (crate::ir::mir::MirRegion, [crate::ir::ids::ValueId; 3], [usize; 3]) {
        use crate::ir::{frontend::integer::IntegerBuilder, hir::{Edge, Terminator}, state::{ResumeKind, StateMap}, types::Type};
        let mut builder = IntegerBuilder::new();
        let source = [builder.constant(11, Type::I32), builder.constant(22, Type::I32), builder.constant(33, Type::I32)];
        let target = builder.region.block(false);
        let params = std::array::from_fn(|_| builder.region.param(target, Type::I32));
        let effect = builder.region.param(target, Type::Effect);
        let mut gpr = builder.gpr;
        gpr[0] = params[0];
        gpr[1] = params[1];
        let before = builder.region.state(StateMap {
            instruction_pc: GuestEip(0x1000), next_pc: GuestEip(0x1001), next_value: None,
            resume: ResumeKind::BeforeInstruction, gpr, flags: builder.flags,
            xmm: vec![], x87: vec![], committed_instructions: 0, count_base: None, rep_progress: None,
        });
        builder.region.blocks[target.index()].entry_state = Some(before);
        let mut after = builder.region.states[before.index()].clone();
        after.resume = ResumeKind::AfterInstruction;
        after.committed_instructions = 1;
        let after = builder.region.state(after);
        builder.region.terminate(builder.block, Terminator::Branch(Edge {
            target, args: source.into_iter().chain([builder.effect]).collect(),
        }));
        builder.region.terminate(target, Terminator::Exit(after));
        let _ = effect;
        let mut mir = lower(&builder.region).unwrap();
        let slots = source.map(|value| mir.allocation.value_local[value.index()].unwrap());
        for (index, param) in params.iter().enumerate() {
            mir.data.allocation.value_local[param.index()] = Some(slots[(index + 1) % 3]);
        }
        mir.data.control = super::super::control::lower(&builder.region, &mir.allocation).unwrap();
        mir.verify().unwrap();
        (mir, params, slots)
    }

    #[test]
    fn cpu_phi_copies_reschedule_partial_cycles_and_reject_forged_demand() {
        use crate::ir::mir::control::{Copy, Source};
        let (mut mir, params, slots) = phi_cycle();
        let standalone = emit(&mir, layout(), 32).unwrap().bytes;
        let original = mir.control.blocks[0].terminator.edges()[0].clone();
        assert!(original.copies.iter().any(|copy| matches!(copy, Copy::Save { .. })));
        mir.elide_dead_cpu_values(DEFAULT_WORK_LIMIT).unwrap();
        assert!(mir.cpu_liveness.demanded[params[0].index()]);
        assert!(mir.cpu_liveness.demanded[params[1].index()]);
        assert!(!mir.cpu_liveness.demanded[params[2].index()]);
        let planned = mir.cpu_terminator(crate::ir::ids::BlockId(0)).edges()[0].clone();
        assert!(planned.scratch.is_empty(), "removing a dead destination breaks the cycle");
        assert_eq!(planned.copies.len(), 2);
        let evaluate = |edge: &super::super::control::Edge| {
            let mut locals: Vec<_> = (0..mir.allocation.local_types.len()).map(|n| n as u64 + 100).collect();
            let mut scratch = vec![0; edge.scratch.len()];
            for copy in &edge.copies {
                match *copy {
                    Copy::Save { local, scratch: slot } => scratch[slot] = locals[local],
                    Copy::Move { source, destination } => locals[destination] = match source {
                        Source::Local(slot) => locals[slot],
                        Source::Scratch(slot) => scratch[slot],
                    },
                }
            }
            locals
        };
        let full = evaluate(&original);
        let cpu = evaluate(&planned);
        for destination in [slots[1], slots[2]] {
            assert_eq!(cpu[destination], full[destination]);
        }
        assert_eq!(emit(&mir, layout(), 32).unwrap().bytes, standalone);
        mir.verify().unwrap();

        let saved = mir.data.cpu_liveness.clone();
        mir.data.cpu_liveness.demanded[params[0].index()] = false;
        assert!(mir.verify().is_err());
        mir.data.cpu_liveness = saved.clone();
        let super::super::control::Terminator::Jump(edge) = &mut mir.data.cpu_liveness.control.as_mut().unwrap()[0]
        else { panic!("entry jump") };
        edge.copies.clear();
        assert!(mir.verify().is_err());
        mir.data.cpu_liveness = saved.clone();
        assert!(mir.elide_dead_cpu_values(0).is_err());
        assert_eq!(mir.cpu_liveness, saved);
        assert_eq!(mir.elide_dead_cpu_values(mir.values.len()).unwrap(), 0);
        assert!(mir.cpu_liveness.live.iter().all(|&live| live));
        assert!(mir.cpu_liveness.control.is_none());
        assert_eq!(mir.cpu_terminator(crate::ir::ids::BlockId(0)).edges()[0], &original);
        mir.verify().unwrap();
        mir.data.cpu_liveness = saved;
        mir.allocate_machine_locals(4_000_000).unwrap();
        assert!(mir.cpu_liveness.control.is_none(), "new colors discard old copy schedules");
        mir.verify().unwrap();
    }

    #[test]
    fn owned_demand_tracks_state_trimming_and_rejects_required_value_removal() {
        let hir = region(&[0x46, 0x0F, 0x31]);
        let mut full = lower(&hir).unwrap();
        let full_dead = full.elide_dead_cpu_values(DEFAULT_WORK_LIMIT).unwrap();
        let mut trimmed = lower(&hir).unwrap();
        trimmed
            .elide_redundant_cpu_state_writes(super::super::state_elision::DEFAULT_WORK_LIMIT)
            .unwrap();
        let trimmed_dead = trimmed.elide_dead_cpu_values(DEFAULT_WORK_LIMIT).unwrap();
        assert!(
            trimmed_dead > full_dead,
            "entry-equivalent stores no longer keep unused GPR reads live"
        );
        trimmed.verify().unwrap();
        let required = trimmed
            .values
            .iter()
            .enumerate()
            .find(|(i, p)| p.is_some() && trimmed.cpu_liveness.live[*i])
            .unwrap()
            .0;
        trimmed.data.cpu_liveness.live[required] = false;
        assert!(trimmed.verify().is_err());
    }

    #[test]
    fn selective_sse_operands_survive_redundant_snapshot_trimming() {
        let hir = region(&[0x46, 0xF3, 0x0F, 0x58, 0xC1, 0x66, 0x0F, 0xEF, 0xC8]);
        let mut mir = lower(&hir).unwrap();
        mir.elide_redundant_cpu_state_writes(DEFAULT_WORK_LIMIT)
            .unwrap();
        mir.elide_dead_cpu_values(DEFAULT_WORK_LIMIT).unwrap();
        let mut checked = 0;
        for call in mir.calls.iter().flatten() {
            if let Some((source, destination)) = call.xmm_observation {
                for write in &mir.states[call.state.index()].cpu.writes {
                    if [source, destination].iter().any(|&reg| {
                        write.address
                            == super::super::value::Address::Absolute(
                                crate::cpu::global_pointers::get_reg_xmm_offset(reg as u32),
                            )
                    }) {
                        for v in super::super::allocation::expression(&write.expression) {
                            if let Some(id) = mir.value_definitions[v.index()] {
                                assert!(
                                    instruction_live(&mir, id),
                                    "selective operand must remain live"
                                );
                                checked += 1;
                            }
                        }
                    }
                }
            }
        }
        assert!(checked >= 2);
        mir.verify().unwrap();
    }

    #[test]
    fn cpu_liveness_elides_concrete_flags_without_changing_standalone() {
        // ADD EAX,EBX; ADD ECX,EDX; JNZ +2; NOP; NOP; NOP.
        // CPU recovery can carry exact lazy backing across both arithmetic
        // boundaries, while JNZ explicitly demands only ZF from the second ADD.
        let region = region(&[0x01, 0xD8, 0x01, 0xD1, 0x75, 0x02, 0x90, 0x90, 0x90]);
        let baseline = lower(&region).unwrap();
        let baseline_cpu = emit_cpu(&baseline, 100).unwrap();
        let baseline_standalone = emit(&baseline, layout(), 100).unwrap().bytes;

        let mut optimized = lower(&region).unwrap();
        let count = optimized.elide_dead_cpu_values(DEFAULT_WORK_LIMIT).unwrap();
        assert!(
            count > 0,
            "scalar ALU should expose CPU-only dead flag values"
        );
        let optimized_cpu = emit_cpu(&optimized, 100).unwrap();
        let optimized_standalone = emit(&optimized, layout(), 100).unwrap().bytes;

        assert!(
            optimized_cpu.bytes.len() < baseline_cpu.bytes.len(),
            "CPU liveness should remove emitted value programs"
        );
        assert!(optimized_cpu.locals < baseline_cpu.locals, "dead values and phi copies need no declared local");
        assert_eq!(
            optimized_standalone, baseline_standalone,
            "CPU-only liveness must not alter standalone emission"
        );
    }

    #[test]
    fn extended_integer_flag_families_keep_exact_recovery() {
        let region = region(&[
            0xD1, 0xE0, // SHL EAX, 1
            0xD1, 0xC9, // ROR ECX, 1
            0x0F, 0xA3, 0xC8, // BT EAX, ECX
            0xF3, 0x0F, 0xB8, 0xD8, // POPCNT EBX, EAX
            0x0F, 0xAF, 0xC3, // IMUL EAX, EBX
            0xF8, // CLC
            0xFC, // CLD
            0x75, 0x00, // JNZ
            0x90,
        ]);
        let mir = lower(&region).unwrap();
        assert!(
            mir.states.iter().all(|state| state.lazy_flags),
            "audited shift/bit/multiply/control states should keep exact recovery"
        );
    }

    #[test]
    fn mixed_eager_lazy_integer_flags_keep_exact_recovery() {
        // ADC/SBB eagerly materialize CF/AF/OF; INC/DEC eagerly preserve CF.
        // Their remaining arithmetic flags stay lazy in the baseline.
        let region = region(&[
            0x11, 0xD8, // ADC EAX, EBX
            0x19, 0xD1, // SBB ECX, EDX
            0x40, // INC EAX
            0x49, // DEC ECX
            0x75, 0x00, // JNZ
            0x90,
        ]);
        let mir = lower(&region).unwrap();
        assert!(
            mir.states.iter().all(|state| state.lazy_flags),
            "audited mixed eager/lazy integer states should use exact lazy recovery"
        );
    }
}
