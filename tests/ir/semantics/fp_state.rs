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
fn fp_state_fixtures() {
    std::fs::create_dir_all("build/ir-fp-state").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for address32 in [false, true] {
            for group in 0u8..4 {
                for dirty in [false, true] {
                    let mut bytes = vec![0x46];
                    if dirty {
                        bytes.extend_from_slice(&[0x66, 0x0F, 0xEF, 0xC9]);
                    }
                    if mode != address32 {
                        bytes.push(0x67);
                    }
                    bytes.extend_from_slice(&[
                        0x0F,
                        0xAE,
                        group << 3 | if address32 { 5 } else { 6 },
                    ]);
                    bytes.extend_from_slice(
                        &0x6000u32.to_le_bytes()[..if address32 { 4 } else { 2 }],
                    );
                    assert!(lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err());
                    let mut r =
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                    for opt in 0..2 {
                        if opt != 0 {
                            run(&mut r, PassConfig::default()).unwrap();
                        }
                        std::fs::write(
                            format!("build/ir-fp-state/{}-{opt}.wasm", cases.len()),
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
                    cases.push(format!("[{:?},{mode},{group},{dirty}]", bytes));
                }
            }
        }
    }
    std::fs::write(
        "build/ir-fp-state/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
