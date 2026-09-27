use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    types::Type,
    verify::verify,
};
fn emit_pair(bytes: &[u8], mode: bool, pc: u32, name: &str) {
    let mut r = lift_cpu(bytes, GuestEip(pc), LinearAddress(pc), mode).unwrap();
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-moves/{name}-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_move_fixtures() {
    std::fs::create_dir_all("build/ir-simd-moves").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for asize in [16, 32] {
            for op in [
                0x0F10u32, 0x0F11, 0x660F10, 0x660F11, 0xF20F10, 0xF20F11, 0xF30F10, 0xF30F11,
                0x0F28, 0x0F29, 0x660F28, 0x660F29, 0x660F6F, 0x660F7F, 0xF30F6F, 0xF30F7F,
            ] {
                let store = matches!(op & 255, 0x11 | 0x29 | 0x7F);
                let width = if matches!(op, 0xF30F10 | 0xF30F11) {
                    4
                }
                else if matches!(op, 0xF20F10 | 0xF20F11) {
                    8
                }
                else {
                    16
                };
                for register in 0..8 {
                    for operand in 0..15 {
                        let segment = if operand < 8 { -1 } else { operand - 9 };
                        let mut bytes = vec![0x43];
                        if (asize == 32) != mode {
                            bytes.push(0x67);
                        }
                        if segment >= 0 {
                            bytes.push([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65][segment as usize]);
                        }
                        if op > 65535 {
                            bytes.push((op >> 16) as u8);
                        }
                        bytes.extend([
                            0x0F,
                            op as u8,
                            (register << 3)
                                | if operand < 8 {
                                    0xC0 | operand as u8
                                }
                                else if asize == 32 {
                                    0x86
                                }
                                else {
                                    0x85
                                },
                        ]);
                        if operand >= 8 {
                            bytes.extend(if asize == 32 { vec![0, 0, 0, 0] } else { vec![0, 0] });
                        }
                        emit_pair(&bytes, mode, 0x8000, &cases.len().to_string());
                        cases.push(format!("[{:?},{mode},{asize},{op},{width},{store},{register},{operand},{segment}]",bytes));
                    }
                }
            }
        }
    }
    std::fs::write(
        "build/ir-simd-moves/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    let chain = [
        0x0F, 0x10, 0xFE, 0xF3, 0x0F, 0x10, 0xCA, 0x0F, 0x10, 0x06, 0xF2, 0x0F, 0x10, 0xDC, 0x0F,
        0x11, 0x07,
    ];
    emit_pair(&chain, true, 0x8000, "chain");
    emit_pair(&chain[10..], true, 0x800A, "resume");
    std::fs::write("build/ir-simd-moves/chain.json", format!("{:?}", chain)).unwrap();
    // Two coalesced vector parameters swap their input slots across an edge.
    let mut r = lift_cpu(
        &[0x0F, 0x10, 0xC0],
        GuestEip(0x8000),
        LinearAddress(0x8000),
        true,
    )
    .unwrap();
    let mut map = r.states.last().unwrap().clone();
    let first = map.xmm[0];
    let second = map.xmm[1];
    let join = r.block(false);
    let a = r.param(join, Type::V128);
    let b = r.param(join, Type::V128);
    map.xmm[0] = a;
    map.xmm[1] = b;
    let map = r.state(map);
    r.blocks[join.index()].entry_state = Some(map);
    r.blocks[0].terminator = Some(crate::ir::hir::Terminator::Branch(crate::ir::hir::Edge {
        target: join,
        args: vec![second, first],
    }));
    r.terminate(join, crate::ir::hir::Terminator::Exit(map));
    let mir = lower(&r).unwrap();
    assert_eq!(
        mir.allocation.value_local[first.index()],
        mir.allocation.value_local[a.index()]
    );
    assert_eq!(
        mir.allocation.value_local[second.index()],
        mir.allocation.value_local[b.index()]
    );
    for opt in 0..2 {
        if opt != 0 {
            run(&mut r, PassConfig::default()).unwrap();
        }
        std::fs::write(
            format!("build/ir-simd-moves/edge-{opt}.wasm"),
            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
        )
        .unwrap();
    }
}
#[test]
fn simd_move_state_and_types() {
    let bytes = [0xF3, 0x0F, 0x10, 0xC1];
    let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
    assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
    assert!(r.states.iter().all(|s| s.xmm.len() == 8));
    assert!(lower(&r)
        .unwrap()
        .allocation
        .local_types
        .contains(&Type::V128));
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
    let mut broken = r.clone();
    broken.states[0].xmm[0] = broken.states[0].gpr[0];
    assert!(verify(&broken).unwrap_err().0.contains("XMM state type"));
    let mut broken = r.clone();
    let inst = broken
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::VectorExtract { .. }))
        .unwrap();
    inst.op = Op::VectorExtract { bits: 32, lane: 4 };
    assert!(verify(&broken).unwrap_err().0.contains("vector extract"));
    let mut broken = r;
    broken.states[0].xmm.pop();
    assert!(verify(&broken).unwrap_err().0.contains("partial XMM"));
    let mut r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
    let map = crate::ir::ids::StateId((r.states.len() - 1) as u32);
    r.states[map.index()].resume = crate::ir::state::ResumeKind::BeforeInstruction;
    let input = r.states[map.index()].xmm[0];
    let effect = *r
        .instructions
        .iter()
        .rev()
        .find(|i| i.op.ordered())
        .unwrap()
        .results
        .last()
        .unwrap();
    let mut helper = crate::ir::helper::HelperDescriptor::conservative(
        "vector_helper".into(),
        vec![Type::V128],
        vec![],
    );
    helper.abi = crate::ir::helper::HelperAbi::Outcome {
        fault_delivery: None,
        normal_preserves_state: true,
    };
    r.helpers.push(helper);
    r.blocks[0].terminator = None;
    r.append(
        crate::ir::ids::BlockId(0),
        Op::CallHelper(crate::ir::ids::HelperId(0)),
        vec![input, effect],
        &[Type::Effect],
        Some(map),
    );
    r.terminate(
        crate::ir::ids::BlockId(0),
        crate::ir::hir::Terminator::Exit(map),
    );
    assert_eq!(
        lower(&r).err().unwrap(),
        crate::ir::lowering::CompileError::Unsupported(
            "vector helper requires explicit scratch ABI"
        )
    );
    for op in [0x10, 0x11, 0x28, 0x29] {
        assert!(lift_cpu(&[0xF0, 0x0F, op, 0xC0], GuestEip(0), LinearAddress(0), true).is_err());
    }
    let r = lift_cpu(
        &[0x0F, 0x11, 0x06, 0x43],
        GuestEip(0),
        LinearAddress(0),
        true,
    )
    .unwrap();
    assert_eq!(
        r.states.last().unwrap().committed_instructions,
        2,
        "vector store retains following instruction; runtime code proof controls continuation"
    );
}
