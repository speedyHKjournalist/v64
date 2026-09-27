use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
        mmx::OPERATIONS,
    },
    helper::HelperAbi,
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn mmx_fixtures() {
    std::fs::create_dir_all("build/ir-mmx").unwrap();
    let mut cases = Vec::new();
    for &(key, width, forms) in OPERATIONS {
        let opcode = key & 0xFFFFFF;
        for mode in [false, true] {
            for address32 in [false, true] {
                for encoded_memory in [false, true] {
                    if forms & (if encoded_memory { 2 } else { 5 }) == 0 {
                        continue;
                    }
                    let memory = encoded_memory || opcode == 0x0FF7;
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
                        if forms != 4 {
                            let group = if key >> 24 != 0 { (key >> 24) as u8 } else { 1 };
                            bytes.push(
                                group << 3
                                    | if encoded_memory {
                                        if address32 {
                                            5
                                        }
                                        else {
                                            6
                                        }
                                    }
                                    else {
                                        0xC0 | if address32 { 0 } else { 1 }
                                    },
                            );
                        }
                        if encoded_memory {
                            bytes.extend_from_slice(
                                &0x6000u32.to_le_bytes()[..if address32 { 4 } else { 2 }],
                            );
                        }
                        if key >> 24 != 0 || [0x0F70, 0x0FC4, 0x0FC5].contains(&opcode) {
                            bytes.push(
                                [0, 1, 15, 16, 31, 32, 63, 255][usize::from(mode) * 4
                                    + usize::from(address32) * 2
                                    + usize::from(dirty)],
                            );
                        }
                        assert!(
                            lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err()
                        );
                        let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                            .unwrap();
                        let mut suffix = bytes.clone();
                        suffix.push(0x90);
                        assert_eq!(
                            lift_cpu(&suffix, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                .is_err(),
                            memory,
                            "only checked/implicit memory terminates the region"
                        );
                        if !memory {
                            let vector = matches!(opcode, 0xF20FD6 | 0xF30FD6);
                            let helper = r.helpers.last().unwrap();
                            assert!(matches!(helper.abi, HelperAbi::CpuReload));
                            assert_eq!(helper.results.len(), if vector { 22 } else { 14 });
                            if !vector && !dirty {
                                assert!(r
                                    .values
                                    .iter()
                                    .all(|v| v.ty != crate::ir::types::Type::V128));
                            }
                        }
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            std::fs::write(
                                format!("build/ir-mmx/{}-{opt}.wasm", cases.len()),
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
    std::fs::write("build/ir-mmx/cases.json", format!("[{}]", cases.join(","))).unwrap();
}

#[test]
fn mmx_continuation_fixtures() {
    use crate::ir::frontend::region::lift_cpu_cfg;
    let programs: &[(&str, &[u8])] = &[
        // MOVD inputs/output, packed arithmetic and scalar extraction.
        (
            "gpr",
            &[
                0x46, 0x0F, 0x6E, 0xC0, 0x0F, 0xFD, 0xC1, 0x0F, 0x7E, 0xC0, 0x40, 0x0F, 0xC5, 0xD8,
                0, 0x0F, 0xD7, 0xD0, 0x42,
            ],
        ),
        // EMMS must expose its empty tags before a continuing x87 push.
        (
            "alias",
            &[
                0x46, 0x0F, 0xEF, 0xC0, 0xDF, 0xE0, 0x0F, 0x77, 0xD9, 0xE8, 0xDF, 0xE0, 0x40,
            ],
        ),
        // Observe dirty XMM input and use the freshly reloaded XMM output.
        (
            "xmm",
            &[
                0x66, 0x0F, 0xEF, 0xC9, 0xF2, 0x0F, 0xD6, 0xC1, 0x0F, 0xD4, 0xC2, 0xF3, 0x0F, 0xD6,
                0xC8, 0x66, 0x0F, 0xEB, 0xD1, 0x40,
            ],
        ),
        (
            "loop",
            &[
                0x46, 0x0F, 0xFD, 0xC1, 0x49, 0x75, 0xFA, 0x0F, 0x77, 0xDF, 0xE0,
            ],
        ),
        // Completed MMX must survive a later CPU-owned nested x87 #UD.
        ("invalid", &[0x46, 0x0F, 0xEF, 0xC0, 0xD9, 0xD1, 0x40]),
    ];
    let dir = "build/ir-mmx-continuation";
    std::fs::create_dir_all(dir).unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        let mut programs: Vec<(&str, Vec<u8>)> = programs
            .iter()
            .map(|(name, bytes)| (*name, bytes.to_vec()))
            .collect();
        let mut fault = vec![0x46, 0x0F, 0xEF, 0xC0];
        if !mode {
            fault.push(0x67);
        }
        fault.extend([0x8B, 0x07, 0x40]); // MOV EAX,[EDI] after MMX succeeds
        programs.push(("fault", fault));
        for (name, bytes) in programs {
            for cfg in [false, true] {
                if !cfg && name == "loop" {
                    continue;
                }
                let mut region = if cfg {
                    lift_cpu_cfg(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode, 64)
                }
                else {
                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
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
                        if !cfg {
                            let entry = crate::ir::runtime::entry::CpuEntryKey {
                                pc: GuestEip(0x8000),
                                linear: LinearAddress(0x8000),
                                default_32: mode,
                            };
                            std::fs::write(
                                format!("{dir}/{}-entry.wasm", cases.len()),
                                crate::ir::backend::wasm::emit_cpu_entry(
                                    &mir,
                                    budget,
                                    entry,
                                    &[0x8000],
                                )
                                .unwrap()
                                .bytes,
                            )
                            .unwrap();
                        }
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
