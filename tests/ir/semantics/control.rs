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
fn near_control_fixtures() {
    std::fs::create_dir_all("build/ir-control").unwrap();
    let mut cases = Vec::new();
    for mode32 in [false, true] {
        for width in [16, 32] {
            let mut forms = Vec::new();
            for reg in 0..8 {
                forms.push((
                    format!("call_r{reg}"),
                    vec![0xFF, 0xD0 | reg],
                    false,
                    0x8000,
                ));
                forms.push((format!("jmp_r{reg}"), vec![0xFF, 0xE0 | reg], false, 0x8000));
            }
            for (name, modrm, sib) in [
                ("call_mem", 0x11, None),
                ("jmp_mem", 0x21, None),
                ("call_esp_mem", 0x14, Some(0x24)),
                ("jmp_esp_mem", 0x24, Some(0x24)),
            ] {
                let mut bytes = vec![0xFF, modrm];
                bytes.extend(sib);
                forms.push((name.into(), bytes, true, 0x8000));
            }
            forms.push((
                "call_overlap".into(),
                vec![0xFF, 0x54, 0x24, 0u8.wrapping_sub((width / 8) as u8)],
                true,
                0x8000,
            ));
            for (name, pc, disp) in [
                ("call_rel", 0x8000, -8i32),
                ("call_forward", 0x8000, 0x100),
                ("call_wrap", 0xFFF0, 0x100),
            ] {
                if name == "call_wrap" && width != 16 {
                    continue;
                }
                let mut bytes = vec![0xE8];
                bytes.extend(&disp.to_le_bytes()[..width / 8]);
                forms.push((name.into(), bytes, false, pc));
            }
            forms.push(("ret".into(), vec![0xC3], false, 0x8000));
            forms.push(("ret_imm".into(), vec![0xC2, 0xFC, 0xFF], false, 0x8000));
            for (name, instruction, address32, pc) in forms {
                let mut bytes = vec![0x40];
                if mode32 == (width == 16) {
                    bytes.push(0x66);
                }
                if address32 && !mode32 {
                    bytes.push(0x67);
                }
                bytes.extend(instruction);
                let mut r = lift_cpu(&bytes, GuestEip(pc), LinearAddress(pc), mode32).unwrap();
                for opt in 0..2 {
                    if opt == 1 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let artifact = emit_cpu(&lower(&r).unwrap(), 100).unwrap();
                    std::fs::write(
                        format!("build/ir-control/{}-{opt}.wasm", cases.len()),
                        artifact.bytes,
                    )
                    .unwrap();
                }
                cases.push(format!("[{:?},{mode32},{width},\"{name}\",{pc}]", bytes));
            }
        }
    }
    std::fs::write(
        "build/ir-control/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
    assert!(lift_cpu(&[0xC3, 0x90], GuestEip(0), LinearAddress(0), true).is_err());
}

#[test]
fn dynamic_eip_is_verified_and_kept_alive_by_state_maps() {
    use crate::ir::{
        backend::wasm::{emit, StateLayout},
        hir::{Binary, Op},
        types::Type,
        verify::verify,
    };
    let mut r = lift_cpu(&[0xFF, 0xE1], GuestEip(0x1000), LinearAddress(0x1000), true).unwrap();
    let b = r.entries[0];
    let term = r.blocks[b.index()].terminator.take().unwrap();
    let a = r.append(b, Op::Const(13), vec![], &[Type::I32], None)[0];
    let c = r.append(b, Op::Const(29), vec![], &[Type::I32], None)[0];
    let target = r.append(b, Op::Binary(Binary::Add), vec![a, c], &[Type::I32], None)[0];
    let crate::ir::hir::Terminator::Exit(map) = term
    else {
        panic!()
    };
    r.states[map.index()].next_value = Some(target);
    r.terminate(b, crate::ir::hir::Terminator::Exit(map));
    run(
        &mut r,
        PassConfig {
            debug: Default::default(),
            disabled: 0,
            prune: false,
            merge: false,
            phis: false,
            copy: false,
            flags: false,
            state_sync: false,
            helper_state: false,
            fold: false,
            gvn: false,
            dce: true,
            rounds: 1,
        },
    )
    .unwrap();
    verify(&r).unwrap();
    let code = emit(
        &lower(&r).unwrap(),
        StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
        100,
    )
    .unwrap();
    std::fs::create_dir_all("build/ir-control").unwrap();
    std::fs::write("build/ir-control/dynamic-exit.wasm", code.bytes).unwrap();
    let mut bad = r.clone();
    bad.states[map.index()].resume = crate::ir::state::ResumeKind::BeforeInstruction;
    assert!(verify(&bad).unwrap_err().0.contains("dynamic EIP"));
    let mut bad = r;
    bad.states[map.index()].next_value = Some(bad.states[map.index()].flags.arithmetic[0]);
    assert!(verify(&bad).unwrap_err().0.contains("dynamic EIP"));
}
