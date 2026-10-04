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
    use crate::cpu::features::{SSSE3, TEST_FEATURES};
    std::fs::create_dir_all("build/ir-sse-fp").unwrap();
    // (tests/ir/differential/sse_fp.mjs runs these on a machine with SSSE3)
    TEST_FEATURES.with(|f| f.set(SSSE3));
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
                        if matches!(opcode >> 8 & 0xFFFF, 0x0F38 | 0x0F3A) {
                            bytes.extend_from_slice(&[
                                (opcode >> 24) as u8,
                                0x0F,
                                (opcode >> 8) as u8,
                                opcode as u8,
                            ]);
                        }
                        else {
                            if opcode > 0xFFFF {
                                bytes.push((opcode >> 16) as u8);
                            }
                            bytes.extend_from_slice(&[0x0F, opcode as u8]);
                        }
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
                        let variant =
                            usize::from(mode) * 4 + usize::from(address32) * 2 + usize::from(dirty);
                        if opcode & 0xFFFF == 0x0FC2 {
                            bytes.push(variant as u8 | 0xF8);
                        }
                        if opcode == 0x660F3A0F {
                            // palignr: within, at and beyond the source
                            bytes.push([0, 1, 7, 15, 16, 17, 31, 32][variant]);
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
    TEST_FEATURES.with(|f| f.set(0));
}
