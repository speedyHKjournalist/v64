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
fn far_control_fixtures() {
    std::fs::create_dir_all("build/ir-far-control").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for address32 in [false, true] {
                for name in [
                    "call", "jump", "call_mem", "jump_mem", "call_ud", "jump_ud", "ret", "ret_imm",
                    "int3", "int", "into", "iret", "les_ud", "lds_ud", "lss_ud", "lfs_ud",
                    "lgs_ud",
                ] {
                    let mut bytes = vec![0x46];
                    if mode != (width == 32) {
                        bytes.push(0x66);
                    }
                    if mode != address32 {
                        bytes.push(0x67);
                    }
                    match name {
                        "call" | "jump" => {
                            bytes.push(if name == "call" { 0x9A } else { 0xEA });
                            bytes.extend_from_slice(&0xA000u32.to_le_bytes()[..width / 8]);
                            bytes.extend_from_slice(&0x18u16.to_le_bytes());
                        },
                        "call_mem" | "jump_mem" => {
                            bytes.extend_from_slice(&[
                                0xFF,
                                (if name == "call_mem" { 3 } else { 5 }) << 3
                                    | if address32 { 5 } else { 6 },
                            ]);
                            bytes.extend_from_slice(
                                &0x7000u32.to_le_bytes()[..if address32 { 4 } else { 2 }],
                            );
                        },
                        "call_ud" | "jump_ud" => bytes.extend_from_slice(&[
                            0xFF,
                            if name == "call_ud" { 0xD8 } else { 0xE8 },
                        ]),
                        "les_ud" => bytes.extend_from_slice(&[0xC4, 0xC0]),
                        "lds_ud" => bytes.extend_from_slice(&[0xC5, 0xC0]),
                        "lss_ud" => bytes.extend_from_slice(&[0x0F, 0xB2, 0xC0]),
                        "lfs_ud" => bytes.extend_from_slice(&[0x0F, 0xB4, 0xC0]),
                        "lgs_ud" => bytes.extend_from_slice(&[0x0F, 0xB5, 0xC0]),
                        "ret" => bytes.push(0xCB),
                        "ret_imm" => bytes.extend_from_slice(&[0xCA, 6, 0]),
                        "int3" => bytes.push(0xCC),
                        "int" => bytes.extend_from_slice(&[0xCD, 0x30]),
                        "into" => bytes.push(0xCE),
                        "iret" => bytes.push(0xCF),
                        _ => unreachable!(),
                    }
                    assert!(lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err());
                    let mut r =
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                    assert!(r
                        .helpers
                        .iter()
                        .all(|h| matches!(h.abi, HelperAbi::CpuExit)));
                    let mut suffix = bytes.clone();
                    suffix.push(0x90);
                    assert!(
                        lift_cpu(&suffix, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err()
                    );
                    let mut locked = vec![0xF0];
                    locked.extend_from_slice(&bytes[1..]);
                    assert!(
                        lift_cpu(&locked, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err()
                    );
                    for opt in 0..2 {
                        if opt != 0 {
                            run(&mut r, PassConfig::default()).unwrap();
                        }
                        std::fs::write(
                            format!("build/ir-far-control/{}-{opt}.wasm", cases.len()),
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
                    cases.push(format!("[{:?},{mode},{width},{name:?}]", bytes));
                }
            }
        }
    }
    std::fs::write(
        "build/ir-far-control/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
