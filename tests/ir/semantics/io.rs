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
fn io_fixtures() {
    std::fs::create_dir_all("build/ir-io").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [8, 16, 32] {
            for asize in [16, 32] {
                for kind in 0..6 {
                    for seg in if kind >= 4 { (-1i32..6).collect::<Vec<_>>() } else { vec![-1] } {
                        for rep in if kind < 4 { vec![0, 0xF2, 0xF3] } else { vec![0] } {
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
                            if rep != 0 {
                                bytes.push(rep);
                            }
                            bytes.push(
                                [0xE4, 0xE6, 0xEC, 0xEE, 0x6C, 0x6E][kind] + u8::from(width != 8),
                            );
                            if kind < 2 {
                                bytes.push(0xE8);
                            }
                            let mut r =
                                lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                    .unwrap();
                            for opt in 0..2 {
                                if opt != 0 {
                                    run(&mut r, PassConfig::default()).unwrap();
                                }
                                std::fs::write(
                                    format!("build/ir-io/{}-{opt}.wasm", cases.len()),
                                    {
                                        let mut mir = lower(&r).unwrap();
                                        if opt != 0 {
                                            mir.elide_redundant_cpu_state_writes(
                                                crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                                            )
                                            .unwrap();
                                            mir.elide_dead_cpu_values(
                                                crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT,
                                            )
                                            .unwrap();
                                        }
                                        emit_cpu(&mir, 100).unwrap().bytes
                                    },
                                )
                                .unwrap();
                            }
                            cases.push(format!(
                                "[{:?},{mode},{width},{asize},{kind},{seg},{rep}]",
                                bytes
                            ));
                        }
                    }
                }
            }
        }
    }
    std::fs::write("build/ir-io/cases.json", format!("[{}]", cases.join(","))).unwrap();
}
#[test]
fn io_contract_boundaries() {
    for bytes in [&[0xE4, 0xE8][..], &[0xEE][..], &[0x6C][..], &[0x6E][..]] {
        assert!(lift(bytes, GuestEip(0), LinearAddress(0), true).is_err());
        let mut suffix = bytes.to_vec();
        suffix.push(0x90);
        assert_eq!(
            lift_cpu(&suffix, GuestEip(0), LinearAddress(0), true).is_ok(),
            bytes[0] >= 0xE4
        );
        if bytes[0] >= 0xE4 {
            let region = lift_cpu(&suffix, GuestEip(0), LinearAddress(0), true).unwrap();
            assert!(matches!(
                region.helpers[0].abi,
                crate::ir::helper::HelperAbi::CpuReload
            ));
            assert_eq!(
                region.helpers[0].results,
                vec![crate::ir::types::Type::I32; 14]
            );
            lower(&region).unwrap().verify().unwrap();
        }
        let mut lock = vec![0xF0];
        lock.extend(bytes);
        assert!(lift_cpu(&lock, GuestEip(0), LinearAddress(0), true).is_err());
    }
    for op in 0x6C..=0x6F {
        for rep in [0xF2, 0xF3] {
            assert!(lift_cpu(&[rep, op], GuestEip(0), LinearAddress(0), true)
                .unwrap()
                .helpers
                .iter()
                .any(|h| matches!(h.abi, crate::ir::helper::HelperAbi::CpuRep)));
        }
    }
    let r = lift_cpu(&[0x6F], GuestEip(0), LinearAddress(0), true).unwrap();
    let ordered = r
        .instructions
        .iter()
        .filter(|i| i.op.ordered())
        .map(|i| match i.op {
            Op::SegmentAddress { .. } => "segment",
            Op::GuestLoad { .. } => "load",
            Op::CallHelper(id) => r.helpers[id.index()].name.as_str(),
            _ => "other",
        })
        .collect::<Vec<_>>();
    assert_eq!(ordered, vec!["ir_outs_once"]);
    assert!(matches!(r.helpers[0].abi, crate::ir::helper::HelperAbi::CpuExit));
    for op in 0x6C..=0x6F {
        let r = lift_cpu(&[0x67, op], GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(r.helpers.len(), 1);
        assert_eq!(r.helpers[0].name, if op & 2 == 0 { "ir_ins_once" } else { "ir_outs_once" });
        assert!(matches!(r.helpers[0].abi, crate::ir::helper::HelperAbi::CpuExit));
        assert!(r.helpers[0].results.is_empty());
        lower(&r).unwrap().verify().unwrap();
    }
}
