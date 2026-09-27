use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    lowering::{lower, CompileError},
    mir::{effect::EffectPlan, memory::Argument, CPU_IMPORTS},
    passes::{run, PassConfig},
};
use crate::wasmgen::wasm_builder::WasmType;
#[test]
fn lowered_observers_preserve_rmw_commit_phases() {
    for (bytes, width) in [
        (vec![0x40, 0x00, 0x08], 1),
        (vec![0x40, 0x66, 0x01, 0x08], 2),
        (vec![0x40, 0x01, 0x08], 4),
    ] {
        for opt in [false, true] {
            let mut r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
            if opt {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let m = lower(&r).unwrap();
            let plan = m
                .effects
                .iter()
                .flatten()
                .find(|p| matches!(p, EffectPlan::RmwCommit { .. }))
                .unwrap();
            if let EffectPlan::RmwCommit {
                bytes,
                observe,
                commit,
                call,
                ..
            } = plan
            {
                assert_eq!(*bytes, width);
                assert_eq!(observe.values, *commit);
                assert_ne!(observe.count, *commit);
                assert_eq!(m.states[observe.count.index()].cpu.count.snapshot, 1);
                assert_eq!(m.states[commit.index()].cpu.count.snapshot, 2);
                assert_eq!(call.name, "ir_rmw_write");
                assert_eq!(
                    call.signature.params,
                    vec![WasmType::I64, WasmType::I32, WasmType::I32]
                );
                assert!(call.signature.results.is_empty());
            }
            emit_cpu(&m, 100).unwrap();
            let dump = crate::ir::dump::mir(&m);
            assert!(dump.contains("Observation"));
            assert!(dump.contains("state0:"));
        }
    }
}
#[test]
fn address_and_guard_calls_are_legalized() {
    for bytes in [
        vec![0x64, 0x8B, 0x00],
        vec![0x8F, 0x04, 0x24],
        vec![0x60],
        vec![0x61],
        vec![0x66, 0x60],
        vec![0x66, 0x61],
        vec![0x66, 0x0F, 0xC4, 0xC0, 0xFF],
    ] {
        for opt in [false, true] {
            let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), true).unwrap();
            if opt {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let m = lower(&r).unwrap();
            for plan in m.effects.iter().flatten() {
                match plan {
                    EffectPlan::Address { call, .. } => {
                        assert_eq!(call.signature.results, vec![WasmType::I64]);
                        assert_eq!(
                            call.args.len(),
                            if call.name == "ir_pop_address" { 3 } else { 2 }
                        );
                    },
                    EffectPlan::Check {
                        guard,
                        call,
                        success,
                        fault,
                        ..
                    } => {
                        assert_eq!(*fault, 2);
                        if let Some(guard) = guard {
                            assert_eq!(guard.mask, 12);
                            assert_eq!(*success, None);
                            assert_eq!(call.name, "ir_sse_guard");
                            assert!(call.args.is_empty());
                        }
                        else {
                            assert_eq!(*success, Some(0));
                            assert_eq!(call.name, "ir_memory_check");
                            let width = if bytes[0] == 0x66 { 16 } else { 32 };
                            assert_eq!(call.args[1], Argument::I32(width));
                            assert_eq!(
                                call.args[2],
                                Argument::I32(i32::from(*bytes.last().unwrap() == 0x60))
                            );
                        }
                    },
                    _ => (),
                }
            }
            emit_cpu(&m, 100).unwrap();
        }
    }
}
#[test]
fn stale_effect_plans_and_cpu_import_shadowing_are_rejected() {
    for mutation in 0..11 {
        let bytes: &[u8] = if mutation < 4 {
            &[0x40, 0x01, 0x08]
        }
        else if mutation < 7 {
            &[0x64, 0x8B, 0x00]
        }
        else {
            &[0x0F, 0x10, 0xC1]
        };
        let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
        let plan = m
            .effects
            .iter_mut()
            .flatten()
            .find(|p| match mutation {
                0..=3 => matches!(p, EffectPlan::RmwCommit { .. }),
                4..=6 => matches!(p, EffectPlan::Address { .. }),
                _ => matches!(p, EffectPlan::Check { .. }),
            })
            .unwrap();
        match plan {
            EffectPlan::RmwCommit {
                bytes,
                observe,
                commit,
                call,
                ..
            } => match mutation {
                0 => observe.count = *commit,
                1 => observe.values = observe.count,
                2 => call.signature.params[0] = WasmType::I32,
                3 => *bytes = 8,
                _ => unreachable!(),
            },
            EffectPlan::Address {
                null_byte,
                base,
                call,
                ..
            } => match mutation {
                4 => *null_byte += 1,
                5 => *base = 0,
                6 => {
                    call.args.pop();
                },
                _ => unreachable!(),
            },
            EffectPlan::Check {
                guard,
                success,
                fault,
                call,
                ..
            } => match mutation {
                7 => guard.as_mut().unwrap().mask = 0,
                8 => *fault = 0,
                9 => *success = Some(0),
                10 => call.name = "ir_memory_check",
                _ => unreachable!(),
            },
            EffectPlan::Arithmetic(_) | EffectPlan::X87 { .. } => unreachable!(),
        }
        assert!(m.finish().is_err(), "mutation {mutation}");
    }
    let r = lift_cpu(&[0x0F, 0x10, 0xC1], GuestEip(0), LinearAddress(0), true).unwrap();
    let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
    m.effects.clear();
    assert!(m.finish().is_err());
    for name in CPU_IMPORTS {
        let mut r = lift_cpu(&[0x0F, 0x30], GuestEip(0), LinearAddress(0), true).unwrap();
        r.helpers[0].name = (*name).into();
        let m = lower(&r).unwrap();
        assert!(
            matches!(emit_cpu(&m,100),Err(CompileError::InvalidIr(message)) if message.contains("shadows CPU ABI")),
            "{name}"
        );
    }
    let mut r = lift_cpu(
        &[0x8B, 0x00, 0x0F, 0x30],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    r.helpers[0].name = "ir_segment_address".into();
    assert!(
        matches!(lower(&r),Err(CompileError::InvalidIr(message)) if message.contains("signature conflict"))
    );
}
