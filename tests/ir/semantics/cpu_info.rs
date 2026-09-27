use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::{lift, lift_cpu},
    },
    helper::HelperAbi,
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn cpu_info_fixtures() {
    std::fs::create_dir_all("build/ir-cpu-info").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for op in [0xA2, 0x30, 0x31, 0x32] {
            for prefix in [
                vec![],
                vec![0x66],
                vec![0x67],
                vec![0xF2],
                vec![0xF3],
                vec![0x64],
                vec![0x66, 0x67, 0xF2, 0x64],
            ] {
                let mut bytes = vec![0x46];
                bytes.extend(prefix);
                bytes.extend([0x0F, op]);
                let mut r =
                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                for opt in 0..2 {
                    if opt != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    std::fs::write(format!("build/ir-cpu-info/{}-{opt}.wasm", cases.len()), {
                        let mut mir = lower(&r).unwrap();
                        if opt != 0 {
                            mir.elide_redundant_cpu_state_writes(
                                crate::ir::mir::state_elision::DEFAULT_WORK_LIMIT,
                            )
                            .unwrap();
                            mir.elide_dead_cpu_values(
                                crate::ir::mir::cpu_liveness::DEFAULT_WORK_LIMIT,
                            )
                            .unwrap();
                        }
                        emit_cpu(&mir, 100).unwrap().bytes
                    })
                    .unwrap();
                }
                cases.push(format!("[{:?},{mode},{op}]", bytes));
            }
        }
    }
    std::fs::write(
        "build/ir-cpu-info/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn cpu_info_observer_and_terminal_contracts() {
    for op in [0xA2, 0x30, 0x31, 0x32] {
        let bytes = [0x0F, op];
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        assert!(lift_cpu(&[0xF0, 0x0F, op], GuestEip(0), LinearAddress(0), true).is_err());
        assert_eq!(
            lift_cpu(&[0x0F, op, 0x90], GuestEip(0), LinearAddress(0), true).is_ok(),
            matches!(op, 0x31 | 0xA2)
        );
        let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(r.helpers.len(), 1);
        if matches!(op, 0x31 | 0xA2) {
            assert!(matches!(r.helpers[0].abi, HelperAbi::CpuReload));
            assert_eq!(r.helpers[0].results, vec![crate::ir::types::Type::I32; 14]);
            lower(&r).unwrap().verify().unwrap();
        }
        else {
            assert!(matches!(r.helpers[0].abi, HelperAbi::CpuExit));
            assert!(r.helpers[0].results.is_empty());
        }
    }
}
