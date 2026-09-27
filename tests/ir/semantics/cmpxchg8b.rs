use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    hir::{Op, RmwOrder},
    lowering::lower,
    passes::{run, PassConfig},
    state::ResumeKind,
    verify::verify,
};
#[test]
fn cmpxchg8b_fixtures() {
    std::fs::create_dir_all("build/ir-cmpxchg8b").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for asize in [16, 32] {
                for segment in -1..6 {
                    for prefix in [0, 0xF0, 0xF2, 0xF3] {
                        for head in [false, true] {
                            for operand in 0..8 {
                                let mut bytes = vec![if head { 0x47 } else { 0x90 }];
                                if (width == 32) != mode {
                                    bytes.push(0x66);
                                }
                                if (asize == 32) != mode {
                                    bytes.push(0x67);
                                }
                                if segment >= 0 {
                                    bytes.push(
                                        [0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][segment as usize],
                                    );
                                }
                                if prefix != 0 {
                                    bytes.push(prefix);
                                }
                                let displacement =
                                    if asize == 32 { operand == 5 } else { operand == 6 };
                                bytes.extend([
                                    0x0F,
                                    0xC7,
                                    8 | operand | if displacement { 0x40 } else { 0 },
                                ]);
                                if asize == 32 && operand == 4 {
                                    bytes.push(0x24);
                                }
                                if displacement {
                                    bytes.push(0);
                                }
                                let mut r =
                                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                                        .unwrap();
                                for opt in 0..2 {
                                    if opt != 0 {
                                        run(&mut r, PassConfig::default()).unwrap();
                                    }
                                    std::fs::write(
                                        format!("build/ir-cmpxchg8b/{}-{opt}.wasm", cases.len()),
                                        emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                                    )
                                    .unwrap();
                                }
                                cases.push(format!("[{:?},{mode},{width},{asize},{segment},{prefix},{head},{operand}]",bytes));
                            }
                        }
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-cmpxchg8b/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn cmpxchg8b_contract() {
    for prefix in [vec![], vec![0xF0]] {
        let mut bytes = prefix.clone();
        bytes.extend([0x0F, 0xC7, 0x0E]);
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert!(r.instructions.iter().any(|i|matches!(i.op,Op::CompareExchange8B{order} if order==if prefix.is_empty(){RmwOrder::Plain}else{RmwOrder::Locked})));
        let mut broken = r.clone();
        let map = broken.instructions.last().unwrap().state.unwrap();
        broken.states[map.index()].resume = ResumeKind::AfterInstruction;
        assert!(verify(&broken)
            .unwrap_err()
            .0
            .contains("CMPXCHG8B must terminate"));
        let mut broken = r.clone();
        broken.blocks[0].terminator = None;
        broken.append(
            crate::ir::ids::BlockId(0),
            Op::Const(0),
            vec![],
            &[crate::ir::types::Type::I32],
            None,
        );
        broken.blocks[0].terminator = r.blocks[0].terminator.clone();
        assert!(verify(&broken).is_err());
        assert!(emit(
            &lower(&r).unwrap(),
            StateLayout {
                gpr: 0,
                flags: 32,
                eip: 36,
                committed: 40,
                flag_operand: 44
            },
            100
        )
        .is_err());
        bytes.push(0x90);
        assert!(lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        let mut bytes = prefix;
        bytes.extend([0x0F, 0xC7, 0xC8]);
        let result = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true);
        if bytes[0] == 0xF0 {
            assert!(result.is_err());
        }
        else {
            assert!(result
                .unwrap()
                .helpers
                .iter()
                .any(|h| h.name == "ir_invalid_form"));
        }
    }
    let r = lift_cpu(&[0x90], GuestEip(0), LinearAddress(0), true).unwrap();
    let mut broken = r.clone();
    broken.states[0].flags.zero_is_lazy = Some(broken.states[0].gpr[0]);
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("zero lazy flag type"));
    let mut broken = r;
    broken.states[0].flags.zero_is_lazy = None;
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("incomplete raw zero state"));
}
