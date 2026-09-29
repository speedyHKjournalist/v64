#!/usr/bin/env node

// Topology: CPUID and firmware-input contract. These are instruction-level checks;
// architectural AP startup and real firmware boot have separate guest gates.
import assert from "node:assert/strict";
import { build_acpi_tables } from "../../src/acpi_tables.js";
import { create_platform } from "../../src/platform.js";
import { CMOS_BIOS_SMP_COUNT } from "../../src/rtc.js";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const LEAVES = [[0, 0], [1, 0], [4, 0], [4, 1], [4, 2], [4, 3], [4, 7],
    [0xB, 0], [0xB, 1], [0xB, 2], [0xB, 7], [0x1F, 0], [0x1F, 1], [0x1F, 2], [0x1F, 7]];

function cpuid(cpu, core, leaf, subleaf)
{
    cpu.switch_core(core);
    cpu.sreg[1] = 0;
    cpu.segment_offsets[1] = 0;
    cpu.instruction_pointer[0] = cpu.previous_ip[0] = 0x1000;
    cpu.flags[0] = 2;
    cpu.in_hlt[0] = 0;
    cpu.reg32[0] = leaf;
    cpu.reg32[1] = subleaf;
    cpu.mem8.set([0x0F, 0xA2, 0xF4], 0x1000); // CPUID; HLT
    cpu.full_clear_tlb();
    cpu.run_cpu_slice(4);
    assert.equal(cpu.in_hlt[0], 1, "CPUID fixture reached HLT");
    return [0, 3, 1, 2].map(index => cpu.reg32[index] >>> 0);
}

function firmware_inputs(cpu, cores)
{
    for(const selector of [5, 15]) // FW_CFG_NB_CPUS / MAX_CPUS
    {
        cpu.io.port_write16(0x510, selector);
        assert.equal(cpu.io.port_read8(0x511) | cpu.io.port_read8(0x511) << 8, cores, `fw_cfg ${selector}`);
    }
    assert.equal(cpu.devices.rtc.cmos_read(CMOS_BIOS_SMP_COUNT), cores - 1, "CMOS additional CPUs");
    const { tables, layout } = build_acpi_tables(cpu.platform, 0x600);
    const madt = tables.subarray(layout.APIC.offset, layout.APIC.offset + layout.APIC.length);
    const ids = [];
    for(let p = 44; p < madt.length; p += madt[p + 1])
    {
        assert.ok(madt[p + 1] >= 2, "bounded MADT entry");
        if(madt[p] === 0)
        {
            assert.equal(madt[p + 2], madt[p + 3], "ACPI processor ID equals APIC ID");
            assert.equal(madt[p + 4] & 1, 1, "processor enabled");
            ids.push(madt[p + 3]);
        }
    }
    assert.deepEqual(ids, Array.from({ length: cores }, (_, id) => id));
    // The bundled DSDT uses fixed-size, empty Processor objects: extended
    // opcode 5B83, one-byte package length, NameSeg, ProcID, no P_BLK.
    const dsdt = Buffer.from(tables.subarray(layout.DSDT.offset, layout.DSDT.offset + layout.DSDT.length));
    const processors = [];
    for(let p = 36; p + 13 <= dsdt.length; p++)
    {
        if(dsdt[p] !== 0x5B || dsdt[p + 1] !== 0x83) continue;
        assert.equal(dsdt[p + 2], 11, "AML Processor package length");
        processors.push([dsdt.toString("ascii", p + 3, p + 7), dsdt[p + 7]]);
    }
    assert.deepEqual(processors, ids.map(id => ["CP" + id.toString(16).toUpperCase().padStart(2, "0"), id]), "AML Processor IDs agree with MADT and CPUID");
}

for(const cores of [1, 2, 3, 4, 5, 6, 7, 8])
{
    const emulator = new V86({ acpi: true, cpu_cores: cores, memory_size: 16 << 20,
        disable_jit: true, autostart: false, log_level: 0 });
    let timeout;
    try
    {
        await new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("machine load timed out")), 15000);
            emulator.add_listener("emulator-loaded", resolve);
            emulator.add_listener("emulator-error", reject);
        });
        clearTimeout(timeout);
        const cpu = emulator.v86.cpu;
        assert.deepEqual(cpu.platform.topology, {
            sockets: 1, cores_per_socket: cores, threads_per_core: 1,
            logical_processors: cores, package_shift: Math.ceil(Math.log2(cores)),
        });
        assert.equal(cpu.platform.cpuid_profile, cores === 1 ? "legacy" : "smp32");
        const results = [];
        for(let id = 0; id < cores; id++)
        {
            const query = (leaf, subleaf = 0) => cpuid(cpu, id, leaf, subleaf);
            const values = LEAVES.map(([leaf, subleaf]) => query(leaf, subleaf));
            results.push(values);
            assert.equal(query(0)[0], cores === 1 ? 0x16 : 0x1F, "profile maximum basic leaf");
            const [, ebx, , edx] = query(1);
            assert.equal(ebx >>> 24, id, "initial APIC ID");
            assert.equal(ebx >>> 16 & 0xFF, cores, "logical processors per package");
            assert.equal(edx >>> 28 & 1, Number(cores > 1), "HTT qualifies package logical count");
            for(let subleaf = 0; subleaf < 3; subleaf++)
            {
                const geometry = [[0x121, 0x01C0003F, 0x3F, 1], [0x122, 0x01C0003F, 0x3F, 1], [0x143, 0x05C0003F, 0xFFF, 1]][subleaf];
                const sharing = subleaf === 2 ? cores : 1;
                geometry[0] = (geometry[0] | (cores - 1) << 26 | (sharing - 1) << 14) >>> 0;
                assert.deepEqual(query(4, subleaf), geometry, `cache subleaf ${subleaf}`);
            }
            assert.deepEqual(query(4, 3), [0, 0, 0, 0], "cache enumeration terminates");
            for(const leaf of [0xB, 0x1F])
            {
                for(const subleaf of [0, 1, 2, 7])
                {
                    const expected = cores === 1 ? [0, 0, 0, 0] : subleaf === 0 ? [0, 1, 0x100, id] :
                        subleaf === 1 ? [Math.ceil(Math.log2(cores)), cores, 0x201, id] : [0, 0, subleaf, id];
                    assert.deepEqual(query(leaf, subleaf), expected, `leaf ${leaf}, subleaf ${subleaf}`);
                }
                if(cores > 1) assert.equal(id >>> query(leaf, 1)[0], 0, "every core belongs to package zero");
            }
        }
        // Every field other than the documented per-core APIC ID is identical.
        for(let id = 1; id < cores; id++)
        {
            LEAVES.forEach(([leaf], index) => {
                const actual = [...results[id][index]];
                if(leaf === 1) actual[1] &= 0xFFFFFF;
                if(leaf === 0xB || leaf === 0x1F) actual[3] = 0;
                assert.deepEqual(actual, results[0][index], `core ${id}, leaf ${leaf}: package consistency`);
            });
        }
        firmware_inputs(cpu, cores);
        console.log(`${cores} cores: CPUID profile, package/core shifts, cache domains, MADT/fw_cfg/CMOS agree`);
    }
    finally
    {
        clearTimeout(timeout);
        await emulator.destroy();
    }
}

// Invalid counts fail before firmware or execution can use them.
for(const count of [0, -1, 1.5, 9])
{
    assert.throws(() => create_platform({ acpi: true, cpu_cores: count }, 16 << 20), /cpu_cores/);
}

// The legacy Windows-NT CPUID cap remains available for one core, while a
// multicore profile cannot hide the topology leaves it requires.
for(const [cores, level, rejected] of [[1, 2, false], [2, 2, true], [2, 0x1F, false]])
{
    const emulator = new V86({ acpi: true, cpu_cores: cores, cpuid_level: level,
        memory_size: 16 << 20, disable_jit: true, autostart: false, log_level: 0 });
    let timeout;
    try
    {
        const loaded = new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("profile load timed out")), 15000);
            emulator.add_listener("emulator-loaded", resolve);
            emulator.add_listener("emulator-error", reject);
        });
        if(rejected) await assert.rejects(loaded, /cpuid_level >= 0x1F/);
        else
        {
            await loaded;
            assert.equal(cpuid(emulator.v86.cpu, 0, 0, 0)[0], level, "explicit compatible CPUID maximum");
        }
    }
    finally
    {
        clearTimeout(timeout);
        await emulator.destroy();
    }
}
console.log("CPUID maximum override: legacy single-core cap preserved; incompatible SMP cap rejected");
