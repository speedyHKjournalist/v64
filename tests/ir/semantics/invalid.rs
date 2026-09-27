use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{decode, encodings, GuestEip, ImmediateKind, LinearAddress},
        lift::lift_cpu,
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn invalid_form_fixtures() {
    std::fs::create_dir_all("build/ir-invalid").unwrap();
    let mut cases = Vec::new();
    for e in encodings() {
        for mode in [false, true] {
            for memory in [false, true] {
                if !(if memory { e.mem_ud } else { e.reg_ud }) || memory && (!e.e || e.ignore_mod) {
                    continue;
                }
                let mut bytes = vec![0x46];
                if e.opcode > 65535 {
                    bytes.push((e.opcode >> 16) as u8);
                }
                if e.opcode > 255 {
                    bytes.push((e.opcode >> 8) as u8);
                }
                bytes.push(e.opcode as u8);
                if e.fetch_modrm {
                    bytes.push(
                        (e.group.max(0) as u8) << 3
                            | if memory {
                                if mode {
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
                            &0x7000u32.to_le_bytes()[..if mode { 4 } else { 2 }],
                        );
                    }
                }
                let width = if mode != (e.opcode >> 16 == 0x66) { 4 } else { 2 };
                let n = match e.immediate {
                    ImmediateKind::None => 0,
                    ImmediateKind::Byte | ImmediateKind::SignedByte => 1,
                    ImmediateKind::Word => 2,
                    ImmediateKind::Operand => width,
                    ImmediateKind::Address => {
                        if mode {
                            4
                        }
                        else {
                            2
                        }
                    },
                };
                bytes.extend(vec![0; n + e.extra_bytes as usize]);
                let d = decode(&bytes[1..], GuestEip(0x8001), LinearAddress(0x8001), mode).unwrap();
                assert!(d.baseline_ud);
                assert_eq!(d.length as usize, bytes.len() - 1);
                if cfg!(debug_assertions) && e.opcode == 0x0FAE && e.group == 2 && !memory {
                    assert!(
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err()
                    );
                    continue;
                }
                let mut r =
                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                for opt in 0..2 {
                    if opt == 1 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let mut mir = lower(&r).unwrap();
                    if opt == 1 {
                        mir.schedule_operand_stack(262144).unwrap();
                        mir.allocate_machine_locals(4000000).unwrap();
                    }
                    std::fs::write(
                        format!("build/ir-invalid/{}-{opt}.wasm", cases.len()),
                        emit_cpu(&mir, 100).unwrap().bytes,
                    )
                    .unwrap();
                }
                cases.push(format!(
                    "[{:?},{mode},{memory},{}]",
                    bytes,
                    if e.sse { 2 } else { e.task_switch_test as u32 }
                ));
            }
        }
    }
    std::fs::write(
        "build/ir-invalid/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
