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
fn cpu_stack_fixtures() {
    std::fs::create_dir_all("build/ir-stack").unwrap();
    let mut cases = Vec::new();
    for mode32 in [false, true] {
        for width in [16, 32] {
            let mut forms = Vec::new();
            for reg in 0..8 {
                forms.push((format!("push_r{reg}"), vec![0x50 + reg], None));
                forms.push((format!("pop_r{reg}"), vec![0x58 + reg], None));
            }
            for (name, op) in [("pusha", 0x60), ("popa", 0x61), ("leave", 0xC9)] {
                forms.push((name.into(), vec![op], None));
            }
            let mut immediate = vec![0x68];
            immediate.extend(&0x89ABCDEFu32.to_le_bytes()[..width / 8]);
            forms.push(("push_imm".into(), immediate, None));
            forms.push(("push_imm8".into(), vec![0x6A, 0x80], None));
            forms.push(("push_ff_esp".into(), vec![0xFF, 0xF4], None));
            forms.push(("pop_8f_esp".into(), vec![0x8F, 0xC4], None));
            forms.push(("push_mem".into(), vec![0xFF, 0x31], Some(true)));
            forms.push(("push_mem_esp".into(), vec![0xFF, 0x34, 0x24], Some(true)));
            forms.push(("pop_mem".into(), vec![0x8F, 0x01], Some(true)));
            forms.push(("pop_mem_esp".into(), vec![0x8F, 0x04, 0x24], Some(true)));
            forms.push((
                "pop_mem_esp_disp".into(),
                vec![0x8F, 0x44, 0x24, 0x04],
                Some(true),
            ));
            forms.push(("pop_mem16".into(), vec![0x8F, 0x00], Some(false)));
            forms.push(("pop_fs".into(), vec![0x64, 0x8F, 0x01], Some(true)));
            for (name, instruction, address32) in forms {
                let mut bytes = vec![0x40];
                if mode32 == (width == 16) {
                    bytes.push(0x66);
                }
                if address32.is_some_and(|a| a != mode32) {
                    bytes.push(0x67);
                }
                bytes.extend(instruction);
                bytes.push(0x43);
                let mut r =
                    lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode32).unwrap();
                for opt in 0..2 {
                    if opt == 1 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let artifact = emit_cpu(&lower(&r).unwrap(), 100).unwrap();
                    std::fs::write(
                        format!("build/ir-stack/{}-{opt}.wasm", cases.len()),
                        artifact.bytes,
                    )
                    .unwrap();
                }
                cases.push(format!("[{:?},{mode32},{width},\"{name}\"]", bytes));
            }
        }
    }
    std::fs::write(
        "build/ir-stack/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}

#[test]
fn partial_stack_stores_require_same_instruction_commit() {
    use crate::ir::{hir::Op, verify::verify};
    let r = lift_cpu(
        &[0x40, 0x60, 0x43],
        GuestEip(0x8000),
        LinearAddress(0x8000),
        true,
    )
    .unwrap();
    verify(&r).unwrap();
    let partial = r
        .instructions
        .iter()
        .position(|i| matches!(i.op, Op::PartialStore { .. }))
        .unwrap();
    let last = r
        .instructions
        .iter()
        .position(|i| matches!(i.op, Op::GuestStore { .. }))
        .unwrap();
    let check = r
        .instructions
        .iter()
        .position(|i| matches!(i.op, Op::GuestCheck { .. }))
        .unwrap();
    let mut broken = r.clone();
    broken.blocks[0]
        .instructions
        .retain(|id| id.index() != last);
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("uncommitted partial"));
    let mut broken = r.clone();
    let state = broken.instructions[last].state.unwrap();
    broken.states[state.index()].instruction_pc = GuestEip(0x9000);
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("crossed guest instruction"));
    let mut broken = r.clone();
    let commit = broken.instructions[last].commit.unwrap();
    broken.states[commit.index()].committed_instructions += 1;
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("partial store commit mismatch"));
    let mut broken = r.clone();
    broken.instructions[check].op = Op::GuestCheck {
        bytes: 0,
        write: true,
    };
    assert!(verify(&broken).unwrap_err().0.contains("preflight"));
    let mut broken = r.clone();
    broken.instructions[partial].commit = r.instructions[last].commit;
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("other operations cannot commit"));
}
