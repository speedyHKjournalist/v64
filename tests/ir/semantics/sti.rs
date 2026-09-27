use crate::ir::{
    backend::wasm::emit_cpu,
    frontend::{
        decode::{GuestEip, LinearAddress},
        lift::lift_cpu,
        region::lift_cpu_cfg,
    },
    lowering::lower,
    passes::{run, PassConfig},
};
#[test]
fn sti_shadow_fixtures() {
    std::fs::create_dir_all("build/ir-sti").unwrap();
    let mut cases = Vec::new();
    for mode in [false, true] {
        for depth in [1, 2, 4] {
            for name in [
                "nop", "inc", "load", "store", "cli", "hlt", "ud", "int", "jcc", "push", "pop",
                "sse", "rep",
            ] {
                let mut bytes = vec![0x46];
                bytes.extend(vec![0xFB; depth]);
                let mut shadow = match name {
                    "nop" => vec![0x90],
                    "inc" => vec![0x40],
                    "cli" => vec![0xFA],
                    "hlt" => vec![0xF4],
                    "ud" => vec![0x0F, 0x0B],
                    "int" => vec![0xCC],
                    "jcc" => vec![0x74, 2],
                    "push" => vec![0x50],
                    "pop" => vec![0x58],
                    "sse" => vec![0xF3, 0x0F, 0x58, 0xC0],
                    "rep" => vec![0xF3, 0xA4],
                    "load" | "store" => {
                        let mut v = vec![
                            if name == "load" { 0x8B } else { 0x89 },
                            if mode { 5 } else { 6 },
                        ];
                        v.extend_from_slice(&0x6000u32.to_le_bytes()[..if mode { 4 } else { 2 }]);
                        v
                    },
                    _ => unreachable!(),
                };
                bytes.append(&mut shadow);
                for variant in 0..4 {
                    let mut r = if variant == 3 {
                        lift_cpu_cfg(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode, 128)
                    }
                    else {
                        lift_cpu(&bytes, GuestEip(0x8000), LinearAddress(0x8000), mode)
                    }
                    .unwrap();
                    if variant != 0 {
                        run(&mut r, PassConfig::default()).unwrap();
                    }
                    std::fs::write(
                        format!("build/ir-sti/{}-{variant}.wasm", cases.len()),
                        emit_cpu(
                            &{
                                let mut mir = lower(&r).unwrap();
                                if variant != 0 {
                                    mir.schedule_operand_stack(262_144).unwrap();
                                    mir.allocate_machine_locals(4_000_000).unwrap();
                                }
                                mir
                            },
                            if variant == 2 { 1 } else { 100 },
                        )
                        .unwrap()
                        .bytes,
                    )
                    .unwrap();
                }
                cases.push(format!(
                    "[{:?},{mode},{name:?},false,{},{depth}]",
                    bytes,
                    ["load", "store", "rep"].contains(&name)
                ));
            }
        }
    }
    for bytes in [
        &[0xFB][..],
        &[0xFB, 0xFB][..],
        &[0xFB, 0x90, 0x90][..],
        &[0xFB, 0xF0, 0x90][..],
    ] {
        assert!(lift_cpu(bytes, GuestEip(0x8000), LinearAddress(0x8000), true).is_err());
    }
    std::fs::write("build/ir-sti/cases.json", format!("[{}]", cases.join(","))).unwrap();
}
