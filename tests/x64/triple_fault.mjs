#!/usr/bin/env node
// A triple fault in 64-bit mode (SDM Vol.3A §6.15, interrupt 8: a fault while
// delivering #DF enters shutdown). On the BSP the board resets the machine at
// the next safe point: the core restarts at the reset vector in real mode and
// no long-mode state survives (EFER.LME/LMA, CR0/CR4, the high RIP and the
// high halves of the GPRs are architecturally reset). QEMU is not usable as a
// reference: with -no-reboot it exits.
import assert from "node:assert/strict";
import {assemble} from "./guest_runner.mjs";
import {long_mode_guest} from "./guest_builder.mjs";

// #UD with an empty IDT: #GP(IDT limit) -> #DF -> #GP again -> shutdown
const body = `
mov rax,0x1122334455667788
mov r9,rax
mov dword [0x300000],0x7F7F7F7F
lidt [rel null_idt]
ud2
`;
const data = `
null_idt: dw 0
dq 0
`;
const directory = assemble("triple-fault", long_mode_guest(body, data));
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
for(const jit of [false, true])
{
    const emulator = new V86({graphics_adapter: "bochs_vga", multiboot: {url: directory + "guest.bin"}, memory_size: 32 << 20, acpi: true, autostart: false,
        log_level: 0, disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true});
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const cpu = emulator.v86.cpu;
    const view = () => new DataView(cpu.wasm_memory.buffer);
    const epoch = cpu.execution_epoch;
    let marked = false, rounds = 0;
    while(cpu.execution_epoch === epoch)
    {
        assert.ok(++rounds < 100000, "the triple fault resets the board");
        cpu.run_cores();
        marked ||= new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(0x300000, true) === 0x7F7F7F7F;
    }
    assert.ok(marked, "the guest reached 64-bit mode before faulting");
    assert.equal(cpu.execution_epoch, epoch + 1);
    const d = cpu.get_diagnostics();
    assert.equal(d.cpu.mode, "real");
    assert.equal(cpu.instruction_pointer[0] >>> 0, 0xFFFF0, "restart at the reset vector");
    assert.equal(view().getUint32(1584, true), 0, "RIP high half cleared");
    assert.equal(view().getBigUint64(1696, true), 0n, "EFER (LME/LMA/NXE/SCE) reset");
    assert.equal(cpu.cr[0] & 0x80000001, 0, "CR0.PG/PE clear");
    assert.equal(cpu.cr[4], 0, "CR4 clear");
    assert.equal(view().getUint32(1360 + 9 * 4, true), 0, "R9 high half cleared");
    assert.equal(cpu.wm.exports.exception_shutdown(0), 0, "the reset left shutdown");
    console.log(`PASS 64-bit triple fault resets the board (${jit ? "page tier" : "interpreter"})`);
    emulator.destroy();
}
