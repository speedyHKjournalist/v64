use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    lowering::lower,
    passes::{run, PassConfig},
};
/// CRC32 (F2 0F 38 F0/F1) fixtures for tests/ir/differential/crc32.mjs: 16-
/// and 32-bit code and addresses, the byte, word and doubleword sources from
/// a register (ESI, SI, DH: an INC ESI before changes it) and from memory,
/// ECX the destination; `dirty`: an INC ECX before changes the destination
/// and the flags, which CRC32 keeps
#[test]
fn crc32_fixtures() {
    use crate::cpu::features::{SSE4_1, SSE4_2, SSSE3, TEST_FEATURES};
    std::fs::create_dir_all("build/ir-crc32").unwrap();
    TEST_FEATURES.with(|f| f.set(SSSE3 | SSE4_1 | SSE4_2));
    let mut cases = Vec::new();
    for opcode in [0xF20F38F0u32, 0xF20F38F1] {
        for mode in [false, true] {
            for address32 in [false, true] {
                for width in [8, 16, 32] {
                    if (width == 8) != (opcode == 0xF20F38F0) {
                        continue;
                    }
                    for memory in [false, true] {
                        for dirty in [false, true] {
                            let mut bytes = vec![0x46];
                            if dirty {
                                bytes.push(0x41);
                            }
                            if width != 8 && (width == 32) != mode {
                                bytes.push(0x66);
                            }
                            if mode != address32 {
                                bytes.push(0x67);
                            }
                            bytes.extend_from_slice(&[0xF2, 0x0F, 0x38, opcode as u8]);
                            if memory {
                                bytes.push(if address32 { 0x0D } else { 0x0E });
                                bytes.extend_from_slice(
                                    &0x6000u32.to_le_bytes()[..if address32 { 4 } else { 2 }],
                                );
                            }
                            else {
                                bytes.push(0xCE);
                            }
                            assert!(lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                .is_err());
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .unwrap();
                            assert!(r.helpers.iter().any(|h| h.name
                                == if memory {
                                    "ir_crc32_mem_continue"
                                }
                                else {
                                    "ir_crc32_reg_continue"
                                }));
                            // (the region goes on after CRC32)
                            let mut suffix = bytes.clone();
                            suffix.push(0x90);
                            assert!(
                                lift_cpu(&suffix, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .is_ok(),
                                "{opcode:X} memory={memory}"
                            );
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-crc32/{}-{opt}.wasm", cases.len()),
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
    }
    std::fs::write(
        "build/ir-crc32/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    TEST_FEATURES.with(|f| f.set(0));
}
