use super::*;
use crate::ir::{
    frontend::{
        decode::{GuestEip, LinearAddress},
        region::lift_cpu_cfg,
    },
    lowering::lower,
    passes::{run, PassConfig},
};

const PC: u32 = 0x100000;

fn compile(bytes: &[u8]) -> MirRegion {
    let mut hir = lift_cpu_cfg(bytes, GuestEip(PC), LinearAddress(PC), true, 64).unwrap();
    run(&mut hir, PassConfig::default()).unwrap();
    let mut mir = lower(&hir).unwrap();
    mir.schedule_operand_stack(262_144).unwrap();
    mir.allocate_machine_locals(4_000_000).unwrap();
    mir.elide_redundant_cpu_state_writes(262_144).unwrap();
    mir.elide_dead_cpu_values(262_144).unwrap();
    mir
}

#[test]
fn epoch_poll_keeps_first_recovery_after_an_observer() {
    // INC; load; INC; INC. A load may call MMIO or page walking, so the
    // recovery with two retired instructions must still see epoch changes.
    let mir = compile(&[0x40, 0x8B, 0x16, 0x43, 0x47]);
    let mask = required_epoch_polls(&mir);
    let checks: Vec<_> = mir
        .control
        .polls
        .iter()
        .enumerate()
        .filter_map(|(i, poll)| {
            poll.as_ref().map(|poll| {
                (
                    mir.states[poll.recovery.index()].cpu.count.snapshot,
                    mask[i],
                )
            })
        })
        .collect();
    assert!(checks.contains(&(2, true)), "{checks:?}");
    assert!(checks.contains(&(3, false)), "{checks:?}");
}

#[test]
fn epoch_poll_observer_fixtures() {
    let programs: [(&str, &[u8]); 7] = [
        ("load", &[0x40, 0x8B, 0x16, 0x43, 0x47]),
        ("store", &[0x40, 0x89, 0x0E, 0x43, 0x47]),
        ("rmw", &[0x40, 0xFF, 0x06, 0x43, 0x47]),
        ("xmm", &[0x40, 0x0F, 0x11, 0x06, 0x43, 0x47]),
        ("sse", &[0x40, 0x0F, 0x58, 0xC1, 0x43, 0x47]),
        ("divide", &[0x40, 0xF7, 0xF1, 0x43, 0x47]),
        ("second_load", &[0x40, 0x8B, 0x16, 0x43, 0x8B, 0x17, 0x45]),
    ];
    let dir = "build/ir-epoch-observers";
    std::fs::create_dir_all(dir).unwrap();
    let mut cases = Vec::new();
    let mut original_bytes = 0;
    let mut optimized_bytes = 0;
    for (name, prefix) in programs {
        let mut bytes = prefix.to_vec();
        bytes.extend([0xEB, (-(prefix.len() as i32 + 2)) as u8]);
        let mut mir = compile(&bytes);
        for batch in [false, true] {
            if batch {
                assert!(mir.batch_pure_budget_polls(262_144).unwrap() > 0, "{name}");
            }
            for elide in [false, true] {
                for budget in [1, 2, 3, 4, 5, 6, 7, 8, 16, 32] {
                    let artifact = emit_inner_with_batches(
                        &mir,
                        StateLayout {
                            gpr: gp::reg32 as u32,
                            flags: gp::flags as u32,
                            eip: gp::instruction_pointer as u32,
                            committed: gp::instruction_counter as u32,
                            flag_operand: gp::last_op1 as u32,
                        },
                        budget,
                        true,
                        Some(CpuEntryKey {
                            pc: GuestEip(PC),
                            linear: LinearAddress(PC),
                            default_32: true,
                        }),
                        &[PC],
                        true,
                        &[],
                        false,
                        true,
                        elide,
                    )
                    .unwrap();
                    assert_eq!(artifact.budget_batch_blocks > 0, batch);
                    if elide {
                        optimized_bytes += artifact.bytes.len();
                    }
                    else {
                        original_bytes += artifact.bytes.len();
                    }
                    std::fs::write(format!("{dir}/{}.wasm", cases.len()), artifact.bytes).unwrap();
                    cases.push(format!(
                        "[\"{name}\",{bytes:?},{batch},true,{budget},{elide}]"
                    ));
                }
            }
        }
    }
    assert!(optimized_bytes < original_bytes);
    eprintln!("epoch observer artifacts: {original_bytes} -> {optimized_bytes} bytes");
    std::fs::write(
        format!("{dir}/cases.json"),
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
