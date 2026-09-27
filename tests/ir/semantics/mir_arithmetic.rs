use crate::cpu::cpu::{TLB_HAS_CODE, TLB_READONLY};
use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
    },
    lowering::lower,
    mir::{
        arithmetic::{ArithmeticPlan, QuotientRange},
        effect::EffectPlan,
        memory::Argument,
    },
    passes::{run, PassConfig},
};
use crate::wasmgen::wasm_builder::WasmType;
#[test]
fn division_plans_fix_guest_bounds_and_host_trap_guards() {
    for (bits, low, high, max) in [
        (8, -128, 127, 255),
        (16, -32768, 32767, 65535),
        (32, -2147483648, 2147483647, 4294967295),
    ] {
        for signed in [false, true] {
            for memory in [false, true] {
                for opt in [false, true] {
                    let mut bytes = vec![0x43];
                    if bits == 16 {
                        bytes.push(0x66);
                    }
                    bytes.extend([
                        if bits == 8 { 0xF6 } else { 0xF7 },
                        if memory { 0x31 } else { 0xF1 } + if signed { 8 } else { 0 },
                    ]);
                    let mut r =
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), true).unwrap();
                    if opt {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let m = lower(&r).unwrap();
                    let p = m
                        .effects
                        .iter()
                        .flatten()
                        .find_map(|p| {
                            if let EffectPlan::Arithmetic(ArithmeticPlan::Division(p)) = p {
                                Some(p)
                            }
                            else {
                                None
                            }
                        })
                        .unwrap();
                    assert_eq!(p.signed, signed);
                    assert_eq!(
                        p.range,
                        if signed {
                            QuotientRange::Signed {
                                minimum: low,
                                maximum: high,
                            }
                        }
                        else {
                            QuotientRange::Unsigned { maximum: max }
                        }
                    );
                    assert_eq!(
                        p.overflow_pair,
                        if signed { Some((i64::MIN, -1)) } else { None }
                    );
                    assert_eq!(m.states[p.before.index()].cpu.count.snapshot, 1);
                    assert_eq!(p.fault.name, "ir_divide_fault");
                    assert!(
                        p.fault.args.is_empty()
                            && p.fault.signature.params.is_empty()
                            && p.fault.signature.results.is_empty()
                    );
                    emit_cpu(&m, 100).unwrap();
                }
            }
        }
    }
}
#[test]
fn compare_exchange_plans_fix_cpu_slots_guard_and_commit() {
    for mode in [false, true] {
        for prefix in [false, true] {
            for locked in [false, true] {
                for opt in [false, true] {
                    let mut bytes = vec![0x43];
                    if prefix {
                        bytes.push(0x66);
                    }
                    if locked {
                        bytes.push(0xF0);
                    }
                    bytes.extend([0x0F, 0xC7, 0x08]);
                    let mut r =
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                    if opt {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    let m = lower(&r).unwrap();
                    let p = m
                        .effects
                        .iter()
                        .flatten()
                        .find_map(|p| {
                            if let EffectPlan::Arithmetic(ArithmeticPlan::CompareExchange(p)) = p {
                                Some(p)
                            }
                            else {
                                None
                            }
                        })
                        .unwrap();
                    assert_eq!((p.expected.low, p.expected.high), (64, 72));
                    assert_eq!((p.replacement.low, p.replacement.high), (76, 68));
                    assert_eq!((p.flags, p.flags_changed, p.counter), (120, 100, 664));
                    assert_eq!((p.zero_mask, p.zero_shift, p.increment), (64, 6, 1));
                    assert_eq!(p.guard.bytes, 8);
                    assert_eq!(p.guard.page_offset_limit, 4089);
                    assert_eq!(
                        p.guard.flags_mask & (TLB_HAS_CODE | TLB_READONLY),
                        TLB_HAS_CODE | TLB_READONLY
                    );
                    assert_eq!(p.outcomes, [2, 4]);
                    assert_eq!(p.call.name, "ir_cmpxchg8b");
                    assert_eq!(p.call.args, vec![Argument::Value(p.address)]);
                    assert_eq!(p.call.signature.params, vec![WasmType::I32]);
                    assert_eq!(p.call.signature.results, vec![WasmType::I32]);
                    assert_eq!(m.states[p.before.index()].cpu.count.snapshot, 1);
                    emit_cpu(&m, 100).unwrap();
                    assert!(crate::ir::dump::mir(&m).contains("CompareExchange"));
                }
            }
        }
    }
}
#[test]
fn altered_arithmetic_plans_fail_before_emission() {
    for mutation in 0..16 {
        let bytes: &[u8] = if mutation < 7 { &[0xF7, 0xF9] } else { &[0x0F, 0xC7, 0x08] };
        let r = lift_cpu(bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        let mut m = crate::ir::lowering::lower_draft(&r).unwrap();
        let p = m
            .effects
            .iter_mut()
            .flatten()
            .find_map(|p| {
                if let EffectPlan::Arithmetic(p) = p {
                    Some(p)
                }
                else {
                    None
                }
            })
            .unwrap();
        match p {
            ArithmeticPlan::Division(p) => match mutation {
                0 => p.overflow_pair = None,
                1 => {
                    p.range = QuotientRange::Unsigned {
                        maximum: 4294967295,
                    }
                },
                2 => {
                    p.range = QuotientRange::Signed {
                        minimum: i64::MIN,
                        maximum: i64::MAX,
                    }
                },
                3 => p.signed = false,
                4 => p.fault.name = "ir_sse_guard",
                5 => p.fault.signature.results.push(WasmType::I32),
                6 => p.remainder = p.quotient,
                _ => unreachable!(),
            },
            ArithmeticPlan::CompareExchange(p) => match mutation {
                7 => p.guard.bytes = 4,
                8 => p.guard.flags_mask &= !TLB_READONLY,
                9 => p.expected.low = p.expected.high,
                10 => p.replacement.high = p.replacement.low,
                11 => p.flags_changed = p.flags,
                12 => p.zero_mask = 0,
                13 => p.increment = 2,
                14 => p.outcomes = [0, 4],
                15 => p.call.signature.results.clear(),
                _ => unreachable!(),
            },
        }
        assert!(m.finish().is_err(), "mutation {mutation}");
    }
}
