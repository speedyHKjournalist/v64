#!/usr/bin/env node
// Guest delivery failures must escalate in the CPU, never unwind the host.
import assert from "node:assert/strict";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const vm = new V86({ graphics_adapter: "bochs_vga", acpi: true, cpu_cores: 2, memory_size: 16 << 20,
    disable_jit: true, autostart: false, log_level: 0 });
await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
const cpu = vm.v86.cpu;
const ex = cpu.wm.exports;
const view = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
const word = addr => view().getUint32(addr, true);
function gate(vector, present = true, base = 0x4000, selector = 8)
{
    const target = 0x2000 + vector * 16;
    view().setBigUint64(base + vector * 8, BigInt(target) | BigInt(selector) << 16n |
        BigInt(present ? 0x8E : 0x0E) << 40n, true);
    cpu.mem8[target] = 0xF4;
}
function setup(bytes, core = 1, idt = 0x4000)
{
    cpu.switch_core(core);
    cpu.load_core_state(cpu.core_reset_state);
    ex.exception_restore(core, 0);
    cpu.cores[core].running = true;
    cpu.sreg[1] = 8;
    cpu.sreg[2] = cpu.sreg[3] = cpu.sreg[0] = 16;
    cpu.segment_offsets.fill(0);
    cpu.segment_limits.fill(-1);
    cpu.protected_mode[0] = cpu.is_32[0] = cpu.stack_size_32[0] = 1;
    cpu.cr[0] = 0x11;
    cpu.reg32[4] = 0x9000;
    cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x1000;
    cpu.flags[0] = 2;
    cpu.in_hlt[0] = 0;
    cpu.gdtr_offset[0] = 0x6000;
    cpu.gdtr_size[0] = 23;
    view().setBigUint64(0x6008, 0x00CF9A000000FFFFn, true);
    view().setBigUint64(0x6010, 0x00CF92000000FFFFn, true);
    cpu.idtr_offset[0] = idt;
    cpu.idtr_size[0] = 255 * 8 + 7;
    for(let vector = 0; vector < 256; vector++) gate(vector, true, idt);
    cpu.mem8.set(bytes, 0x1000);
    cpu.update_state_flags();
    cpu.full_clear_tlb();
}
function delivered(vector, error)
{
    cpu.run_cpu_slice(1);
    assert.equal(cpu.instruction_pointer[0], 0x2000 + vector * 16, `delivered vector ${vector}`);
    if(error !== undefined) assert.equal(word(cpu.reg32[4] >>> 0), error);
}
function paging(missing)
{
    cpu.mem8.fill(0, 0xA000, 0xC000);
    view().setUint32(0xA000, 0xB003, true);
    for(let page = 0; page < 1024; page++) view().setUint32(0xB000 + page * 4, page === missing ? 0 : page * 4096 | 3, true);
    cpu.cr[3] = 0xA000;
    cpu.cr[0] = 0x80000011 | 0;
    cpu.full_clear_tlb();
}
try
{
    setup([0xF7, 0xF1]); // DIV ECX=0: contributory -> #NP => #DF
    gate(0, false);
    delivered(8, 0);
    setup([0x0F, 0x0B]); // #UD is benign: #NP is delivered, not #DF
    gate(6, false);
    delivered(11, 6 * 8 | 2);
    setup([0xCD, 13]); // Software INT 13 is not a contributory exception
    gate(13, false);
    delivered(11, 13 * 8 | 2);
    setup([0xF7, 0xF1], 1, 0x3FC0); // #DE gate on absent page, #PF gate present
    paging(3);
    delivered(14, 0);
    assert.equal(cpu.cr[2], 0x3FC0);
    setup([0xA1, 0, 0, 0x40, 0]); // #PF then non-present #PF gate => #DF
    gate(14, false);
    paging(-1);
    delivered(8, 0);
    assert.equal(cpu.cr[2], 0x400000);
    setup([0xCF]); // IRET null CS: guest #GP, stack unchanged before delivery
    view().setUint32(0x9000, 0x1234, true);
    view().setUint32(0x9004, 0, true);
    view().setUint32(0x9008, 2, true);
    delivered(13, 0);
    assert.equal(word(cpu.reg32[4] + 4), 0x1000);
    for(const [descriptor, target, vector, code] of [
        [0x00000B0000000000n, 0xFFFFFFFF, 13, 24], // system TSS never a CS, even P=0
        [0x0000120000000000n, 0xFFFFFFFF, 13, 24], // data segment before presence/limit
        [0x00001A0000000000n, 0xFFFFFFFF, 11, 24], // absent code before limit
        [0x00009A0000000000n, 0xFFFFFFFF, 13, 0],  // valid code, EIP beyond limit
    ])
    {
        setup([0xCF]);
        cpu.gdtr_size[0] = 31;
        view().setBigUint64(0x6018, descriptor, true);
        view().setUint32(0x9000, target, true);
        view().setUint32(0x9004, 24, true);
        view().setUint32(0x9008, 2, true);
        delivered(vector, code);
    }
    setup([0x90]);
    gate(2, false);
    cpu.apic_restore_core_events(1, 0, true);
    cpu.handle_irqs();
    assert.equal(cpu.instruction_pointer[0], 0x20B0);
    assert.equal(word(cpu.reg32[4]), 2 * 8 | 3, "NMI delivery fault carries EXT=1");
    setup([0xF7, 0xF1]);
    cpu.gdtr_size[0] = 10; // CS descriptor starts in table but extends beyond its limit
    cpu.run_cpu_slice(100);
    assert.equal(ex.exception_shutdown(1), 1);
    setup([0xF7, 0xF1]);
    cpu.segment_limits[2] = 4; // exception frames exceed stack; no host assertion
    cpu.run_cpu_slice(100);
    assert.equal(ex.exception_shutdown(1), 1);
    setup([0xF7, 0xF1]);
    gate(0, false); gate(8, false);
    const epoch = cpu.execution_epoch;
    cpu.run_cpu_slice(100);
    assert.equal(ex.exception_shutdown(1), 1);
    assert.equal(cpu.core_runnable(1), false);
    assert.equal(cpu.execution_epoch, epoch, "AP shutdown does not reset machine");
    const saved = await vm.save_state();
    ex.exception_restore(1, 0);
    await vm.restore_state(saved);
    assert.equal(ex.exception_shutdown(1), 1, "AP shutdown survives whole-machine restore");
    cpu.apic_restore_core_events(1, 1, false);
    cpu.take_core_events(1);
    assert.equal(ex.exception_shutdown(1), 0);
    assert.equal(cpu.cores[1].running, false, "INIT leaves AP waiting for SIPI");
    setup([0xF7, 0xF1]);
    gate(0, false); gate(8, false);
    cpu.run_cpu_slice(100);
    gate(2);
    cpu.apic_restore_core_events(1, 0, true);
    assert.equal(cpu.core_runnable(1), true);
    cpu.run_cpu_slice(1);
    assert.equal(ex.exception_shutdown(1), 0, "NMI wakes AP shutdown");
    assert.equal(cpu.instruction_pointer[0], 0x2021); // NMI handler HLT
    setup([0xF7, 0xF1], 0);
    cpu.idtr_size[0] = 0; // #GP -> #DF -> board reset, not recursive host panic
    const reset_epoch = cpu.execution_epoch;
    cpu.run_cores();
    assert.equal(cpu.execution_epoch, reset_epoch + 1);
    assert.ok(cpu.cores.every(core => core.steps === 0 && core.slices === 0), "old round cannot credit work after board reset");
    assert.equal(cpu.active_core, 0);
    assert.equal(cpu.cores[1].running, false);
    assert.equal(cpu.instruction_pointer[0] >>> 0, 0xFFFF0);
    console.log("PASS exception delivery: benign/contributory/PF matrix, #DF frame, invalid IRET, AP shutdown/snapshot/INIT/NMI, BSP safe-point reset");
}
finally { await vm.destroy(); }
