use crate::cpu::cpu::{TLB_HAS_CODE, TLB_NO_USER, TLB_READONLY};
use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::Op,
    lowering::lower,
    mir::memory::{NativeMemory, SlowResult},
    passes::{run, PassConfig},
};
use crate::wasmgen::wasm_builder::WasmType;
#[test]
fn memory_plans_capture_width_guard_abi_and_completion() {
    let cases: &[(&[u8], u8, bool, &str)] = &[
        (&[0x8A, 0x00], 1, false, "ir_memory_read"),
        (&[0x66, 0x8B, 0x00], 2, false, "ir_memory_read"),
        (&[0x8B, 0x00], 4, false, "ir_memory_read"),
        (&[0x88, 0x00], 1, true, "ir_memory_write"),
        (&[0x66, 0x89, 0x00], 2, true, "ir_memory_write"),
        (&[0x89, 0x00], 4, true, "ir_memory_write"),
        (&[0x01, 0x00], 4, true, "ir_rmw_read"),
        (&[0xF3, 0x0F, 0x10, 0x00], 4, false, "ir_xmm_load"),
        (&[0xF2, 0x0F, 0x10, 0x00], 8, false, "ir_xmm_load"),
        (&[0x0F, 0x10, 0x00], 16, false, "ir_xmm_load"),
        (
            &[0x66, 0x0F, 0xC4, 0x00, 0xFF],
            2,
            false,
            "ir_xmm_insert_word",
        ),
        (&[0x0F, 0x14, 0x00], 8, false, "ir_xmm_binary"),
        (&[0x66, 0x0F, 0xFC, 0x00], 16, false, "ir_xmm_binary"),
        (&[0x66, 0x0F, 0x70, 0x00, 0xFF], 16, false, "ir_xmm_shuffle"),
        (&[0x0F, 0x12, 0x00], 8, false, "ir_xmm_transfer_load"),
        (&[0x0F, 0x17, 0x00], 8, true, "ir_xmm_store"),
        (&[0x66, 0x0F, 0xF7, 0xC1], 16, true, "ir_xmm_masked_store"),
    ];
    for &(bytes, width, write, name) in cases {
        for opt in [false, true] {
            let mut r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
            if opt {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let m = lower(&r).unwrap();
            let plan = m.memory.iter().flatten().next().unwrap();
            assert_eq!(plan.call.name, name);
            assert_eq!(plan.guard.bytes, width);
            assert_eq!(plan.guard.page_offset_limit, 4097 - width as i32);
            assert_eq!(
                plan.guard.flags_mask & (TLB_HAS_CODE | TLB_READONLY),
                if write { TLB_HAS_CODE | TLB_READONLY } else { 0 }
            );
            assert_eq!(plan.guard.user_mask, TLB_NO_USER);
            assert_eq!(plan.call.args.len(), plan.call.signature.params.len());
            assert_eq!(
                plan.call.signature.results,
                vec![if name == "ir_memory_read" || name == "ir_rmw_read" {
                    WasmType::I64
                }
                else {
                    WasmType::I32
                }]
            );
            if name.starts_with("ir_xmm_") {
                assert!(matches!(
                    plan.result,
                    SlowResult::CpuExit { accepted: [2, 4] }
                ));
            }
            if name == "ir_rmw_read" {
                assert!(matches!(
                    plan.native,
                    NativeMemory::ScalarLoad {
                        ticket: Some(_),
                        ..
                    }
                ));
                assert!(matches!(plan.result, SlowResult::Rmw { .. }));
            }
            emit_cpu(&m, 100).unwrap();
        }
    }
    // ENTER's partial accesses keep their own fault behavior and noncommitting stores.
    let r = lift_cpu(&[0x66, 0xC8, 8, 0, 2], GuestEip(0), LinearAddress(0), true).unwrap();
    let m = lower(&r).unwrap();
    assert!(m
        .memory
        .iter()
        .flatten()
        .any(|p| matches!(p.result, SlowResult::Store { commit: None, .. })));
    assert!(m.memory.iter().flatten().any(|p| matches!(
        p.result,
        SlowResult::Packed {
            trap_after_fault: true,
            ..
        }
    )));
    assert!(crate::ir::dump::mir(&m).contains("page_offset_limit"));
}
#[test]
fn emission_rejects_stale_or_weakened_memory_plans() {
    let r = lift_cpu(
        &[0x66, 0x0F, 0xF7, 0xC1],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    for mutation in 0..10 {
        let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
        let plan = m.memory.iter_mut().flatten().next().unwrap();
        match mutation {
            0 => plan.guard.bytes = 1,
            1 => plan.guard.flags_mask &= !TLB_READONLY,
            2 => plan.guard.flags_mask &= !TLB_HAS_CODE,
            3 => plan.guard.user_mask = 0,
            4 => plan.guard.page_offset_limit = 4096,
            5 => plan.call.signature.results = vec![WasmType::I64],
            6 => {
                plan.call.args.pop();
            },
            7 => plan.call.name = "ir_xmm_load",
            8 => plan.result = SlowResult::CpuExit { accepted: [0, 4] },
            9 => {
                plan.before = if let NativeMemory::VectorStore { commit, .. } = plan.native {
                    commit
                }
                else {
                    unreachable!()
                };
            },
            _ => unreachable!(),
        }
        assert!(m.finish().is_err(), "mutation {mutation}");
    }
    let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
    m.memory.clear();
    assert!(m.finish().is_err());
    let r = lift_cpu(&[0x0F, 0x17, 0x00], GuestEip(0), LinearAddress(0), true).unwrap();
    let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
    let mut changed = r.clone();
    for i in &mut changed.instructions {
        if let Op::XmmStore { ref mut lane, .. } = i.op {
            *lane = 0;
        }
    }
    m.hir = &changed;
    assert!(m.finish().is_err());
}
#[test]
fn memory_imports_participate_in_helper_signature_validation() {
    let mut r = lift_cpu(
        &[0x8B, 0x00, 0x0F, 0x30],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    r.helpers[0].name = "ir_memory_read".into();
    assert!(
        matches!(lower(&r),Err(crate::ir::lowering::CompileError::InvalidIr(message)) if message.contains("signature conflict"))
    );
}
