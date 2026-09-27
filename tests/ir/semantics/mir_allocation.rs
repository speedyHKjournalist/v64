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

#[test]
fn dense_machine_allocation_preserves_colors_and_generated_code() {
    // Cold fault snapshots, loop phis, irreducible CFGs, narrow and vector
    // values, and CPU-reload helpers all contribute independent liveness roots.
    let programs: &[&[u8]] = &[
        &[0x40, 0x49, 0x75, 0xFC],
        &[0x03, 0x06, 0x49, 0x75, 0xFB],
        &[0x66, 0x0F, 0xEF, 0xC1, 0xE2, 0xFA],
        &[0x74, 0x02, 0x75, 0x02, 0x40, 0x90, 0x48, 0x90],
        &[0x74, 0x02, 0xEB, 0x02, 0xEB, 0xFC, 0xEB, 0xFC],
        &[0x11, 0xD8, 0x19, 0xD1, 0x40, 0x49, 0x75, 0xF8],
        &[0xFF, 0x06, 0x8B, 0x06, 0x49, 0x75, 0xF9],
        &[0xEC, 0x43, 0x49, 0x75, 0xFB],
        &[0x0F, 0x31, 0x43, 0x49, 0x75, 0xFA],
    ];
    for (index, bytes) in programs.iter().enumerate() {
        for mode in [false, true] {
            let mut bytes = bytes.to_vec();
            if !mode && matches!(index, 1 | 6) {
                // Address [SI] in 16-bit mode, preserving the instruction
                // lengths of the [ESI] loops and their backedge displacement.
                bytes[1] = 4;
                if index == 6 {
                    bytes[3] = 4;
                }
            }
            let original =
                lift_cpu_cfg(&bytes, GuestEip(0x1000), LinearAddress(0x201000), mode, 8)
                    .unwrap_or_else(|e| panic!("mode={mode}, bytes={bytes:x?}: {e:?}"));
            for optimized in [false, true] {
                let mut hir = original.clone();
                if optimized {
                    run(&mut hir, PassConfig::default()).unwrap();
                }
                for stack in [false, true] {
                    let mut mir = lower(&hir).unwrap();
                    if stack {
                        mir.fold_constants().unwrap();
                        mir.schedule_operand_stack(262_144).unwrap();
                    }
                    let initial_allocation = mir.allocation.clone();
                    let initial_control = mir.control.clone();
                    let reference = reallocate_with::<BTreeSet<ValueId>>(&mut mir.data, 4_000_000)
                        .unwrap();
                    mir.verify().unwrap();
                    let reference_allocation = mir.allocation.clone();
                    let reference_control = mir.control.clone();
                    let reference_code = emit_cpu(&mir, 256).unwrap().bytes;
                    mir.data.allocation = initial_allocation.clone();
                    mir.data.control = initial_control.clone();
                    assert_eq!(reallocate(&mut mir.data, 4_000_000).unwrap(), reference);
                    assert_eq!(mir.allocation, reference_allocation);
                    assert_eq!(mir.control, reference_control);
                    // The verifier intentionally retains its independent tree
                    // liveness solver; output equivalence is not its only check.
                    mir.verify().unwrap();
                    assert_eq!(emit_cpu(&mir, 256).unwrap().bytes, reference_code);
                    for budget in [1, 128, 1024] {
                        mir.data.allocation = initial_allocation.clone();
                        mir.data.control = initial_control.clone();
                        if reallocate(&mut mir.data, budget).is_err() {
                            assert_eq!(mir.allocation, initial_allocation);
                            assert_eq!(mir.control, initial_control);
                        }
                    }
                }
            }
        }
    }
}

fn wide_phi_forwarding(parameters: usize) -> crate::ir::mir::MirRegion {
    use crate::ir::{
        frontend::integer::IntegerBuilder,
        hir::{Edge, Terminator},
        state::{ResumeKind, StateMap},
    };
    let mut b = IntegerBuilder::new();
    let middle = b.region.block(false);
    let exit = b.region.block(false);
    let middle_effect = b.region.param(middle, Type::Effect);
    let exit_effect = b.region.param(exit, Type::Effect);
    let middle_values: Vec<_> = (0..parameters)
        .map(|_| b.region.param(middle, Type::I32)).collect();
    let middle_state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1000), next_pc: GuestEip(0x1001),
        next_value: None, resume: ResumeKind::BeforeInstruction,
        gpr: std::array::from_fn(|n| middle_values[n]), flags: b.flags.clone(),
        xmm: vec![], x87: vec![], committed_instructions: 0,
        count_base: None, rep_progress: None,
    });
    let exit_values: Vec<_> = (0..parameters)
        .map(|_| b.region.param(exit, Type::I32)).collect();
    b.region.terminate(b.block, Terminator::Branch(Edge {
        target: middle,
        args: std::iter::once(b.effect)
            .chain((0..parameters).map(|n| b.gpr[n % 8])).collect(),
    }));
    b.region.terminate(middle, Terminator::Branch(Edge {
        target: exit,
        args: std::iter::once(middle_effect).chain(middle_values).collect(),
    }));
    let state = b.region.state(StateMap {
        instruction_pc: GuestEip(0x1000), next_pc: GuestEip(0x1001),
        next_value: None, resume: ResumeKind::AfterInstruction,
        gpr: std::array::from_fn(|n| exit_values[n]), flags: b.flags,
        xmm: vec![], x87: vec![], committed_instructions: 1,
        count_base: None, rep_progress: None,
    });
    b.region.terminate(exit, Terminator::Exit(state));
    // Every non-cold guest block owns a budget recovery map (the lowered CFG
    // contract); the forwarding blocks recover at the same exit state.
    b.region.blocks[middle.index()].entry_state = Some(middle_state);
    b.region.blocks[exit.index()].entry_state = Some(state);
    // The effect parameter is a valid ordering root even with no effects in
    // this terminal block. Every data parameter is still a real edge assignment.
    let _ = exit_effect;
    lower(&b.region).unwrap()
}

#[test]
fn machine_verifier_bounds_wide_phi_edge_searches() {
    // These are cheap forwarding blocks, with no scalar instruction chains.
    // Almost every live value is filtered out at the incoming edge, but finding
    // each parameter in its Vec still performs a quadratic membership search.
    let mir = wide_phi_forwarding(128);
    assert!(matches!(verify(&mir, 12_000), Err(CompileError::Budget(_))),
        "small survivor sets must not hide wide-phi edge work");
    verify(&mir, 4_000_000).unwrap();
}

#[test]
fn machine_edge_work_budget_failure_preserves_executable_allocation() {
    let mut mir = wide_phi_forwarding(128);
    let allocation = mir.allocation.clone();
    let control = mir.control.clone();
    let wasm = emit_cpu(&mir, 8).unwrap().bytes;
    // Find the actual complete-pass boundary, without duplicating its work
    // formula. Failure immediately below it must keep the usable old plan.
    let mut low = 0;
    let mut high = 4_000_000;
    reallocate(&mut mir.data, high).unwrap();
    while low + 1 < high {
        mir.data.allocation = allocation.clone();
        mir.data.control = control.clone();
        let budget = low + (high - low) / 2;
        match reallocate(&mut mir.data, budget) {
            Ok(_) => high = budget,
            Err(CompileError::Budget(_)) => low = budget,
            Err(error) => panic!("unexpected allocation failure: {error:?}"),
        }
    }
    mir.data.allocation = allocation.clone();
    mir.data.control = control.clone();
    assert!(matches!(mir.allocate_machine_locals(low), Err(CompileError::Budget(_))));
    assert_eq!(mir.allocation, allocation);
    assert_eq!(mir.control, control);
    mir.verify().unwrap();
    assert_eq!(emit_cpu(&mir, 8).unwrap().bytes, wasm);
    mir.allocate_machine_locals(high).unwrap();
    mir.verify().unwrap();
}

#[test]
#[ignore = "allocator timing only, not an XP performance gate"]
fn machine_allocation_paired_benchmark() {
    for size in [8, 32, 64] {
        let mut bytes = vec![0x40; size];
        bytes.extend([0x49, 0x75, (-(size as i32 + 3)) as u8]);
        let hir = lift_cpu_cfg(&bytes, GuestEip(0), LinearAddress(0), true, 8).unwrap();
        let mut mir = lower(&hir).unwrap();
        mir.schedule_operand_stack(262_144).unwrap();
        let mut samples = [vec![], vec![]];
        for round in 0..7 {
            for which in [round % 2, 1 - round % 2] {
                let start = std::time::Instant::now();
                for _ in 0..20 {
                    let result = if which == 0 {
                        reallocate_with::<BTreeSet<ValueId>>(&mut mir.data, 4_000_000)
                    }
                    else {
                        reallocate(&mut mir.data, 4_000_000)
                    };
                    std::hint::black_box(result.unwrap());
                }
                samples[which].push(start.elapsed().as_secs_f64() * 1e6 / 20.0);
            }
        }
        for sample in &mut samples {
            sample.sort_by(f64::total_cmp);
        }
        println!(
            "{size} instructions: MIR tree {:.1} us, MIR dense {:.1} us",
            samples[0][3], samples[1][3]
        );
    }
}
