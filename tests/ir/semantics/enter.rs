use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    hir::Op,
    lowering::lower,
    passes::{run, PassConfig},
    verify::verify,
};
#[test]
fn enter_fixtures() {
    std::fs::create_dir_all("build/ir-enter").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for width in [16, 32] {
            for nesting in [0u8, 1, 2, 3, 7, 15, 31, 32, 33, 255] {
                for size in [0u16, 1, 31, 4095, 65535] {
                    let mut bytes = vec![0x40];
                    if mode == (width == 16) {
                        bytes.push(0x66);
                    }
                    // Ignored segment/address prefixes must not change stack semantics.
                    bytes.extend([0x64, 0x67, 0xC8]);
                    bytes.extend(size.to_le_bytes());
                    bytes.extend([nesting, 0x43]);
                    let mut r = lift_cpu(&bytes, GuestEip(0x100000), LinearAddress(0x100000), mode)
                        .unwrap();
                    for opt in 0..2 {
                        if opt != 0 {
                            run(&mut r, PassConfig::default()).unwrap();
                        }
                        std::fs::write(
                            format!("build/ir-enter/{}-{opt}.wasm", cases.len()),
                            emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                        )
                        .unwrap();
                    }
                    cases.push(format!("[{:?},{mode},{width},{size},{nesting}]", bytes));
                }
            }
        }
    }
    std::fs::write(
        "build/ir-enter/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn enter_nesting_mask_and_fault_policy() {
    for raw in 0..=255u8 {
        let r = lift_cpu(&[0xC8, 0, 0, raw], GuestEip(0), LinearAddress(0), true).unwrap();
        verify(&r).unwrap();
        assert_eq!(
            r.instructions
                .iter()
                .filter(|i| matches!(i.op, Op::PartialStore { .. }))
                .count(),
            (raw & 31) as usize
        );
        assert_eq!(
            r.instructions.iter().filter(|i| i.trap_after_fault).count(),
            (raw & 31) as usize + (raw & 31).saturating_sub(1) as usize
        );
        assert!(r
            .instructions
            .iter()
            .filter(|i| matches!(i.op, Op::GuestStore { .. }))
            .all(|i| !i.trap_after_fault));
    }
    let r = lift_cpu(&[0xC8, 0, 0, 3], GuestEip(0), LinearAddress(0), true).unwrap();
    let mut broken = r.clone();
    broken
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::GuestStore { .. }))
        .unwrap()
        .trap_after_fault = true;
    assert!(verify(&broken).unwrap_err().0.contains("fault trap policy"));
    let mut broken = r.clone();
    let read = broken
        .instructions
        .iter()
        .filter(|i| matches!(i.op, Op::GuestLoad { .. }))
        .nth(1)
        .unwrap()
        .state
        .unwrap();
    broken.states[read.index()].instruction_pc = GuestEip(8);
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("crossed guest instruction"));
    let mut broken = r.clone();
    broken
        .instructions
        .iter_mut()
        .find(|i| matches!(i.op, Op::GuestLoad { .. }))
        .unwrap()
        .unmasked_word_store = true;
    assert!(verify(&broken)
        .unwrap_err()
        .0
        .contains("unmasked word payload"));
    let mut word = lift_cpu(&[0x66, 0xC8, 0, 0, 1], GuestEip(0), LinearAddress(0), true).unwrap();
    word.instructions
        .iter_mut()
        .find(|i| i.unmasked_word_store)
        .unwrap()
        .unmasked_word_store = false;
    assert!(verify(&word).unwrap_err().0.contains("store types"));
    assert!(crate::ir::dump::text(&r).contains("trap_after_fault=true"));
}
