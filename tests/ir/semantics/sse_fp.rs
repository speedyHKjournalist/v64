use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
        sse_fp::OPERATIONS,
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn sse_fp_fixtures() {
    std::fs::create_dir_all("build/ir-sse-fp").unwrap();
    let mut cases = Vec::new();
    for &(opcode, width) in OPERATIONS {
        for mode in [false, true] {
            for address32 in [false, true] {
                for memory in [false, true] {
                    for dirty in [false, true] {
                        let mut bytes = vec![0x46];
                        if dirty {
                            bytes.extend_from_slice(&[0x66, 0x0F, 0xEF, 0xC9]);
                        }
                        if mode != address32 {
                            bytes.push(0x67);
                        }
                        if opcode > 0xFFFF {
                            bytes.push((opcode >> 16) as u8);
                        }
                        bytes.extend_from_slice(&[0x0F, opcode as u8]);
                        bytes.push(
                            8 | if memory {
                                if address32 {
                                    5
                                }
                                else {
                                    6
                                }
                            }
                            else {
                                0xC0
                            },
                        );
                        if memory {
                            bytes.extend_from_slice(
                                &0x6000u32.to_le_bytes()[..if address32 { 4 } else { 2 }],
                            );
                        }
                        if opcode & 255 == 0xC2 {
                            bytes.push(
                                (u8::from(mode) * 4 + u8::from(address32) * 2 + u8::from(dirty))
                                    | 0xF8,
                            );
                        }
                        assert!(
                            lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err()
                        );
                        let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                            .unwrap();
                        let mut suffix = bytes.clone();
                        suffix.push(0x90);
                        assert!(
                            lift_cpu(&suffix, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                .is_ok()
                        );
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            std::fs::write(
                                format!("build/ir-sse-fp/{}-{opt}.wasm", cases.len()),
                                emit_cpu(
                                    &{
                                        let mut mir = lower(&r).unwrap();
                                        if opt != 0 {
                                            mir.schedule_operand_stack(262_144).unwrap();
                                            mir.allocate_machine_locals(4_000_000).unwrap();
                                        }
                                        mir
                                    },
                                    100,
                                )
                                .unwrap()
                                .bytes,
                            )
                            .unwrap();
                        }
                        cases.push(format!(
                            "[{:?},{mode},{opcode},{dirty},{memory},{width}]",
                            bytes
                        ));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-sse-fp/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn sse_fp_debug_observer_fixtures() {
    use crate::ir::{
        backend::wasm::emit_cpu_entry,
        runtime::entry::CpuEntryKey,
    };
    let dir = "build/ir-sse-fp-observer";
    std::fs::create_dir_all(dir).unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for (name, instruction) in [
            ("native", &[0x0F, 0x58, 0xC8][..]),
            ("selective", &[0x0F, 0x51, 0xC8][..]),
            ("full", &[0x0F, 0x2C, 0xC8][..]),
            ("memory", &[0x0F, 0x58, 0x0F][..]),
        ] {
            // Dirty a GPR and an unrelated XMM before the observing operation.
            let mut bytes = vec![0x46, 0x66, 0x0F, 0xEF, 0xD2];
            if name == "memory" && !mode {
                bytes.push(0x67);
            }
            bytes.extend_from_slice(instruction);
            let after = bytes.len();
            bytes.extend_from_slice(&[0x40, 0x66, 0x0F, 0xEB, 0xDA]);
            for opt in [false, true] {
                let mut region = lift_cpu(
                    &bytes, GuestEip(0x8000), LinearAddress(0x8000), mode,
                ).unwrap();
                if opt {
                    run(&mut region, PassConfig::default()).unwrap();
                }
                let mut mir = lower(&region).unwrap();
                if opt {
                    mir.schedule_operand_stack(262_144).unwrap();
                    mir.allocate_machine_locals(4_000_000).unwrap();
                    mir.elide_redundant_cpu_state_writes(
                        crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                    ).unwrap();
                    mir.elide_helper_state_observations(
                        crate::ir::mir::helper_state::DEFAULT_WORK_LIMIT,
                    ).unwrap();
                    mir.elide_dead_cpu_values(
                        crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT,
                    ).unwrap();
                }
                let call = mir.calls.iter().flatten().next().unwrap();
                assert_eq!(call.native_fp.is_some(), name == "native");
                assert_eq!(call.xmm_observation.is_some(), matches!(name, "native" | "selective"));
                std::fs::write(
                    format!("{dir}/{}.wasm", cases.len()),
                    emit_cpu_entry(
                        &mir, 100,
                        CpuEntryKey {
                            pc: GuestEip(0x8000), linear: LinearAddress(0x8000), default_32: mode,
                        },
                        &[0x8000],
                    ).unwrap().bytes,
                ).unwrap();
                cases.push(format!("[\"{name}\",{bytes:?},{mode},{opt},{after}]"));
            }
        }
    }
    std::fs::write(format!("{dir}/cases.json"), format!("[{}]", cases.join(","))).unwrap();
}
