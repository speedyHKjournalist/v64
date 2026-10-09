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
    use crate::cpu::features::{TEST_FEATURES, XSAVE, XSAVEC, XSAVEOPT, XSAVES};
    std::fs::create_dir_all("build/ir-fp-state").unwrap();
    TEST_FEATURES.with(|f| f.set(XSAVE | XSAVEOPT | XSAVEC | XSAVES));
    let mut cases = Vec::new();
    for mode in [false, true] {
        for address32 in [false, true] {
            // FXSAVE, FXRSTOR, LDMXCSR, STMXCSR, XSAVE, XRSTOR, XSAVEOPT (0F
            // AE); XRSTORS, XSAVEC, XSAVES (0F C7 /3, /4, /5: groups 11-13)
            for group in (0u8..7).chain(11..14) {
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
                        if group < 8 { 0xAE } else { 0xC7 },
                        (group & 7) << 3 | if address32 { 5 } else { 6 },
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
    TEST_FEATURES.with(|f| f.set(0));
}
