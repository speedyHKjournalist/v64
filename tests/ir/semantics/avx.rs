use crate::ir::frontend::{
    decode::{GuestEip, LinearAddress},
    lift::{lift, lift_cpu},
};
/// AVX forms lift natively on the legacy SSE lifters (the AVX guard, the
/// destination's bits 255:128 zeroed; VZEROUPPER: those of YMM0-YMM7), to
/// the floating-point helper between XMM registers (ir_avx_fp_reg_continue:
/// the AVX guard, the destination reloaded, its bits 255:128 zeroed) or to
/// the AVX helper (ir_avx_continue), the region going on
#[test]
fn avx_forms_call_the_helper() {
    use crate::cpu::features::{ALL, TEST_FEATURES};
    use crate::ir::hir::Op;
    TEST_FEATURES.with(|f| f.set(ALL));
    // (the bytes, whether they have a memory operand, the helper, the
    // registers whose bits 255:128 are zeroed)
    let all: &[u8] = &[0, 1, 2, 3, 4, 5, 6, 7];
    for (bytes, memory, helper, zeroed) in [
        // vxorps xmm1, xmm2, xmm3
        (&[0xC5, 0xE8, 0x57, 0xCB][..], false, None, &[1u8][..]),
        // vmovups xmm4, [0x200000]
        (
            &[0xC5, 0xF8, 0x10, 0x25, 0x00, 0x00, 0x20, 0x00],
            true,
            None,
            &[4],
        ),
        // vpcmpeqq xmm2, xmm2, xmm5 (66 0F 38 29: not MOVAPS's store)
        (&[0xC4, 0xE2, 0x69, 0x29, 0xD5], false, None, &[2]),
        // vmovss xmm1, xmm2, xmm3 (11 /r: the destination is r/m)
        (&[0xC5, 0xEA, 0x11, 0xD9], false, None, &[1]),
        // vpsrlw xmm4, xmm5, 3 (the destination is VEX.vvvv)
        (&[0xC5, 0xD9, 0x71, 0xD5, 0x03], false, None, &[4]),
        // vpmovmskb eax, xmm1 (a general-purpose destination)
        (&[0xC5, 0xF9, 0xD7, 0xC1], false, None, &[]),
        // vpinsrw xmm1, xmm2, esi, 3
        (&[0xC5, 0xE9, 0xC4, 0xCE, 0x03], false, None, &[1]),
        // vaddsd xmm1, xmm2, xmm3
        (
            &[0xC5, 0xEB, 0x58, 0xCB],
            false,
            Some("ir_avx_fp_reg_continue"),
            &[1],
        ),
        // vzeroupper
        (&[0xC5, 0xF8, 0x77], false, None, all),
    ] {
        let native = helper != Some("ir_avx_continue");
        for mode in [false, true] {
            if memory && !mode {
                continue;
            }
            assert!(lift(bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err());
            let r = lift_cpu(bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                .unwrap_or_else(|e| panic!("{bytes:02X?}: {e:?}"));
            assert_eq!(
                r.helpers
                    .iter()
                    .map(|h| h.name.as_str())
                    .collect::<Vec<_>>(),
                helper.into_iter().collect::<Vec<_>>(),
                "{bytes:02X?}"
            );
            let ops = |f: fn(&Op) -> bool| r.instructions.iter().filter(|i| f(&i.op)).count();
            assert_eq!(
                ops(|op| matches!(op, Op::AvxCheck)),
                native as usize,
                "{bytes:02X?}"
            );
            let registers: Vec<u8> = r
                .instructions
                .iter()
                .filter_map(|i| match i.op {
                    Op::YmmZero { register } => Some(register),
                    _ => None,
                })
                .collect();
            assert_eq!(registers, zeroed, "{bytes:02X?}");
            assert_eq!(ops(|op| matches!(op, Op::SseCheck)), 0, "{bytes:02X?}");
            let mut suffix = bytes.to_vec();
            suffix.push(0x90);
            assert!(lift_cpu(&suffix, GuestEip(0x8000), LinearAddress(0x8000), mode).is_ok());
        }
    }
    TEST_FEATURES.with(|f| f.set(0));
}
/// A hot loop's CFG keeps the AVX forms (crate::ir::frontend::region)
#[test]
fn avx_forms_in_a_cfg() {
    use crate::cpu::features::{ALL, TEST_FEATURES};
    use crate::ir::frontend::region::lift_cpu_cfg;
    TEST_FEATURES.with(|f| f.set(ALL));
    // L: vxorps xmm1, xmm2, xmm3; vmovups xmm4, [0x200000]; vaddsd xmm1,
    // xmm2, xmm3; dec ecx; jnz L
    let bytes = [
        0xC5, 0xE8, 0x57, 0xCB, 0xC5, 0xF8, 0x10, 0x25, 0x00, 0x00, 0x20, 0x00, 0xC5, 0xEB, 0x58,
        0xCB, 0x49, 0x75, 0xED,
    ];
    let r = lift_cpu_cfg(&bytes, GuestEip(0x8000), LinearAddress(0x8000), true, 128).unwrap();
    assert_eq!(
        r.helpers
            .iter()
            .filter(|h| h.name == "ir_avx_fp_reg_continue")
            .count(),
        1
    );
    assert_eq!(
        r.instructions
            .iter()
            .filter(|i| matches!(i.op, crate::ir::hir::Op::YmmZero { .. }))
            .count(),
        3
    );
    let mut r = r;
    crate::ir::passes::run(&mut r, crate::ir::passes::PassConfig::default()).unwrap();
    let mut mir = crate::ir::lowering::lower(&r).unwrap();
    mir.schedule_operand_stack(262_144).unwrap();
    mir.allocate_machine_locals(4_000_000).unwrap();
    crate::ir::backend::wasm::emit_cpu(&mir, 100).unwrap();
    TEST_FEATURES.with(|f| f.set(0));
}

/// Fixtures for tests/ir/differential/avx.mjs: AVX forms (register, memory
/// load and store, general-purpose operands, VZEROUPPER, VLDMXCSR/VSTMXCSR,
/// VMASKMOVDQU; flags, VEX.vvvv as the destination, imm8[7:4] as a register,
/// ECX and XMM0 written by VPCMPxSTRx; floating point with MXCSR) in 16-
/// and 32-bit code, alone, after PADDD XMM2, XMM3 (an
/// XMM value the region holds) or INC ESI, INC EAX (general-purpose ones),
/// then PADDD XMM7 with the destination (the helper's result reloaded)
#[test]
fn avx_fixtures() {
    use crate::cpu::features::{AVX, SSE4_1, SSE4_2, SSSE3, TEST_FEATURES, XSAVE};
    use crate::ir::{
        backend::wasm::emit_cpu,
        lowering::lower,
        passes::{run, PassConfig},
    };
    std::fs::create_dir_all("build/ir-avx").unwrap();
    TEST_FEATURES.with(|f| f.set(SSSE3 | SSE4_1 | SSE4_2 | XSAVE | AVX));
    // (the VEX prefix and opcode, ModRM.reg, the r/m register or memory, the
    // XMM destination the suffix reads, imm8)
    #[rustfmt::skip]
    let forms: &[(&[u8], u8, Option<u8>, u8, &[u8])] = &[
        (&[0xC5, 0xE8, 0x57], 1, Some(3), 1, &[]),           // vxorps xmm1, xmm2, xmm3
        (&[0xC5, 0xF8, 0x10], 4, None, 4, &[]),              // vmovups xmm4, [m]
        (&[0xC5, 0xFA, 0x7F], 5, None, 1, &[]),              // vmovdqu [m], xmm5
        (&[0xC5, 0xF8, 0x29], 3, None, 1, &[]),              // vmovaps [m], xmm3
        (&[0xC5, 0xC2, 0x10], 6, Some(0), 6, &[]),           // vmovss xmm6, xmm7, xmm0
        (&[0xC5, 0xE8, 0x16], 1, None, 1, &[]),              // vmovhps xmm1, xmm2, [m]
        (&[0xC4, 0xE2, 0x79, 0x2A], 2, None, 2, &[]),        // vmovntdqa xmm2, [m]
        (&[0xC5, 0xF9, 0x7E], 2, Some(1), 1, &[]),           // vmovd ecx, xmm2
        (&[0xC5, 0xF9, 0x6E], 3, Some(6), 3, &[]),           // vmovd xmm3, esi
        (&[0xC5, 0xF9, 0x6E], 0, None, 0, &[]),              // vmovd xmm0, [m]
        (&[0xC5, 0xF9, 0xD7], 0, Some(1), 1, &[]),           // vpmovmskb eax, xmm1
        (&[0xC5, 0xF8, 0x77], 0, Some(0), 1, &[]),           // vzeroupper (no ModRM)
        (&[0xC5, 0xF8, 0xAE], 2, None, 1, &[]),              // vldmxcsr [m]
        (&[0xC5, 0xF8, 0xAE], 3, None, 1, &[]),              // vstmxcsr [m]
        (&[0xC5, 0xF9, 0xF7], 1, Some(2), 1, &[]),           // vmaskmovdqu xmm1, xmm2
        (&[0xC5, 0xE9, 0x74], 1, Some(3), 1, &[]),           // vpcmpeqb xmm1, xmm2, xmm3
        (&[0xC4, 0xE2, 0x51, 0x00], 4, None, 4, &[]),        // vpshufb xmm4, xmm5, [m]
        (&[0xC4, 0xE2, 0x79, 0x17], 1, Some(2), 1, &[]),     // vptest xmm1, xmm2 (flags)
        (&[0xC4, 0xE3, 0x79, 0x16], 2, Some(1), 1, &[3]),    // vpextrd ecx, xmm2, 3
        (&[0xC4, 0xE3, 0x79, 0x15], 2, None, 1, &[1]),       // vpextrw [m], xmm2, 1
        (&[0xC4, 0xE3, 0x59, 0x20], 3, Some(6), 3, &[5]),    // vpinsrb xmm3, xmm4, esi, 5
        (&[0xC5, 0xD1, 0x73], 3, Some(6), 5, &[3]),          // vpsrldq xmm5, xmm6, 3
        (&[0xC4, 0xE3, 0x71, 0x4C], 0, Some(2), 0, &[0x30]), // vpblendvb xmm0, xmm1, xmm2, xmm3
        (&[0xC4, 0xE3, 0x79, 0x63], 1, None, 1, &[0x0C]),    // vpcmpistri xmm1, [m], 0x0C
        (&[0xC4, 0xE3, 0x79, 0x60], 2, None, 0, &[0x40]),    // vpcmpestrm xmm2, [m], 0x40
        (&[0xC5, 0xEB, 0x58], 1, Some(3), 1, &[]),           // vaddsd xmm1, xmm2, xmm3
        (&[0xC5, 0xF8, 0x51], 4, None, 4, &[]),              // vsqrtps xmm4, [m]
        (&[0xC5, 0xF9, 0x2F], 1, Some(2), 1, &[]),           // vcomisd xmm1, xmm2 (flags)
        (&[0xC5, 0xFB, 0x2C], 1, Some(2), 1, &[]),           // vcvttsd2si ecx, xmm2
        (&[0xC5, 0xDB, 0x2A], 3, Some(6), 3, &[]),           // vcvtsi2sd xmm3, xmm4, esi
        (&[0xC5, 0xC8, 0xC2], 5, None, 5, &[0x1D]),          // vcmpps xmm5, xmm6, [m], GE_OQ
        (&[0xC4, 0xE3, 0x69, 0x0B], 1, None, 1, &[4]),       // vroundsd xmm1, xmm2, [m], 4
        (&[0xC4, 0xE3, 0x61, 0x40], 2, Some(4), 2, &[0xF1]), // vdpps xmm2, xmm3, xmm4, 0xF1
        (&[0xC4, 0xE3, 0x71, 0x4B], 0, None, 0, &[0x20]),    // vblendvpd xmm0, xmm1, [m], xmm2
        (&[0xC5, 0xF9, 0x5A], 6, Some(7), 6, &[]),           // vcvtpd2ps xmm6, xmm7
        (&[0xC4, 0xE2, 0x79, 0x18], 1, None, 1, &[]),        // vbroadcastss xmm1, [m]
        (&[0xC4, 0xE2, 0x69, 0x0C], 3, Some(4), 3, &[]),     // vpermilps xmm3, xmm2, xmm4
        (&[0xC4, 0xE3, 0x79, 0x05], 5, None, 5, &[2]),       // vpermilpd xmm5, [m], 2
        (&[0xC4, 0xE2, 0x79, 0x0E], 1, Some(2), 1, &[]),     // vtestps xmm1, xmm2 (flags)
        (&[0xC4, 0xE2, 0x69, 0x2C], 6, None, 6, &[]),        // vmaskmovps xmm6, xmm2, [m]
        (&[0xC4, 0xE2, 0x69, 0x2F], 7, None, 1, &[]),        // vmaskmovpd [m], xmm2, xmm7
        (&[0xC4, 0xE3, 0x71, 0x0C], 0, Some(0), 0, &[0x33]), // vblendps xmm0, xmm1, xmm0, 0x33
        (&[0xC4, 0xE2, 0x69, 0x29], 2, Some(5), 2, &[]),     // vpcmpeqq xmm2, xmm2, xmm5
        (&[0xC5, 0xEA, 0x11], 3, Some(1), 1, &[]),           // vmovss xmm1, xmm2, xmm3 (11 /r)
        (&[0xC5, 0xE9, 0xC4], 1, Some(6), 1, &[3]),          // vpinsrw xmm1, xmm2, esi, 3
        (&[0xC5, 0xF9, 0xC5], 1, Some(2), 1, &[1]),          // vpextrw ecx, xmm2, 1
        (&[0xC5, 0xF8, 0x50], 3, Some(4), 1, &[]),           // vmovmskps ebx, xmm4
        // (VEX.256, P6)
        (&[0xC5, 0xEC, 0x57], 1, Some(3), 1, &[]),           // vxorps ymm1, ymm2, ymm3
        (&[0xC5, 0xFC, 0x10], 4, None, 4, &[]),              // vmovups ymm4, [m]
        (&[0xC5, 0xFE, 0x7F], 5, None, 1, &[]),              // vmovdqu [m], ymm5
        (&[0xC4, 0xE3, 0x6D, 0x06], 1, Some(3), 1, &[0x31]), // vperm2f128 ymm1, ymm2, ymm3, 0x31
        (&[0xC4, 0xE3, 0x7D, 0x19], 2, Some(1), 1, &[1]),    // vextractf128 xmm1, ymm2, 1
        (&[0xC4, 0xE2, 0x6D, 0x2C], 6, None, 6, &[]),        // vmaskmovps ymm6, ymm2, [m]
        (&[0xC5, 0xFC, 0x77], 0, Some(0), 1, &[]),           // vzeroall (no ModRM)
        (&[0xC5, 0xEC, 0x58], 1, Some(3), 1, &[]),           // vaddps ymm1, ymm2, ymm3
        (&[0xC5, 0xCD, 0x5E], 5, None, 5, &[]),              // vdivpd ymm5, ymm6, [m]
        (&[0xC5, 0xCC, 0xC2], 5, None, 5, &[0x1D]),          // vcmpps ymm5, ymm6, [m], GE_OQ
        (&[0xC5, 0xDF, 0x7C], 3, Some(5), 3, &[]),           // vhaddps ymm3, ymm4, ymm5
        (&[0xC5, 0xFC, 0x53], 1, Some(2), 1, &[]),           // vrcpps ymm1, ymm2
        (&[0xC4, 0xE3, 0x7D, 0x09], 1, None, 1, &[4]),       // vroundpd ymm1, [m], 4
        (&[0xC4, 0xE3, 0x65, 0x40], 2, Some(4), 2, &[0xF1]), // vdpps ymm2, ymm3, ymm4, 0xF1
        (&[0xC5, 0xFE, 0x5B], 4, None, 4, &[]),              // vcvttps2dq ymm4, [m]
        (&[0xC5, 0xFE, 0xE6], 1, None, 1, &[]),              // vcvtdq2pd ymm1, [m] (m128)
        (&[0xC5, 0xFD, 0x5A], 6, Some(7), 6, &[]),           // vcvtpd2ps xmm6, ymm7
    ];
    let mut cases = Vec::new();
    for (form, &(head, reg, rm, destination, imm8)) in forms.iter().enumerate() {
        for mode in [false, true] {
            for prefix in 0..3 {
                let mut bytes = vec![];
                let mut count = 2;
                match prefix {
                    1 => bytes.extend([0x66, 0x0F, 0xFE, 0xD3]),
                    2 => {
                        bytes.extend([0x46, 0x40]);
                        count += 1;
                    },
                    _ => count -= 1,
                }
                bytes.extend_from_slice(head);
                let memory = rm.is_none();
                if head[head.len() - 1] != 0x77 {
                    match rm {
                        Some(r) => bytes.push(0xC0 | reg << 3 | r),
                        None if mode => {
                            bytes.push(reg << 3 | 5);
                            bytes.extend(0x6000u32.to_le_bytes());
                        },
                        None => {
                            bytes.push(reg << 3 | 6);
                            bytes.extend(0x6000u16.to_le_bytes());
                        },
                    }
                }
                bytes.extend_from_slice(imm8);
                // paddd xmm7, the destination
                bytes.extend([0x66, 0x0F, 0xFE, 0xF8 | destination]);
                count += 1;
                let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                    .unwrap_or_else(|e| panic!("{bytes:02X?}: {e:?}"));
                // (native, on a legacy lifter or the floating-point helper,
                // or the AVX helper)
                assert!(
                    r.helpers.iter().any(|h| h.name == "ir_avx_continue")
                        || r.instructions
                            .iter()
                            .any(|i| matches!(i.op, crate::ir::hir::Op::AvxCheck))
                );
                for opt in 0..2 {
                    if opt != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let mut mir = lower(&r).unwrap();
                    if opt != 0 {
                        mir.schedule_operand_stack(262_144).unwrap();
                        mir.allocate_machine_locals(4_000_000).unwrap();
                    }
                    std::fs::write(
                        format!("build/ir-avx/{}-{opt}.wasm", cases.len()),
                        emit_cpu(&mir, 100).unwrap().bytes,
                    )
                    .unwrap();
                }
                cases.push(format!("[{bytes:?},{mode},{count},{memory},{form}]"));
            }
        }
    }
    std::fs::write("build/ir-avx/cases.json", format!("[{}]", cases.join(","))).unwrap();
    TEST_FEATURES.with(|f| f.set(0));
}
