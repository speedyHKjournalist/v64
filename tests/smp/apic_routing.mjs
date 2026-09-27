#!/usr/bin/env node

// Exercise the real Wasm interrupt controllers through their guest MMIO
// registers. No guest loop, firmware timing, or generated code is involved.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { STATE_OFFSETS } from "../../src/state_layout.js";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const root = fileURLToPath(new URL("../../", import.meta.url));
const LAPIC = 0xFEE00000;
const IOAPIC = 0xFEC00000;
const INIT = 1;
const SIPI = 2;

for(const count of [2, 4, 8])
{
    const emulator = new V86({
        bios: { url: root + "bios/seabios.bin" },
        vga_bios: { url: root + "bios/vgabios.bin" },
        acpi: true,
        cpu_cores: count,
        autostart: false,
        memory_size: 32 * 1024 * 1024,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    const cpu = emulator.v86.cpu;
    const write = (reg, value) => cpu.write32(LAPIC + reg, value);
    const read = reg => cpu.read32s(LAPIC + reg) >>> 0;
    const send = (destination, command) => {
        write(0x310, destination << 24);
        write(0x300, command);
    };
    const reset = () => {
        cpu.reset_cores();
        cpu.reset_cpu();
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            write(0xF0, 0x1FF);
            write(0xD0, (1 << core) << 24);
        }
        cpu.switch_core(0);
    };
    const irr = (core, vector) => {
        cpu.switch_core(core);
        return !!(read(0x200 + (vector >> 5) * 16) & 1 << (vector & 31));
    };
    const targets = vector => Array.from({ length: count }, (_, core) => irr(core, vector));
    const io_write = (reg, value) => {
        cpu.write32(IOAPIC, reg);
        cpu.write32(IOAPIC + 0x10, value);
    };
    const io_read = reg => {
        cpu.write32(IOAPIC, reg);
        return cpu.read32s(IOAPIC + 0x10) >>> 0;
    };

    try
    {
        // Physical destination and all three destination shorthands.
        reset();
        send(count - 1, 0x41);
        assert.deepEqual(targets(0x41), Array.from({ length: count }, (_, i) => i === count - 1));
        reset();
        send(0, 1 << 18 | 0x42);
        assert.deepEqual(targets(0x42), Array.from({ length: count }, (_, i) => i === 0));
        reset();
        send(0, 2 << 18 | 0x43);
        assert.deepEqual(targets(0x43), Array(count).fill(true));
        reset();
        send(0, 3 << 18 | 0x44);
        assert.deepEqual(targets(0x44), Array.from({ length: count }, (_, i) => i !== 0));

        // Logical destinations use each recipient's own DFR and LDR.
        reset();
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            write(0xE0, 0xFFFFFFFF);
            write(0xD0, (1 << core) << 24);
        }
        cpu.switch_core(0);
        send((1 << (count - 1)) | 1, 1 << 11 | 0x45);
        assert.deepEqual(targets(0x45), Array.from({ length: count }, (_, i) => i === 0 || i === count - 1));
        reset();
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            write(0xE0, 0x0FFFFFFF);
            write(0xD0, (core % 2 ? 0x22 : 0x12) << 24);
        }
        cpu.switch_core(0);
        send(0x22, 1 << 11 | 0x46);
        assert.deepEqual(targets(0x46), Array.from({ length: count }, (_, i) => i % 2 === 1));

        // NMIs ignore vector and IF, and never enter the fixed IRQ IRR.
        // Use physical destinations: self shorthand with NMI is reserved
        // (Intel SDM volume 3A, Tables 12-3 and 12-4).
        reset();
        send(1, 4 << 8);
        assert.equal(cpu.apic_core_nmi_pending(1), 1);
        assert.equal(read(0x200), 0);
        send(1, 5 << 8 | 1 << 14);
        assert.equal(cpu.apic_core_nmi_pending(1), 0, "INIT clears an older NMI");
        assert.equal(cpu.apic_take_core_events(1), INIT);
        send(0, 4 << 8);
        assert.equal(new Uint8Array(cpu.wasm_memory.buffer)[STATE_OFFSETS.nmi_blocked], 1,
            "physical self NMI is delivered immediately despite IF being clear");

        // First SIPI wins; a later INIT supersedes a pending startup.
        reset();
        send(1, 5 << 8 | 1 << 14);
        send(1, 6 << 8 | 0x08);
        send(1, 6 << 8 | 0x09);
        assert.equal(cpu.wm.exports.apic_peek_core_events(1), INIT | SIPI | 0x0800);
        cpu.take_core_events(1);
        assert.equal(cpu.instruction_pointer[0], 0x8000);
        assert.equal(cpu.cores[1].running, true);
        cpu.switch_core(0);
        send(1, 6 << 8 | 0x0A);
        cpu.take_core_events(1);
        cpu.switch_core(1);
        assert.equal(cpu.instruction_pointer[0], 0x8000, "running AP ignores another SIPI");
        cpu.switch_core(0);
        send(1, 6 << 8 | 0x0B);
        send(1, 5 << 8 | 1 << 14);
        assert.equal(cpu.wm.exports.apic_peek_core_events(1), INIT);
        cpu.take_core_events(1);
        assert.equal(cpu.cores[1].running, false, "INIT cancels the pending SIPI");
        send(1, 6 << 8 | 0x0C);
        send(1, 5 << 8 | 1 << 15); // INIT level deassert is not another INIT
        assert.equal(cpu.apic_take_core_events(1), SIPI | 0x0C00);
        send(1, 5 << 8 | 1 << 14);
        send(1, 4 << 8);
        cpu.take_core_events(1);
        assert.equal(cpu.apic_core_nmi_pending(1), 1, "NMI after INIT survives deferred reset");

        // Restore pending events without consuming them (single-core
        // snapshots use these same controller exports).
        cpu.wm.exports.apic_restore_core_events(1, SIPI | 0x0D00, false);
        assert.equal(cpu.wm.exports.apic_peek_core_events(1), SIPI | 0x0D00);
        assert.equal(cpu.apic_core_nmi_pending(1), 0);

        // Lowest priority considers ISR as well as TPR: core 0 is serving
        // B1, while core 1 (TPR 20) can accept vector 50 immediately.
        reset();
        cpu.sreg[2] = 0;
        cpu.segment_offsets[2] = 0;
        cpu.reg32[4] = 0x8000;
        send(0, 0xB1);
        cpu.flags[0] = 0x202;
        cpu.handle_irqs();
        assert.equal(read(0xA0), 0xB0, "PPR reflects the in-service class");
        for(let core = 1; core < count; core++)
        {
            cpu.switch_core(core);
            write(0x80, core === 1 ? 0x20 : 0xE0);
        }
        cpu.switch_core(0);
        cpu.device_lower_irq(11);
        io_write(0x10 + 11 * 2 + 1, ((1 << count) - 1) << 24);
        io_write(0x10 + 11 * 2, 1 << 11 | 1 << 8 | 0x50);
        cpu.device_raise_irq(11);
        assert.deepEqual(targets(0x50), Array.from({ length: count }, (_, i) => i === 1));
        cpu.device_lower_irq(11);
        cpu.switch_core(0);
        send(0, 0xB2);
        assert.equal(cpu.apic_core_interrupt_pending(0), 0, "same priority class cannot nest");
        write(0xB0, 0);
        assert.equal(cpu.apic_core_interrupt_pending(0), 1, "EOI releases the pending class");

        // Device interrupts use the same routing, including NMI delivery.
        reset();
        cpu.device_lower_irq(9);
        io_write(0x10 + 9 * 2 + 1, (count - 1) << 24);
        io_write(0x10 + 9 * 2, 0x51);
        cpu.device_raise_irq(9);
        assert.deepEqual(targets(0x51), Array.from({ length: count }, (_, i) => i === count - 1));
        cpu.switch_core(0);
        cpu.device_lower_irq(9);
        io_write(0x10 + 9 * 2, 4 << 8);
        cpu.device_raise_irq(9);
        assert.equal(cpu.apic_core_nmi_pending(count - 1), 1);

        // A level-triggered device on an AP is redelivered after EOI while
        // asserted, and stops once lowered. EOI may route back to its sender.
        reset();
        cpu.device_lower_irq(9);
        cpu.device_lower_irq(10);
        io_write(0x10 + 10 * 2 + 1, 1 << 24);
        io_write(0x10 + 10 * 2, 1 << 15 | 0x52);
        cpu.device_raise_irq(10);
        assert.equal(irr(1, 0x52), true);
        cpu.sreg[2] = 0;
        cpu.segment_offsets[2] = 0;
        cpu.reg32[4] = 0x8000;
        cpu.flags[0] = 0x202;
        cpu.handle_irqs();
        assert.equal(irr(1, 0x52), false);
        assert.ok(io_read(0x10 + 10 * 2) & 1 << 14, "level interrupt has remote IRR");
        write(0xB0, 0);
        assert.equal(irr(1, 0x52), true, "EOI redelivers an asserted level");
        cpu.flags[0] = 0x202;
        cpu.handle_irqs();
        cpu.device_lower_irq(10);
        write(0xB0, 0);
        assert.equal(irr(1, 0x52), false);
        assert.equal(io_read(0x10 + 10 * 2) & 1 << 14, 0, "EOI clears remote IRR after lowering");
        console.log(`${count} cores: APIC destinations, INIT/SIPI ordering, NMI, PPR and IOAPIC routing passed`);
    }
    finally
    {
        await emulator.destroy();
    }
}
