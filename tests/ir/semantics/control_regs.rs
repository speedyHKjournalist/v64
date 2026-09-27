use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{decode, GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    helper::HelperAbi,
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn control_regs_fixtures() {
    std::fs::create_dir_all("build/ir-control-regs").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for op in 0x20..=0x23 {
            for index in 0..8 {
                for reg in 0..8 {
                    for prefix in [
                        vec![],
                        vec![0x66],
                        vec![0x67],
                        vec![0xF2],
                        vec![0xF3],
                        vec![0x64],
                        vec![0x66, 0x67, 0xF2, 0x64],
                    ] {
                        for m in 0..4 {
                            if !prefix.is_empty() && m != 3 {
                                continue;
                            }
                            // INC EBX observes a preceding FLAGS and register change, including when
                            // EBX is the implicit helper's data source or destination.
                            let mut bytes = vec![0x43];
                            bytes.extend(&prefix);
                            bytes.extend([0x0F, op, m << 6 | index << 3 | reg]);
                            let decoded =
                                decode(&bytes[1..], GuestEip(0x8001), LinearAddress(0x8001), mode)
                                    .unwrap();
                            assert!(decoded.ea.is_none());
                            assert_eq!(decoded.length as usize, bytes.len() - 1);
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-control-regs/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!("[{:?},{mode},{op},{index},{reg},{m}]", bytes));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-control-regs/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn control_regs_read_reload_and_terminal_write_contracts() {
    for op in 0x20..=0x23 {
        let bytes = [0x0F, op, 0xC0];
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        assert!(lift_cpu(&[0xF0, 0x0F, op, 0xC0], GuestEip(0), LinearAddress(0), true).is_err());
        assert_eq!(
            lift_cpu(&[0x0F, op, 0xC0, 0x90], GuestEip(0), LinearAddress(0), true).is_ok(),
            op < 0x22
        );
        let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert!(if op < 0x22 {
            matches!(r.helpers[0].abi, HelperAbi::CpuReload)
        }
        else {
            matches!(r.helpers[0].abi, HelperAbi::CpuExit)
        });
        assert_eq!(r.helpers[0].params.len(), 2);
        if op < 0x22 {
            assert_eq!(r.helpers[0].results, vec![crate::ir::types::Type::I32; 14]);
        }
        else {
            assert!(r.helpers[0].results.is_empty());
        }
    }
}

#[test]
fn system_read_continuation_fixtures() {
    use crate::ir::frontend::region::lift_cpu_cfg;
    std::fs::create_dir_all("build/ir-system-read-continuation").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for op in [0x20, 0x21, 0xA2] {
            for index in 0..if op == 0xA2 { 1 } else { 8 } {
                for reg in [0, 3] {
                    let mut bytes = vec![0x43, 0x0F, op];
                    if op != 0xA2 {
                        bytes.push(0xC0 | index << 3 | reg);
                    }
                    let helper_end = bytes.len();
                    if !mode {
                        bytes.push(0x66);
                    }
                    // The next instruction must use the new GPR, including a
                    // destination changed by the preceding INC EBX.
                    bytes.extend([0x89, 0xC6 | reg << 3, 0x47]);
                    for opt in 0..2 {
                        let mut region =
                            lift_cpu_cfg(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode, 64)
                                .unwrap();
                        if opt != 0 {
                            run(&mut region, PassConfig::default()).unwrap();
                        }
                        let mut mir = lower(&region).unwrap();
                        if opt != 0 {
                            mir.elide_redundant_cpu_state_writes(
                                crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                            )
                            .unwrap();
                            mir.elide_dead_cpu_values(
                                crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT,
                            )
                            .unwrap();
                        }
                        for budget in 1..=4 {
                            std::fs::write(
                                format!(
                                    "build/ir-system-read-continuation/{}-{opt}-{budget}.wasm",
                                    cases.len()
                                ),
                                // The entry poll consumes the first unit.
                                emit_cpu(&mir, budget + 1).unwrap().bytes,
                            )
                            .unwrap();
                        }
                    }
                    cases.push(format!(
                        "[{:?},{mode},{op},{index},{reg},{helper_end}]",
                        bytes
                    ));
                }
            }
        }
    }
    std::fs::write(
        "build/ir-system-read-continuation/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
