use crate::ir::{
    backend::wasm::{emit, emit_cpu, StateLayout},
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    helper::{after_call, HelperAbi, Outcome},
    hir::{Op, Terminator},
    lowering::lower,
    passes::{run, PassConfig},
    verify::verify,
};
#[test]
fn system_stack_fixtures() {
    std::fs::create_dir_all("build/ir-system-stack").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for op in [
                0x06u32, 0x07, 0x0E, 0x16, 0x17, 0x1E, 0x1F, 0x9C, 0x9D, 0x0FA0, 0x0FA1, 0x0FA8,
                0x0FA9,
            ] {
                let mut bytes = vec![0x40, 0x64, 0x67];
                if mode == (width == 16) {
                    bytes.push(0x66);
                }
                if op > 255 {
                    bytes.push(0x0F);
                }
                bytes.push(op as u8);
                if op & 1 == 0 {
                    bytes.push(0x43);
                }
                let mut r =
                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                for opt in 0..2 {
                    if opt != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    std::fs::write(
                        format!("build/ir-system-stack/{}-{opt}.wasm", cases.len()),
                        emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                    )
                    .unwrap();
                }
                cases.push(format!("[{:?},{mode},{width},{op}]", bytes));
            }
        }
    }
    std::fs::write(
        "build/ir-system-stack/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn terminal_cpu_helper_contract() {
    for bytes in [&[0x9D][..], &[0x17][..], &[0x0F, 0xA1][..]] {
        assert!(lift(bytes, GuestEip(0), LinearAddress(0), true).is_err());
        let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        verify(&r).unwrap();
        let call=r.instructions.iter().find(|i|matches!(i.op,Op::CallHelper(id) if matches!(r.helpers[id.index()].abi,HelperAbi::CpuExit))).unwrap();
        let Op::CallHelper(id) = call.op
        else {
            unreachable!()
        };
        assert!(after_call(&r.helpers[id.index()], Outcome::Normal).is_err());
        assert!(after_call(&r.helpers[id.index()], Outcome::Yield).is_err());
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
        let state = call.state.unwrap();
        broken.states[state.index()].resume = crate::ir::state::ResumeKind::AfterInstruction;
        assert!(verify(&broken)
            .unwrap_err()
            .0
            .contains("CPU exit helper must terminate"));
        let mut broken = r.clone();
        broken.blocks[0].terminator = None;
        broken.append(
            crate::ir::ids::BlockId(0),
            Op::Const(1),
            vec![],
            &[crate::ir::types::Type::I32],
            None,
        );
        broken.terminate(crate::ir::ids::BlockId(0), Terminator::Exit(state));
        assert!(verify(&broken)
            .unwrap_err()
            .0
            .contains("CPU exit helper must terminate"));
        let mut followed = bytes.to_vec();
        followed.push(0x90);
        assert!(lift_cpu(&followed, GuestEip(0), LinearAddress(0), true).is_err());
    }
    let mut r = lift_cpu(&[0x06], GuestEip(0), LinearAddress(0), true).unwrap();
    r.instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::ReadSegment(_)))
        .unwrap()
        .op = Op::ReadSegment(6);
    assert!(verify(&r).unwrap_err().0.contains("segment selector"));
}
