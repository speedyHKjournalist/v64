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
fn descriptor_fixtures() {
    std::fs::create_dir_all("build/ir-descriptor").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for asize in [16, 32] {
                for group in [0, 1, 2, 3, 4, 6, 7] {
                    for operand in 0..15 {
                        for rep in [0, 0xF2, 0xF3] {
                            let seg = if operand < 8 { -1 } else { operand - 9 };
                            let mut bytes = vec![0x40];
                            if (width == 32) != mode {
                                bytes.push(0x66);
                            }
                            if (asize == 32) != mode {
                                bytes.push(0x67);
                            }
                            if rep != 0 {
                                bytes.push(rep);
                            }
                            if seg >= 0 {
                                bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][seg as usize]);
                            }
                            bytes.extend([
                                0x0F,
                                0x01,
                                group << 3
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
                                    format!("build/ir-descriptor/{}-{opt}.wasm", cases.len()),
                                    emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                )
                                .unwrap();
                            }
                            cases.push(format!(
                                "[{:?},{mode},{width},{asize},{group},{operand},{seg},{rep}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-descriptor/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn descriptor_terminal_contract() {
    for group in [0, 1, 2, 3, 4, 6, 7] {
        for reg in [false, true] {
            let bytes = [0x0F, 0x01, group << 3 | if reg { 0xC0 } else { 6 }];
            assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
            let mut lock = vec![0xF0];
            lock.extend(bytes);
            assert!(lift_cpu(&lock, GuestEip(0), LinearAddress(0), true).is_err());
            let mut suffix = bytes.to_vec();
            suffix.push(0x90);
            assert!(lift_cpu(&suffix, GuestEip(0), LinearAddress(0), true).is_err());
            let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
            assert!(matches!(r.helpers.last().unwrap().abi, HelperAbi::CpuExit));
        }
    }
}
