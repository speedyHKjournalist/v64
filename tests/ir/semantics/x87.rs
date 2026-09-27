use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    helper::HelperAbi,
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
};

fn valid(opcode: u32, group: u32, r: u32) -> bool {
    match opcode {
        0xD8 | 0xDC => true,
        0xD9 => match group {
            0 | 1 | 3 | 6 | 7 => true,
            2 => r == 0,
            4 => matches!(r, 0 | 1 | 4 | 5),
            5 => r <= 6,
            _ => false,
        },
        0xDA => match group {
            0..=3 => true,
            5 => r == 1,
            _ => false,
        },
        0xDB => match group {
            0..=3 | 5 | 6 => true,
            4 => r <= 4,
            _ => false,
        },
        0xDD => group <= 5,
        0xDE => group != 3 || r == 1,
        0xDF => match group {
            0..=3 | 5 | 6 => true,
            4 => r == 0,
            _ => false,
        },
        _ => false,
    }
}

#[test]
fn x87_register_fixtures() {
    std::fs::create_dir_all("build/ir-x87").unwrap();
    let mut cases = Vec::new();

    for opcode in 0xD8u32..=0xDF {
        let operand_prefixes: &[&[u8]] =
            if matches!(opcode, 0xD9 | 0xDD) { &[&[], &[0x66]] } else { &[&[]] };
        for &prefix in operand_prefixes {
            for group in 0u32..8 {
                for r in 0u32..8 {
                    // Dirty one GPR before the helper so the fixture
                    // also proves pre-call StateMap materialization and exact
                    // instruction retirement.
                    let mut bytes = vec![0x46];
                    bytes.extend_from_slice(prefix);
                    bytes.push(opcode as u8);
                    bytes.push(0xC0 | (group << 3) as u8 | r as u8);

                    let mut region =
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), true).unwrap();
                    assert_register_lowering(&region, opcode as u8, 0xC0 | (group << 3) as u8 | r as u8);

                    for opt in 0..2 {
                        if opt != 0 {
                            run(&mut region, PassConfig::default()).unwrap();
                        }
                        let mir = lower(&region).unwrap();
                        std::fs::write(
                            format!("build/ir-x87/{}-{opt}.wasm", cases.len()),
                            emit_cpu(&mir, 100).unwrap().bytes,
                        )
                        .unwrap();
                    }

                    cases.push(format!(
                        "[{:?},{opcode},{group},{r},{},{}]",
                        bytes,
                        valid(opcode, group, r),
                        !prefix.is_empty()
                    ));
                }
            }
        }
    }

    std::fs::write("build/ir-x87/cases.json", format!("[{}]", cases.join(","))).unwrap();
}

#[test]
fn x87_register_continuation_contract() {
    for opcode in 0xD8u8..=0xDF {
        let bytes = [opcode, 0xC0];
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        assert!(lift_cpu(&[opcode, 0xC0, 0x90], GuestEip(0), LinearAddress(0), true).is_ok());
        assert!(lift_cpu(&[0xF0, opcode, 0xC0], GuestEip(0), LinearAddress(0), true).is_err());

        let region = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert_register_lowering(&region, opcode, 0xC0);
        // Stack-only forms have no helper call at all; test the CPU-state forms.
        let region =
            lift_cpu(&[if opcode == 0xDF { 0xDF } else { 0xDB }, 0xF1], GuestEip(0), LinearAddress(0), true)
                .unwrap();
        assert_eq!(region.helpers.len(), 1);
        assert_eq!(region.helpers[0].name, "ir_x87_reg_continue");
        assert!(matches!(region.helpers[0].abi, HelperAbi::CpuReload));
        assert_eq!(
            region.helpers[0].results,
            vec![crate::ir::types::Type::I32; 14]
        );
        assert!(region
            .values
            .iter()
            .all(|v| v.ty != crate::ir::types::Type::V128));
        let mut descriptor = region.helpers[0].clone();
        descriptor.abi = HelperAbi::CpuExit;
        assert!(
            descriptor.validate().is_err(),
            "continuation must reload scalar outputs"
        );
    }

    // Address-size override is semantically inert for mod=3, but must remain
    // accepted by the shared decoder/frontend.
    assert!(lift_cpu(&[0x67, 0xD8, 0xC1], GuestEip(0), LinearAddress(0), true).is_ok());
    // Environment/state-image memory forms keep their own terminal ABI,
    // including #NM-before-segment order.
    let memory = lift_cpu(
        &[0xD9, 0x25, 0, 0, 0, 0],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    assert_eq!(memory.helpers[0].name, "ir_x87_mem");
    assert!(matches!(memory.helpers[0].abi, HelperAbi::CpuExit));
    assert!(lift_cpu(&[0xD9, 0x20, 0x90], GuestEip(0), LinearAddress(0), true).is_err());
    // Operand loads/stores continue: #NM guard, ordinary memory op, x87 op.
    let load = lift_cpu(&[0xD9, 0x00, 0x90], GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(load.helpers.is_empty());
    let ops: Vec<_> = load.instructions.iter().map(|i| i.op.clone()).collect();
    let check = ops.iter().position(|op| *op == Op::FpuCheck).unwrap();
    let read = ops.iter().position(|op| matches!(op, Op::GuestLoad { bytes: 4 })).unwrap();
    let x87 = ops.iter().position(|op| matches!(op, Op::X87 { opcode: 0xD9, modrm: 0 })).unwrap();
    assert!(check < read && read < x87);
    let store = lift_cpu(&[0xDD, 0x18, 0x90], GuestEip(0), LinearAddress(0), true).unwrap();
    let ops: Vec<_> = store.instructions.iter().map(|i| i.op.clone()).collect();
    let preflight =
        ops.iter().position(|op| matches!(op, Op::GuestCheck { bytes: 8, write: true })).unwrap();
    let x87 = ops.iter().position(|op| matches!(op, Op::X87 { .. })).unwrap();
    let partial = ops.iter().position(|op| matches!(op, Op::PartialStore { bytes: 4 })).unwrap();
    let commit = ops.iter().position(|op| matches!(op, Op::GuestStore { bytes: 4 })).unwrap();
    assert!(preflight < x87 && x87 < partial && partial < commit);
}

/// Stack-only register forms lower to one `X87` op after the #NM guard.
/// FLAGS/GPR forms and nested invalid encodings reload through the helper.
fn assert_register_lowering(region: &crate::ir::hir::Region, opcode: u8, modrm: u8) {
    if crate::ir::x87::io(opcode, modrm).is_some() {
        assert!(region.helpers.is_empty());
        assert!(region.instructions.iter().any(|i| i.op == Op::FpuCheck));
        assert!(region.instructions.iter().any(|i| i.op == Op::X87 { opcode, modrm }));
    }
    else {
        assert_eq!(region.helpers.len(), 1);
        assert_eq!(region.helpers[0].name, "ir_x87_reg_continue");
        assert!(matches!(region.helpers[0].abi, HelperAbi::CpuReload));
    }
}

#[test]
fn x87_continuation_fixtures() {
    use crate::ir::frontend::region::lift_cpu_cfg;
    let programs: &[(&str, &[u8])] = &[
        // FCOMI -> integer carry -> FCMOV -> FNSTSW AX -> integer use.
        (
            "flags",
            &[
                0x46, 0xDB, 0xF1, 0x83, 0xD0, 0, 0xDA, 0xC1, 0xDF, 0xE0, 0x40,
            ],
        ),
        // Consecutive helpers retain the exact canonical F80 stack.
        ("stack", &[0x46, 0xD9, 0xE8, 0xDE, 0xC1, 0xDF, 0xE0, 0x40]),
        (
            "loop",
            &[0x46, 0xD9, 0xE0, 0x49, 0x75, 0xFB, 0xDF, 0xE0, 0x40],
        ),
        // A late invalid nested opcode must not replay the successful helpers.
        ("invalid", &[0x46, 0xD9, 0xE8, 0xDB, 0xF1, 0xD9, 0xD1, 0x40]),
        // XMM locals that were dirtied before x87 must survive scalar reload.
        (
            "xmm",
            &[
                0x66, 0x0F, 0xEF, 0xC0, 0xD9, 0xE0, 0x66, 0x0F, 0xEB, 0xC8, 0x40,
            ],
        ),
    ];
    let dir = "build/ir-x87-continuation";
    std::fs::create_dir_all(dir).unwrap();
    let mut cases = Vec::new();
    for &(name, bytes) in programs {
        for mode in [false, true] {
            for cfg in [false, true] {
                if !cfg && name == "loop" {
                    continue;
                }
                let mut region = if cfg {
                    lift_cpu_cfg(bytes, GuestEip(0x8000), LinearAddress(0x8000), mode, 64)
                }
                else {
                    lift_cpu(bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                }
                .unwrap();
                if name != "xmm" {
                    assert!(region
                        .values
                        .iter()
                        .all(|v| v.ty != crate::ir::types::Type::V128));
                }
                for opt in [false, true] {
                    if opt {
                        run(&mut region, PassConfig::default()).unwrap();
                    }
                    let mir = lower(&region).unwrap();
                    for budget in if cfg { vec![1, 2, 3, 4, 5, 6, 7, 8, 12, 16] } else { vec![100] }
                    {
                        std::fs::write(
                            format!("{dir}/{}.wasm", cases.len()),
                            emit_cpu(&mir, budget).unwrap().bytes,
                        )
                        .unwrap();
                        cases.push(format!(
                            "[\"{name}\",{bytes:?},{mode},{cfg},{opt},{budget}]"
                        ));
                    }
                }
            }
        }
    }
    std::fs::write(
        format!("{dir}/cases.json"),
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
