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
        graphics_adapter: "bochs_vga",
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
        assert.equal(new Uint8Array(cpu.wasm_memory.buffer)[cpu.state_base + STATE_OFFSETS.nmi_blocked], 1,
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
        assert.ok(read(0x180 + (0x52 >> 5) * 16) & 1 << (0x52 & 31),
            "EOI retains the last accepted TMR mode until the next interrupt");
        // Software disable retains already pending state, masks all LVT
        // sources, and rejects new fixed interrupts. Special IPIs still work.
        reset();
        send(1, 0x61);
        cpu.switch_core(1);
        write(0xF0, 0xFF);
        write(0x350, 7 << 8);
        assert.ok(read(0x350) & 1 << 16, "disabled LAPIC forces LVT masks");
        assert.equal(cpu.apic_core_interrupt_pending(1), 0);
        assert.equal(irr(1, 0x61), true, "software disable preserves IRR");
        cpu.switch_core(0);
        send(1, 0x62);
        assert.equal(irr(1, 0x62), false);
        write(0xF0, 0x1FF);
        assert.equal(cpu.apic_core_interrupt_pending(1), 1);
        write(0xF0, 0xFF);
        cpu.switch_core(0);
        send(1, 4 << 8);
        assert.equal(cpu.apic_core_nmi_pending(1), 1);
        send(1, 5 << 8 | 1 << 14);
        assert.equal(cpu.apic_take_core_events(1), INIT);
        send(0, 6 << 8 | 8);
        assert.equal(cpu.apic_take_core_events(0), 0, "BSP ignores SIPI");

        // Execute guest WRMSR/OUT instructions to cover CPU/controller wiring.
        const execute = bytes => {
            cpu.sreg[1] = cpu.sreg[2] = 0;
            cpu.segment_offsets[1] = cpu.segment_offsets[2] = 0;
            cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x1000;
            cpu.reg32[4] = 0x8000;
            cpu.flags[0] = 2;
            cpu.in_hlt[0] = 0;
            cpu.mem8.set([...bytes, 0xF4], 0x1000);
            cpu.full_clear_tlb();
            cpu.run_cpu_slice(bytes.length + 2);
            assert.equal(cpu.in_hlt[0], 1, "register fixture reaches HLT");
        };
        const msr_enable = enabled => {
            cpu.reg32[1] = 0x1B;
            cpu.reg32[0] = (LAPIC | (enabled ? 0x800 : 0)) | 0;
            cpu.reg32[2] = 0;
            execute([0x0F, 0x30]);
        };
        const out = (port, value) => execute([0xB0, value, 0xE6, port]);

        reset();
        cpu.switch_core(1);
        msr_enable(false);
        assert.equal(cpu.wm.exports.apic_core_hardware_enabled(1), 0);
        assert.equal(read(0x20), 0xFFFFFFFF, "hardware-disabled MMIO is unmapped");
        write(0xF0, 0x1FF);
        cpu.switch_core(0);
        send(1, 0x63);
        send(1, 4 << 8);
        send(1, 5 << 8 | 1 << 14);
        assert.equal(cpu.apic_core_nmi_pending(1), 0);
        assert.equal(cpu.apic_take_core_events(1), 0);
        assert.equal(cpu.wm.exports.apic_core_hardware_enabled(0), 1);
        cpu.switch_core(1);
        msr_enable(true);
        assert.equal(read(0x20), 1 << 24);
        assert.equal(read(0xF0) & 0x100, 0, "hardware re-enable starts software disabled");
        assert.equal(irr(1, 0x63), false);

        // Lowest-priority routing excludes disabled recipients; reserved ICR
        // encodings and illegal vectors do not become fixed interrupts.
        reset();
        write(0xF0, 0xFF);
        send(0, 2 << 18 | 1 << 8 | 0x64);
        assert.deepEqual(targets(0x64), Array.from({ length: count }, (_, i) => i === 1));
        reset();
        for(const mode of [2, 3, 7])
        {
            cpu.switch_core(0);
            send(1, mode << 8 | 0x65);
            assert.equal(irr(1, 0x65), false);
        }
        cpu.switch_core(0);
        send(1, 0x0F);
        write(0x280, 0);
        assert.ok(read(0x280) & 1 << 5, "illegal send vector latches ESR");
        send(1, 0xFF);
        assert.equal(irr(1, 0xFF), true, "0xFF is a valid fixed vector");
        cpu.switch_core(0);
        assert.equal(cpu.wm.exports.apic_core_ipi_sent(0), 1);
        assert.equal(cpu.wm.exports.apic_core_ipi_received(1), 1);

        // Cluster broadcast retains the member mask; reserved DFR values do
        // not silently act as the cluster model.
        reset();
        for(let core = 0; core < count; core++)
        {
            cpu.switch_core(core);
            write(0xE0, 0);
            assert.equal(read(0xE0), 0x0FFFFFFF, "DFR reserved low 28 bits read as ones");
            write(0xD0, ((core % 2 ? 0x20 : 0x10) | (core % 2 ? 2 : 1)) << 24);
        }
        cpu.switch_core(0);
        send(0xF2, 1 << 11 | 0x66);
        assert.deepEqual(targets(0x66), Array.from({ length: count }, (_, i) => i % 2 === 1));
        cpu.switch_core(1);
        write(0xE0, 0x7FFFFFFF);
        cpu.switch_core(0);
        send(0x22, 1 << 11 | 0x67);
        assert.equal(irr(1, 0x67), false);

        // An edge IPI queued behind a level IRQ must not suppress that IRQ's
        // EOI broadcast. The pending edge itself never gets a remote EOI.
        reset();
        cpu.device_lower_irq(10);
        io_write(0x10 + 10 * 2 + 1, 1 << 24);
        io_write(0x10 + 10 * 2, 1 << 15 | 0x68);
        cpu.device_raise_irq(10);
        cpu.switch_core(1);
        cpu.sreg[2] = cpu.segment_offsets[2] = 0;
        cpu.reg32[4] = 0x8000;
        cpu.flags[0] = 0x202;
        cpu.handle_irqs();
        cpu.switch_core(0);
        send(1, 1 << 15 | 0x68); // integrated xAPIC IPI is still edge-triggered
        cpu.device_lower_irq(10);
        cpu.switch_core(1);
        assert.ok(read(0x180 + (0x68 >> 5) * 16) & 1 << (0x68 & 31));
        write(0xB0, 0);
        assert.equal(io_read(0x10 + 10 * 2) & 1 << 14, 0);
        cpu.flags[0] = 0x202;
        cpu.handle_irqs();
        assert.equal(read(0x180 + (0x68 >> 5) * 16) & 1 << (0x68 & 31), 0);
        write(0xB0, 0);

        // Route the PIC through masked/unmasked BSP LINT0, then IOAPIC ExtINT
        // to an AP. ExtINT obtains its vector from the PIC, ignores LAPIC TPR,
        // and does not enter LAPIC ISR or require a LAPIC EOI.
        reset();
        for(let irq = 0; irq < 16; irq++) cpu.device_lower_irq(irq);
        for(let irq = 0; irq < 24; irq++) io_write(0x10 + irq * 2, 1 << 16);
        for(const [port, value] of [[0x20, 0x11], [0x21, 0x20], [0x21, 4], [0x21, 1],
            [0xA0, 0x11], [0xA1, 0x28], [0xA1, 2], [0xA1, 1], [0x21, 0xFE], [0xA1, 0xFF]]) out(port, value);
        cpu.device_raise_irq(0);
        assert.equal(cpu.wm.exports.routed_pic_pending(0), 1, "reset virtual wire reaches BSP");
        assert.equal(cpu.wm.exports.routed_pic_pending(1), 0);
        write(0x350, 1 << 16 | 7 << 8);
        assert.equal(cpu.wm.exports.routed_pic_pending(0), 0, "masking LINT0 blocks PIC");
        io_write(0x11, 1 << 24);
        io_write(0x10, 7 << 8);
        assert.equal(cpu.wm.exports.routed_pic_pending(0), 0);
        assert.equal(cpu.wm.exports.routed_pic_pending(1), 1, "ExtINT selects AP destination");
        cpu.switch_core(1);
        write(0x80, 0xF0);
        cpu.write16(0x20 * 4, 0x2000);
        cpu.write16(0x20 * 4 + 2, 0);
        cpu.sreg[2] = cpu.segment_offsets[2] = 0;
        cpu.reg32[4] = 0x8000;
        cpu.flags[0] = 0x202;
        cpu.handle_irqs();
        assert.equal(cpu.instruction_pointer[0], 0x2000, "ExtINT vector comes from PIC");
        assert.equal(read(0x100 + (0x20 >> 5) * 16), 0, "ExtINT does not enter ISR");
        assert.equal(cpu.wm.exports.routed_pic_pending(1), 0, "one PIC acknowledge retires request");
        assert.equal(io_read(0x10) & 1 << 14, 0, "ExtINT does not hold remote IRR");

        console.log(`${count} cores: APIC enable, destinations, INIT/SIPI, NMI, ExtINT, PPR, ESR, EOI and IOAPIC routing passed`);
    }
    finally
    {
        await emulator.destroy();
    }
}
