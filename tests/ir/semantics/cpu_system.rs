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
fn cpu_system_fixtures() {
    std::fs::create_dir_all("build/ir-cpu-system").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for op in [0xF4u32, 0xFA, 0x0F06, 0x0F09, 0x0F34, 0x0F35] {
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
                if op > 255 {
                    bytes.push(0x0F);
                }
                bytes.push(op as u8);
                let mut r =
                    lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode).unwrap();
                for opt in 0..2 {
                    if opt != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    std::fs::write(
                        format!("build/ir-cpu-system/{}-{opt}.wasm", cases.len()),
                        emit_cpu(&lower(&r).unwrap(), 100).unwrap().bytes,
                    )
                    .unwrap();
                }
                cases.push(format!("[{:?},{mode},{op}]", bytes));
            }
        }
    }
    std::fs::write(
        "build/ir-cpu-system/cases.json",
        format!("[{}]", cases.join(",")),
    )
    .unwrap();
}
#[test]
fn cpu_system_terminal_contract() {
    for bytes in [
        vec![0xF4],
        vec![0xFA],
        vec![0x0F, 0x06],
        vec![0x0F, 0x09],
        vec![0x0F, 0x34],
        vec![0x0F, 0x35],
    ] {
        assert!(lift(&bytes, GuestEip(0), LinearAddress(0), true).is_err());
        let mut locked = vec![0xF0];
        locked.extend(&bytes);
        assert!(lift_cpu(&locked, GuestEip(0), LinearAddress(0), true).is_err());
        let mut suffix = bytes.clone();
        suffix.push(0x90);
        assert_eq!(
            lift_cpu(&suffix, GuestEip(0), LinearAddress(0), true).is_ok(),
            bytes == [0xFA]
        );
        let r = lift_cpu(&bytes, GuestEip(0), LinearAddress(0), true).unwrap();
        assert_eq!(r.helpers.len(), 1);
        if bytes == [0xFA] {
            assert!(matches!(r.helpers[0].abi, HelperAbi::Outcome { .. }));
        }
        else {
            assert!(matches!(r.helpers[0].abi, HelperAbi::CpuExit));
        }
        assert!(r.helpers[0].results.is_empty());
    }
}

#[test]
fn cli_continuation_fixtures() {
    std::fs::create_dir_all("build/ir-cpu-system").unwrap();
    for mode in [false, true] {
        let mut region = lift_cpu(
            &[0x46, 0xFA, 0x43],
            GuestEip(0x8000),
            LinearAddress(0x8000),
            mode,
        )
        .unwrap();
        for opt in 0..2 {
            if opt == 1 {
                run(&mut region, PassConfig::default()).unwrap();
            }
            std::fs::write(
                format!("build/ir-cpu-system/cli-{mode}-{opt}.wasm"),
                emit_cpu(&lower(&region).unwrap(), 100).unwrap().bytes,
            )
            .unwrap();
        }
    }
}
