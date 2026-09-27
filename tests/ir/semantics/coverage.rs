use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        coverage::{behavior, OPCODES},
        decode::{encodings, GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn coverage_fixtures() {
    std::fs::create_dir_all("build/ir-coverage").unwrap();
    let mut cases = Vec::new();
    for enc in encodings().iter().filter(|e| {
        OPCODES.contains(&e.opcode)
            && (e.opcode != 0x0FAE || e.group >= 4)
            && (e.opcode != 0x0FC7 || e.group == 6)
    }) {
        for mode in [false, true] {
            for address32 in [false, true] {
                for width in [16, 32] {
                    if !enc.os && (width == 32) != mode {
                        continue;
                    }
                    for memory in [false, true] {
                        if memory && (!enc.e || enc.mem_ud) || !memory && enc.reg_ud {
                            continue;
                        }
                        for dirty in [false, true] {
                            let mut bytes = vec![0x46];
                            if dirty {
                                bytes.extend_from_slice(&[0x66, 0x0F, 0xEF, 0xC9]);
                            }
                            if enc.os && (width == 32) != mode {
                                bytes.push(0x66);
                            }
                            if mode != address32 {
                                bytes.push(0x67);
                            }
                            if enc.opcode > 255 {
                                bytes.push(0x0F);
                            }
                            bytes.push(enc.opcode as u8);
                            if enc.fetch_modrm {
                                let group = if enc.group >= 0 { enc.group as u8 } else { 1 };
                                bytes.push(
                                    group << 3
                                        | if memory {
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
                            }
                            assert!(lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                .is_err());
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-coverage/{}-{opt}.wasm", cases.len()),
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
                            let kind = if [0x63, 0x9B, 0x0FC3, 0x0FC7].contains(&enc.opcode) {
                                5
                            }
                            else {
                                behavior(enc.opcode, enc.group, memory)
                            };
                            cases.push(format!(
                                "[{:?},{mode},{},{dirty},{memory},{width},{kind},{},{}]",
                                bytes, enc.opcode, enc.sse, enc.group
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-coverage/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
