use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn cpu_integer_memory_fixtures() {
    let mut forms: Vec<Vec<u8>> = vec![
        vec![0x8B, 0x11],
        vec![0x66, 0x8B, 0x11],
        vec![0x8A, 0x31],
        vec![0x89, 0x11],
        vec![0x66, 0x89, 0x11],
        vec![0x88, 0x31],
        vec![0xC7, 0x01, 0x12, 0x34, 0x56, 0x78],
        vec![0xC6, 0x01, 0xAB],
        vec![0x0F, 0xB6, 0x11],
        vec![0x0F, 0xBE, 0x11],
        vec![0x0F, 0xB7, 0x11],
        vec![0x0F, 0xBF, 0x11],
        vec![0x66, 0x0F, 0xBF, 0x11],
        vec![0x64, 0x8B, 0x11],
        vec![0x67, 0x8B, 0x10],
        vec![0x8B, 0x54, 0xB1, 0x7F],
    ];
    for group in 0..8u8 {
        for width in [8, 16, 32] {
            for direction in [0, 2] {
                let mut bytes = if width == 16 { vec![0x66] } else { vec![] };
                bytes.extend([group * 8 + direction + u8::from(width != 8), 0x11]);
                forms.push(bytes);
            }
        }
        for (prefix, opcode, immediate) in [
            (false, 0x80, vec![0x81]),
            (false, 0x82, vec![0x81]),
            (true, 0x82, vec![0x7F]),
            (true, 0x81, vec![0x01, 0x80]),
            (false, 0x81, vec![0x01, 0, 0, 0x80]),
            (true, 0x83, vec![0x80]),
            (false, 0x83, vec![0x80]),
        ] {
            let mut bytes = if prefix { vec![0x66] } else { vec![] };
            bytes.extend([opcode, group << 3 | 1]);
            bytes.extend(immediate);
            forms.push(bytes);
        }
    }
    for (op, group) in [(0xFE, 0), (0xFE, 1), (0xF6, 2), (0xF6, 3)] {
        for width in [8, 16, 32] {
            let mut bytes = if width == 16 { vec![0x66] } else { vec![] };
            bytes.extend([op + u8::from(width != 8), group << 3 | 1]);
            forms.push(bytes);
        }
    }
    for width in [8, 16, 32] {
        let mut bytes = if width == 16 { vec![0x66] } else { vec![] };
        bytes.extend([if width == 8 { 0x84 } else { 0x85 }, 0x11]);
        forms.push(bytes);
        for group in [0, 1] {
            let mut bytes = if width == 16 { vec![0x66] } else { vec![] };
            bytes.extend([if width == 8 { 0xF6 } else { 0xF7 }, group << 3 | 1]);
            bytes.extend(vec![0xA5; width / 8]);
            forms.push(bytes);
        }
    }
    for cc in 0..16 {
        forms.push(vec![0x0F, 0x90 | cc, 0x01]);
        forms.push(vec![0x0F, 0x40 | cc, 0x11]);
        forms.push(vec![0x66, 0x0F, 0x40 | cc, 0x11]);
    }
    std::fs::create_dir_all("build/ir-memory").unwrap();
    let mut cases = Vec::new();
    for (i, form) in forms.iter().enumerate() {
        let bytes: Vec<_> = [vec![0x40], form.clone(), vec![0x43]].concat();
        let mut r = lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), true).unwrap();
        for opt in 0..2 {
            if opt == 1 {
                run(&mut r, PassConfig::default()).unwrap();
            }
            let result = emit_cpu(&lower(&r).unwrap(), 100).unwrap();
            std::fs::write(format!("build/ir-memory/{i}-{opt}.wasm"), result.bytes).unwrap();
        }
        cases.push(format!("{:?}", bytes));
    }
    std::fs::write(
        "build/ir-memory/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn store_commit_and_cpu_abi_are_required() {
    use crate::ir::{
        backend::wasm::{emit, StateLayout},
        hir::Op,
        state::ResumeKind,
    };
    let r = lift_cpu(
        &[0x89, 0x11],
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
    )
    .unwrap();
    let mir = lower(&r).unwrap();
    assert!(emit(
        &mir,
        StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
        100
    )
    .is_err());
    let mut missing = r.clone();
    let store = missing
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::GuestStore { .. }))
        .unwrap();
    let commit = store.commit.take().unwrap();
    assert!(lower(&missing).is_err());
    let mut bad = r;
    bad.states[commit.index()].resume = ResumeKind::BeforeInstruction;
    assert!(lower(&bad).is_err());
}

#[test]
fn rmw_ticket_is_affine_and_cannot_cross_effects() {
    use crate::ir::{
        hir::{Definition, Op},
        types::Type,
        verify::verify,
    };
    let r = lift_cpu(
        &[0x01, 0x11],
        GuestEip(0x100000),
        LinearAddress(0x100000),
        true,
    )
    .unwrap();
    verify(&r).unwrap();
    let load = r
        .instructions
        .iter()
        .find(|i| matches!(i.op, Op::RmwLoad { .. }))
        .unwrap();
    let effect = *load.results.last().unwrap();
    let fault = load.state;
    let mut unmatched = r.clone();
    unmatched.blocks[0]
        .instructions
        .retain(|id| !matches!(unmatched.instructions[id.index()].op, Op::RmwStore { .. }));
    assert!(verify(&unmatched)
        .unwrap_err()
        .0
        .contains("uncommitted RMW"));
    let mut mismatched = r.clone();
    let store = mismatched
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::RmwStore { .. }))
        .unwrap();
    store.state = store.commit;
    assert!(verify(&mismatched)
        .unwrap_err()
        .0
        .contains("fault map mismatch"));
    let mut interrupted = r.clone();
    let b = interrupted.entries[0];
    let term = interrupted.blocks[0].terminator.take().unwrap();
    let value = interrupted.append(b, Op::PollBudget, vec![effect], &[Type::Effect], fault)[0];
    let Definition::Instruction(id, _) = interrupted.values[value.index()].definition
    else {
        panic!()
    };
    let appended = interrupted.blocks[0].instructions.pop().unwrap();
    assert_eq!(id, appended);
    let at = interrupted.blocks[0]
        .instructions
        .iter()
        .position(|id| matches!(interrupted.instructions[id.index()].op, Op::RmwLoad { .. }))
        .unwrap();
    interrupted.blocks[0].instructions.insert(at + 1, id);
    interrupted.terminate(b, term);
    assert!(verify(&interrupted)
        .unwrap_err()
        .0
        .contains("effect invalidates pending RMW"));
}
