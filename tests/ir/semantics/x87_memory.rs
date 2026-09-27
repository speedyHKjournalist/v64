use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn x87_memory_fixtures() {
    std::fs::create_dir_all("build/ir-x87-memory").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for opcode in 0xD8u8..=0xDF {
                for group in 0u8..8 {
                    let mut bytes = vec![0x46];
                    if mode != (width == 32) {
                        bytes.push(0x66);
                    }
                    bytes.extend_from_slice(&[opcode, group << 3 | if mode { 5 } else { 6 }]);
                    bytes.extend_from_slice(&0x6000u32.to_le_bytes()[..if mode { 4 } else { 2 }]);
                    assert!(lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err());
                    let mut r =
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                    if crate::ir::x87::io(opcode, group << 3).is_some() {
                        assert!(r.helpers.is_empty());
                    }
                    else {
                        assert_eq!(r.helpers.last().unwrap().name, "ir_x87_mem");
                    }
                    for opt in 0..2 {
                        if opt != 0 {
                            run(&mut r, PassConfig::default()).unwrap();
                        }
                        std::fs::write(
                            format!("build/ir-x87-memory/{}-{opt}.wasm", cases.len()),
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
                    let invalid = matches!((opcode, group), (0xD9, 1) | (0xDB, 4 | 6) | (0xDD, 5));
                    let unimpl = opcode == 0xDF && group == 4
                        || opcode == 0xDD && matches!(group, 4 | 6) && width == 16;
                    cases.push(format!(
                        "[{:?},{mode},{width},{opcode},{group},{invalid},{unimpl}]",
                        bytes
                    ));
                }
            }
        }
    }
    std::fs::write(
        "build/ir-x87-memory/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
