use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    lowering::lower,
    passes::{run, PassConfig},
};
/// BMI1 and BMI2's VEX forms: name, VEX map, pp, opcode, ModRM.reg (ECX, or
/// the group of BLSR, BLSMSK and BLSI), VEX.vvvv (EDX; ECX, the destination
/// of BLSR, BLSMSK and BLSI; EBX, MULX's low half; None: 1111b), imm8
const VEX_FORMS: [(&str, u8, u8, u8, u8, Option<u8>, Option<u8>); 13] = [
    ("andn", 2, 0, 0xF2, 1, Some(2), None),
    ("blsr", 2, 0, 0xF3, 1, Some(1), None),
    ("blsmsk", 2, 0, 0xF3, 2, Some(1), None),
    ("blsi", 2, 0, 0xF3, 3, Some(1), None),
    ("bzhi", 2, 0, 0xF5, 1, Some(2), None),
    ("pext", 2, 2, 0xF5, 1, Some(2), None),
    ("pdep", 2, 3, 0xF5, 1, Some(2), None),
    ("mulx", 2, 3, 0xF6, 1, Some(3), None),
    ("bextr", 2, 0, 0xF7, 1, Some(2), None),
    ("shlx", 2, 1, 0xF7, 1, Some(2), None),
    ("sarx", 2, 2, 0xF7, 1, Some(2), None),
    ("shrx", 2, 3, 0xF7, 1, Some(2), None),
    // (45: a count beyond the operand size, modulo 32)
    ("rorx", 3, 3, 0xF0, 1, None, Some(45)),
];
/// TZCNT, LZCNT and MOVBE (load, store): name, the bytes before ModRM,
/// whether a register operand is valid (MOVBE: memory only)
const LEGACY_FORMS: [(&str, &[u8], bool); 4] = [
    ("tzcnt", &[0xF3, 0x0F, 0xBC], true),
    ("lzcnt", &[0xF3, 0x0F, 0xBD], true),
    ("movbe_load", &[0x0F, 0x38, 0xF0], false),
    ("movbe_store", &[0x0F, 0x38, 0xF1], false),
];
fn all_features() -> u32 {
    use crate::cpu::features::{BMI1, BMI2, LZCNT, MOVBE};
    BMI1 | BMI2 | LZCNT | MOVBE
}
/// ModRM (ECX or `reg`) and the operand: ESI, or [0x6000] with a 16- or
/// 32-bit address
fn operand(reg: u8, memory: bool, address32: bool) -> Vec<u8> {
    if !memory {
        return vec![0xC6 | reg << 3];
    }
    let mut bytes = vec![reg << 3 | if address32 { 5 } else { 6 }];
    bytes.extend_from_slice(&0x6000u32.to_le_bytes()[..if address32 { 4 } else { 2 }]);
    bytes
}
fn vex_form(
    (_, map, pp, opcode, reg, vvvv, imm8): (&str, u8, u8, u8, u8, Option<u8>, Option<u8>),
    memory: bool,
    address32: bool,
) -> Vec<u8> {
    let mut bytes = vec![0xC4, 0xE0 | map, (15 - vvvv.unwrap_or(0)) << 3 | pp, opcode];
    bytes.extend(operand(reg, memory, address32));
    bytes.extend(imm8);
    bytes
}
/// BMI1 and BMI2 (VEX), TZCNT, LZCNT and MOVBE lift to the BMI helpers, the
/// region going on, and only with the CPU ABI; without the features TZCNT
/// and LZCNT are BSF and BSR, and the VEX forms and MOVBE none of the BMI
/// helpers'
#[test]
fn bmi_forms_call_the_helper() {
    use crate::cpu::features::TEST_FEATURES;
    let helpers = |bytes: &[u8], mode: bool| -> Option<Vec<String>> {
        lift_cpu(bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
            .ok()
            .map(|r| r.helpers.iter().map(|h| h.name.clone()).collect())
    };
    let mut forms: Vec<(Vec<u8>, bool)> = Vec::new();
    for form in VEX_FORMS {
        for memory in [false, true] {
            forms.push((vex_form(form, memory, true), memory));
        }
    }
    for (_, opcode, register) in LEGACY_FORMS {
        for memory in [false, true] {
            if memory || register {
                let mut bytes = opcode.to_vec();
                bytes.extend(operand(1, memory, true));
                forms.push((bytes, memory));
            }
        }
    }
    for (bytes, memory) in &forms {
        let helper = if *memory { "ir_bmi_mem_continue" } else { "ir_bmi_reg_continue" };
        for mode in [false, true] {
            // (16-bit code: the 32-bit address's prefix)
            let bytes = if mode { bytes.clone() } else { [&[0x67][..], bytes].concat() };
            TEST_FEATURES.with(|f| f.set(all_features()));
            assert!(lift(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).is_err());
            assert_eq!(
                helpers(&bytes, mode),
                Some(vec![helper.to_string()]),
                "{bytes:02X?}"
            );
            let mut suffix = bytes.clone();
            suffix.extend_from_slice(&[0x11, 0xC8, 0x90]);
            assert_eq!(
                helpers(&suffix, mode).map(|h| h.len()),
                Some(1),
                "{bytes:02X?}: the region goes on"
            );
            TEST_FEATURES.with(|f| f.set(0));
            assert!(
                helpers(&bytes, mode).map_or(true, |h| h.iter().all(|h| !h.starts_with("ir_bmi"))),
                "{bytes:02X?} without the features"
            );
        }
    }
}
/// Fixtures for tests/ir/differential/bmi.mjs: each form in 16- and 32-bit
/// code, from ESI and from memory (16- and 32-bit addresses), after INC ESI
/// (`dirty`: and INC EDX, VEX.vvvv's and MULX's source), whose results and
/// flags the region holds, and before ADC EAX, ECX and XOR EAX, EBX, which
/// read the results and CF. ECX is the destination (VEX.vvvv of BLSR,
/// BLSMSK and BLSI; MULX's high half, EBX its low half); TZCNT, LZCNT and
/// MOVBE 16- and 32-bit
#[test]
fn bmi_fixtures() {
    use crate::cpu::features::TEST_FEATURES;
    std::fs::create_dir_all("build/ir-bmi").unwrap();
    TEST_FEATURES.with(|f| f.set(all_features()));
    let mut cases = Vec::new();
    for mode in [false, true] {
        // (name, the instruction's bytes but the address size's prefix,
        // memory, the operand size, the address size)
        let mut forms: Vec<(&str, Vec<u8>, bool, u32, bool)> = Vec::new();
        for form in VEX_FORMS {
            for (memory, address32) in [(false, mode), (true, false), (true, true)] {
                forms.push((
                    form.0,
                    vex_form(form, memory, address32),
                    memory,
                    32,
                    address32,
                ));
            }
        }
        for (name, opcode, register) in LEGACY_FORMS {
            for bits in [16, 32] {
                for (memory, address32) in [(false, mode), (true, false), (true, true)] {
                    if !memory && !register {
                        continue;
                    }
                    let mut bytes = if (bits == 32) != mode { vec![0x66] } else { vec![] };
                    bytes.extend_from_slice(opcode);
                    bytes.extend(operand(1, memory, address32));
                    forms.push((name, bytes, memory, bits, address32));
                }
            }
        }
        for (name, instruction, memory, bits, address32) in forms {
            for dirty in [false, true] {
                let mut bytes = vec![0x46];
                if dirty {
                    bytes.push(0x42);
                }
                if address32 != mode {
                    bytes.push(0x67);
                }
                bytes.extend(&instruction);
                bytes.extend_from_slice(&[0x11, 0xC8, 0x31, 0xD8]);
                let mut r = lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                    .unwrap_or_else(|e| panic!("{name} {bytes:02X?}: {e:?}"));
                assert_eq!(
                    r.helpers
                        .iter()
                        .filter(|h| h.name.starts_with("ir_bmi"))
                        .count(),
                    1,
                    "{name} {bytes:02X?}"
                );
                for opt in 0..2 {
                    if opt != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    std::fs::write(
                        format!("build/ir-bmi/{}-{opt}.wasm", cases.len()),
                        emit_cpu(
                            &{
                                let mut mir = lower(&r).unwrap();
                                if opt != 0 {
                                    mir.schedule_operand_stack(262_144).unwrap();
                                    mir.allocate_machine_locals(4_000_000).unwrap();
                                }
                                mir
                            },
                            100,
                        )
                        .unwrap()
                        .bytes,
                    )
                    .unwrap();
                }
                cases.push(format!(
                    "[{bytes:?},{mode},{name:?},{dirty},{memory},{bits},{address32}]"
                ));
            }
        }
    }
    std::fs::write("build/ir-bmi/cases.json", format!("[{}]", cases.join(","))).unwrap();
    TEST_FEATURES.with(|f| f.set(0));
}
