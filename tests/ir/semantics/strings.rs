use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn string_fixtures() {
    std::fs::create_dir_all("build/ir-strings").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [8, 16, 32] {
            for asize in [16, 32] {
                for family in [0xA4, 0xA6, 0xAA, 0xAC, 0xAE] {
                    for seg in -1i32..6 {
                        let mut bytes = vec![0x43];
                        if width != 8 && mode == (width == 16) {
                            bytes.push(0x66);
                        }
                        if mode != (asize == 32) {
                            bytes.push(0x67);
                        }
                        if seg >= 0 {
                            bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][seg as usize]);
                        }
                        bytes.push(family + u8::from(width != 8));
                        bytes.extend([0xB2, 0xA5]);
                        let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                            .unwrap();
                        for opt in 0..2 {
                            if opt != 0 {
                                run(&mut r, PassConfig::default()).unwrap();
                            }
                            std::fs::write(
                                format!("build/ir-strings/{}-{opt}.wasm", cases.len()),
                                emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                            )
                            .unwrap();
                        }
                        cases.push(format!(
                            "[{:?},{mode},{width},{asize},{family},{seg}]",
                            bytes
                        ));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-strings/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn string_order_and_repeat_dispatch() {
    for op in [0xA4, 0xA5, 0xA6, 0xA7, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF] {
        assert!(lift(&[op], GuestEip(0), LinearAddress(0), true).is_err());
        for prefix in [0xF0, 0xF2, 0xF3] {
            let result = lift_cpu(&[prefix, op], GuestEip(0), LinearAddress(0), true);
            if prefix == 0xF0 {
                assert!(result.is_err());
            }
            else {
                assert!(result
                    .unwrap()
                    .helpers
                    .iter()
                    .any(|h| matches!(h.abi, crate::ir::helper::HelperAbi::CpuRep)));
            }
        }
    }
    for (op, segments, loads, stores) in [
        (0xA4, vec![0, 3], 1, 1),
        (0xA6, vec![0, 3], 2, 0),
        (0xAA, vec![0], 0, 1),
        (0xAC, vec![3], 1, 0),
        (0xAE, vec![0, 0], 1, 0),
    ] {
        let r = lift_cpu(&[op], GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(
            r.instructions
                .iter()
                .filter_map(|i| if let Op::SegmentAddress { segment } = i.op {
                    Some(segment)
                }
                else {
                    None
                })
                .collect::<Vec<_>>(),
            segments
        );
        assert_eq!(
            r.instructions
                .iter()
                .filter(|i| matches!(i.op, Op::GuestLoad { .. }))
                .count(),
            loads
        );
        assert_eq!(
            r.instructions
                .iter()
                .filter(|i| matches!(i.op, Op::GuestStore { .. }))
                .count(),
            stores
        );
        for i in &r.instructions {
            if matches!(i.op, Op::GuestStore { .. }) {
                let fault = &r.states[i.state.unwrap().index()];
                let commit = &r.states[i.commit.unwrap().index()];
                assert_ne!(fault.gpr[7], commit.gpr[7]);
                assert_eq!(fault.committed_instructions, 0);
                assert_eq!(commit.committed_instructions, 1);
            }
        }
    }
}
