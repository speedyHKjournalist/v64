use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    helper::HelperAbi,
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn selector_query_fixtures() {
    std::fs::create_dir_all("build/ir-selector-query").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for asize in [16, 32] {
                for op in [2, 3] {
                    for dest in 0..8 {
                        for operand in 0..15 {
                            let seg = if operand < 8 { -1 } else { operand - 9 };
                            let mut bytes = vec![0x40];
                            if (width == 32) != mode {
                                bytes.push(0x66);
                            }
                            if (asize == 32) != mode {
                                bytes.push(0x67);
                            }
                            if seg >= 0 {
                                bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][seg as usize]);
                            }
                            bytes.extend([
                                0x0F,
                                op,
                                dest << 3
                                    | if operand < 8 {
                                        0xC0 | operand as u8
                                    }
                                    else {
                                        if asize == 32 {
                                            6
                                        }
                                        else {
                                            7
                                        }
                                    },
                            ]);
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-selector-query/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!(
                                "[{:?},{mode},{width},{asize},{op},{operand},{seg},{dest}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-selector-query/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn selector_query_terminal_contract() {
    for op in [2, 3] {
        let bytes = [0x0F, op, 0xC0];
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        assert!(lift_cpu(&[0xF0, 0x0F, op, 0xC0], GuestEip(0), LinearAddress(0), true).is_err());
        assert!(lift_cpu(&[0x0F, op, 0xC0, 0x90], GuestEip(0), LinearAddress(0), true).is_err());
        let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert!(matches!(r.helpers[0].abi, HelperAbi::CpuExit));
    }
}
