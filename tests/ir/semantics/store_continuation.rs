use crate::ir::{
    backend::wasm::emit_cpu_with_code_pages,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
        region::lift_cpu_cfg,
    },
    lowering::lower,
    passes::{run, PassConfig},
};

const PC: u32 = 0x0010_0000;
const CODE_PAGE: u32 = PC & !4095;

#[test]
fn scalar_store_continuation_fixtures() {
    let cases: [(&str, &[u8]); 8] = [
        ("continue", &[0x88, 0x11, 0x43]),
        ("rmw_continue", &[0xFF, 0x01, 0x43]),
        ("rmw_fault", &[0xFF, 0x01, 0x8B, 0x06]),
        ("fault_after", &[0x88, 0x11, 0x8B, 0x06]),
        ("store_load", &[0x88, 0x11, 0x8A, 0x19]),
        ("rmw_load8", &[0xFE, 0x01, 0x8A, 0x19]),
        ("rmw_load16", &[0x66, 0xFF, 0x01, 0x66, 0x8B, 0x19]),
        ("rmw_load32", &[0xFF, 0x01, 0x8B, 0x19]),
    ];
    std::fs::create_dir_all("build/ir-store-continuation").unwrap();
    for (name, bytes) in cases {
        for cfg in [false, true] {
            for optimize in [false, true] {
                let mut region = if cfg {
                    lift_cpu_cfg(bytes, GuestEip(PC), LinearAddress(PC), true, 64)
                }
                else {
                    lift_cpu(bytes, GuestEip(PC), LinearAddress(PC), true)
                }
                .unwrap();
                if optimize {
                    run(&mut region, PassConfig::default()).unwrap();
                }
                let mut mir = lower(&region).unwrap();
                if optimize {
                    let forwarded = mir
                        .forward_ram_reads(crate::ir::mir::forwarding::DEFAULT_WORK_LIMIT)
                        .unwrap();
                    if !cfg {
                        assert_eq!(
                            forwarded,
                            usize::from(name == "store_load" || name.starts_with("rmw_load"))
                        );
                    }
                }
                let artifact = emit_cpu_with_code_pages(&mir, 100, &[CODE_PAGE]).unwrap();
                std::fs::write(
                    format!(
                        "build/ir-store-continuation/{name}-{}.wasm",
                        u8::from(optimize) + 2 * u8::from(cfg)
                    ),
                    artifact.bytes,
                )
                .unwrap();
            }
        }
    }
}

#[test]
fn scalar_store_continuation_requires_valid_code_pages() {
    let region = lift_cpu(&[0x88, 0x11, 0x43], GuestEip(PC), LinearAddress(PC), true).unwrap();
    let mir = lower(&region).unwrap();
    assert!(emit_cpu_with_code_pages(&mir, 100, &[CODE_PAGE + 1]).is_err());
    assert!(emit_cpu_with_code_pages(&mir, 100, &[CODE_PAGE, CODE_PAGE]).is_err());
    assert!(emit_cpu_with_code_pages(
        &mir,
        100,
        &[
            0x0000_0000,
            0x0000_1000,
            0x0000_2000,
            0x0000_3000,
            0x0000_4000,
            0x0000_5000,
            0x0000_6000,
            0x0000_7000,
            0x0000_8000,
        ],
    )
    .is_err());
}

#[test]
fn vector_store_continuation_fixtures() {
    // Dirty XMM and GPR state precede each store. A later load is independently
    // made faulting by the CPU test. The final INC must be reachable through the
    // CFG frontend, not just the direct byte lifter.
    let cases: [(&str, &[u8]); 8] = [
        ("movss", &[0xF3, 0x0F, 0x11, 0x01]),
        ("movsd", &[0xF2, 0x0F, 0x11, 0x01]),
        ("movups", &[0x0F, 0x11, 0x01]),
        ("movd", &[0x66, 0x0F, 0x7E, 0x01]),
        ("movq", &[0x66, 0x0F, 0xD6, 0x01]),
        ("movhps", &[0x0F, 0x17, 0x01]),
        ("movntps", &[0x0F, 0x2B, 0x01]),
        ("maskmovdqu", &[0x66, 0x0F, 0xF7, 0xC1]),
    ];
    std::fs::create_dir_all("build/ir-vector-store").unwrap();
    for (name, store) in cases {
        let mut bytes = vec![0x66, 0x0F, 0xEF, 0xC2, 0x43]; // PXOR XMM0,XMM2; INC EBX.
        bytes.extend_from_slice(store);
        bytes.extend_from_slice(&[0x40, 0x8B, 0x16]); // INC EAX; MOV EDX,[ESI].
        std::fs::write(
            format!("build/ir-vector-store/{name}.json"),
            format!("{bytes:?}"),
        )
        .unwrap();
        for variant in 0..6 {
            let mut region = if variant < 2 {
                lift_cpu(&bytes, GuestEip(PC), LinearAddress(PC), true)
            }
            else {
                lift_cpu_cfg(&bytes, GuestEip(PC), LinearAddress(PC), true, 64)
            }
            .unwrap();
            // An incomplete region ending at the store would silently pass a
            // standalone-store differential; explicitly require the whole tail.
            assert!(region
                .states
                .iter()
                .any(|s| s.next_pc.0 == PC + bytes.len() as u32));
            if variant % 2 != 0 {
                run(&mut region, PassConfig::default()).unwrap();
            }
            let mir = lower(&region).unwrap();
            let artifact = if variant >= 4 {
                crate::ir::backend::wasm::emit_cpu(&mir, 100).unwrap()
            }
            else {
                // Include a second immutable source page: aliases of any
                // dependency, not only the current PC, must force an exit.
                emit_cpu_with_code_pages(&mir, 100, &[CODE_PAGE, CODE_PAGE + 0x2000]).unwrap()
            };
            std::fs::write(
                format!("build/ir-vector-store/{name}-{variant}.wasm"),
                artifact.bytes,
            )
            .unwrap();
        }
    }
}

#[test]
fn vector_store_continuation_rejects_forged_commit_state() {
    use crate::ir::{hir::Op, verify::verify};
    for bytes in [
        &[0x0F, 0x11, 0x01, 0x43][..],
        &[0x66, 0x0F, 0xF7, 0xC1, 0x43][..],
    ] {
        let region = lift_cpu(bytes, GuestEip(PC), LinearAddress(PC), true).unwrap();
        let commit = region
            .instructions
            .iter()
            .find(|i| matches!(i.op, Op::XmmStore { .. } | Op::XmmMaskedStore { .. }))
            .unwrap()
            .commit
            .unwrap();
        for field in 0..4 {
            let mut broken = region.clone();
            let state = &mut broken.states[commit.index()];
            match field {
                0 => state.gpr[0] = state.gpr[1],
                1 => state.xmm[0] = state.xmm[1],
                2 => state.flags.arithmetic[0] = state.flags.arithmetic[1],
                _ => state.committed_instructions += 1,
            }
            assert!(verify(&broken).is_err(), "forged vector commit {field}");
        }
    }
}
