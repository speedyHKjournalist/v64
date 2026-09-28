#!/usr/bin/env node

// Tests of the ACPI tables v86 generates (src/acpi_tables.js), without a guest:
// - the table-loader script is executed the way SeaBIOS does
//   (src/fw/romfile_loader.c) and the installed tables are validated
// - with ACPICA's iasl and acpiexec (env IASL/ACPIEXEC, or on PATH), the
//   tables are disassembled and recompiled and the DSDT's methods are run

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.on("unhandledRejection", exn => { throw exn; });

const { create_platform } = await import("../../src/platform.js");
const { build_acpi_tables, ACPI_TABLES_FILE, ACPI_RSDP_FILE, ZONE_HIGH, ZONE_FSEG } = await import("../../src/acpi_tables.js");

const PM_BASE = 0x600;

// ---------------------------------------------------------------------------
// SeaBIOS's loader, on a sparse "physical memory"

function run_loader({ tables, rsdp, loader })
{
    const files = { [ACPI_TABLES_FILE]: tables, [ACPI_RSDP_FILE]: rsdp };
    const allocated = {};
    const zones = { [ZONE_HIGH]: 0x0FFF0000, [ZONE_FSEG]: 0x000F6C00 };
    const u32 = (bytes, o) => (bytes[o] | bytes[o + 1] << 8 | bytes[o + 2] << 16 | bytes[o + 3] << 24) >>> 0;
    const name_at = (bytes, o) => String.fromCharCode(...bytes.subarray(o, o + 56)).replace(/\0.*$/s, "");

    assert.equal(loader.length % 128, 0, "loader entries are 128 bytes");
    for(let o = 0; o < loader.length; o += 128)
    {
        const command = u32(loader, o);
        const entry = o + 4;
        if(command === 1)
        {
            const file = name_at(loader, entry);
            const align = u32(loader, entry + 56);
            const zone = loader[entry + 60];
            assert.ok(files[file], "allocate of a file that exists: " + file);
            assert.ok(!allocated[file], "allocated once: " + file);
            assert.equal(align & align - 1, 0, "power of two alignment");
            assert.ok(zones[zone] !== undefined, "known zone");
            const address = Math.ceil(zones[zone] / align) * align;
            zones[zone] = address + files[file].length;
            allocated[file] = { address, data: files[file].slice() };
        }
        else if(command === 2)
        {
            const dest = allocated[name_at(loader, entry)];
            const src = allocated[name_at(loader, entry + 56)];
            const offset = u32(loader, entry + 112);
            const size = loader[entry + 116];
            assert.ok(dest && src, "pointer between allocated files");
            assert.ok([1, 2, 4, 8].includes(size) && offset + size <= dest.data.length);
            let value = 0n;
            for(let i = 0; i < size; i++) value |= BigInt(dest.data[offset + i]) << BigInt(8 * i);
            value += BigInt(src.address);
            for(let i = 0; i < size; i++) dest.data[offset + i] = Number(value >> BigInt(8 * i) & 0xFFn);
        }
        else if(command === 3)
        {
            const file = allocated[name_at(loader, entry)];
            const offset = u32(loader, entry + 56);
            const start = u32(loader, entry + 60);
            const length = u32(loader, entry + 64);
            assert.ok(file && offset < file.data.length && start + length <= file.data.length);
            const sum = file.data.subarray(start, start + length).reduce((a, b) => a + b, 0);
            file.data[offset] = file.data[offset] - sum & 0xFF;
        }
        else
        {
            assert.fail("unexpected loader command " + command);
        }
    }

    // Guest physical memory as a lookup over the allocations
    const regions = Object.values(allocated);
    const mem = address => {
        for(const { address: base, data } of regions)
        {
            if(address >= base && address < base + data.length) return { data, offset: address - base };
        }
        assert.fail("address " + address.toString(16) + " is not in an installed table");
    };
    const read = (address, length) => { const { data, offset } = mem(address); return data.subarray(offset, offset + length); };
    return { allocated, read };
}

const le = bytes => bytes.reduceRight((v, b) => v * 256 + b, 0);
const checksum = bytes => bytes.reduce((a, b) => a + b, 0) & 0xFF;
const text = bytes => String.fromCharCode(...bytes);

/** Walk the installed tables from the RSDP, checking checksums and pointers */
function install(platform, pm_base = PM_BASE)
{
    const built = build_acpi_tables(platform, pm_base);
    const { allocated, read } = run_loader(built);

    const rsdp = allocated[ACPI_RSDP_FILE];
    assert.equal(rsdp.address % 16, 0);
    const r = rsdp.data;
    assert.equal(text(r.subarray(0, 8)), "RSD PTR ");
    assert.equal(checksum(r.subarray(0, 20)), 0, "RSDP checksum");
    assert.equal(checksum(r.subarray(0, 36)), 0, "RSDP extended checksum");
    assert.equal(r[15], 2, "RSDP revision 2 (has an XSDT)");
    assert.equal(le(r.subarray(20, 24)), 36);

    const table_at = address => {
        const header = read(address, 36);
        const length = le(header.subarray(4, 8));
        const data = read(address, length);
        assert.equal(checksum(data), 0, text(header.subarray(0, 4)) + " checksum");
        return { signature: text(header.subarray(0, 4)), revision: header[8], data, address };
    };

    const rsdt = table_at(le(r.subarray(16, 20)));
    const xsdt = table_at(le(r.subarray(24, 32)));
    assert.equal(rsdt.signature, "RSDT");
    assert.equal(xsdt.signature, "XSDT");
    const rsdt_entries = [];
    for(let o = 36; o < rsdt.data.length; o += 4) rsdt_entries.push(le(rsdt.data.subarray(o, o + 4)));
    const xsdt_entries = [];
    for(let o = 36; o < xsdt.data.length; o += 8) xsdt_entries.push(le(xsdt.data.subarray(o, o + 8)));
    assert.deepEqual(rsdt_entries, xsdt_entries, "RSDT and XSDT list the same tables");
    assert.ok(rsdt_entries.every(a => a < 2 ** 32), "tables below 4 GiB for 32-bit OSes");

    const tables = {};
    for(const address of rsdt_entries)
    {
        const t = table_at(address);
        assert.ok(!tables[t.signature], "listed once: " + t.signature);
        tables[t.signature] = t;
    }
    assert.deepEqual(Object.keys(tables).sort(), ["APIC", "FACP"]);

    const fadt = tables["FACP"].data;
    const facs_address = le(fadt.subarray(36, 40));
    const dsdt_address = le(fadt.subarray(40, 44));
    assert.equal(le(fadt.subarray(132, 140)), facs_address, "X_FIRMWARE_CTRL = FIRMWARE_CTRL");
    assert.equal(le(fadt.subarray(140, 148)), dsdt_address, "X_DSDT = DSDT");
    assert.equal(facs_address % 64, 0, "FACS 64-byte aligned");
    const facs = read(facs_address, 64);
    assert.equal(text(facs.subarray(0, 4)), "FACS");
    assert.ok(le(facs.subarray(4, 8)) >= 64);
    tables["DSDT"] = table_at(dsdt_address);
    assert.equal(tables["DSDT"].signature, "DSDT");
    tables["FACS"] = { data: facs, address: facs_address };

    return { tables, built, rsdp: r };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PLATFORMS = [
    ["256 MiB, defaults", {}, 256 << 20],
    ["32 MiB, all serial and parallel ports", { uart1: true, uart2: true, uart3: true, parallel1: true }, 32 << 20],
    ["2 GiB", {}, 2 ** 31 - (1 << 17)],
];

for(const [label, settings, memory] of PLATFORMS)
{
    test("loader installs consistent tables: " + label, () => {
        const platform = create_platform(settings, memory);
        const { tables } = install(platform);
        const fadt = tables["FACP"];
        const f = fadt.data;
        const u = (o, n) => le(f.subarray(o, o + n));

        assert.equal(fadt.revision, 3);
        assert.equal(f.length, 244);
        assert.equal(u(46, 2), 9, "SCI_INT");
        assert.equal(u(48, 4), 0xB2, "SMI_CMD");
        assert.deepEqual([f[52], f[53]], [0xF1, 0xF0]);
        assert.deepEqual([u(56, 4), u(64, 4), u(76, 4), u(80, 4)], [PM_BASE, PM_BASE + 4, PM_BASE + 8, 0xAFE0]);
        assert.deepEqual([f[88], f[89], f[91], f[92]], [4, 2, 4, 4], "block lengths");
        assert.equal(f[108], 0x32, "CENTURY");
        const flags = u(112, 4);
        assert.equal(flags & 1 << 4, 0, "fixed power button");
        assert.equal(flags & 1 << 8, 0, "24-bit PM timer");
        assert.ok(flags & 1 << 10, "RESET_REG_SUP");
        // RESET_REG: system I/O, 8 bits at 0xCF9, value 6
        assert.deepEqual([f[116], f[117], u(120, 8), f[128]], [1, 8, 0xCF9, 6]);
        // extended blocks agree with the legacy ones
        const gas = o => [f[o], f[o + 1], u(o + 4, 8)];
        assert.deepEqual(gas(148), [1, 32, PM_BASE]);
        assert.deepEqual(gas(172), [1, 16, PM_BASE + 4]);
        assert.deepEqual(gas(208), [1, 32, PM_BASE + 8]);
        assert.deepEqual(gas(220), [1, 32, 0xAFE0]);

        const madt = tables["APIC"].data;
        assert.equal(le(madt.subarray(36, 40)), 0xFEE00000);
        const entries = [];
        for(let o = 44; o < madt.length; o += madt[o + 1]) entries.push(madt.subarray(o, o + madt[o + 1]));
        assert.equal(entries.filter(e => e[0] === 0).length, platform.cores, "one local APIC per core");
        const ioapic = entries.find(e => e[0] === 1);
        assert.deepEqual([ioapic[2], le(ioapic.subarray(4, 8)), le(ioapic.subarray(8, 12))], [0, 0xFEC00000, 0]);
        const overrides = entries.filter(e => e[0] === 2).map(e => [e[3], le(e.subarray(4, 8)), le(e.subarray(8, 10))]);
        assert.deepEqual(overrides, [[9, 9, 0x0D], [10, 10, 0x0D], [11, 11, 0x0D]], "SCI and PCI links level/high; IRQ 5 (SB16) stays edge");

        const dsdt = Buffer.from(tables["DSDT"].data);
        assert.equal(tables["DSDT"].revision, 1, "32-bit AML integers");
        // Name (_Sx_, Package (4) {SLP_TYP, SLP_TYP, 0, 0}): S3 = 1, S4 = 2, S5 = 0
        for(const [state, slp_typ] of [["_S3_", 1], ["_S4_", 2], ["_S5_", 0]])
        {
            const at = dsdt.indexOf(state);
            // NameOp, RootChar ("\\_Sx_")
            assert.ok(at > 1 && dsdt[at - 2] === 0x08 && dsdt[at - 1] === 0x5C, state + " advertised");
            assert.equal(dsdt[at + 4], 0x12, state + " is a package");
            const element = dsdt.subarray(at + 7, at + 9);
            const value = element[0] === 0x0A ? element[1] : element[0] === 0x01 ? 1 : element[0] === 0x00 ? 0 : -1;
            assert.equal(value, slp_typ, state + " SLP_TYP");
        }
        assert.ok(dsdt.includes(Buffer.from([0x0C, 0x41, 0xD0, 0x03, 0x03])), "PNP0303 (SeaBIOS checks for it)");
        const com_ports = (dsdt.toString("latin1").match(/COM\d/g) || []).length;
        assert.equal(com_ports, platform.uarts.length, "one COM device per emulated UART");
    });
}

test("the table sizes do not depend on the PM base (tables are regenerated when read)", () => {
    const platform = create_platform({}, 256 << 20);
    const a = build_acpi_tables(platform, 0x600);
    const b = build_acpi_tables(platform, 0xB000);
    assert.equal(a.tables.length, b.tables.length);
    assert.deepEqual(a.loader, b.loader);
    assert.deepEqual(a.rsdp, b.rsdp);
    const { tables } = install(platform, 0xB000);
    assert.equal(le(tables["FACP"].data.subarray(56, 60)), 0xB000);
});

test("platform description rejects overlapping I/O ranges", async () => {
    const { check_platform } = await import("../../src/platform.js");
    const platform = create_platform({}, 256 << 20);
    assert.throws(() => check_platform(platform, 0x3C0), /conflict.*acpi-pm|conflict.*fdc/i);
    check_platform(platform, 0x600);
});

// ---------------------------------------------------------------------------
// ACPICA

function find_tool(name, env)
{
    if(process.env[env]) return process.env[env];
    try
    {
        return execFileSync("sh", ["-c", "command -v " + name], { encoding: "utf8" }).trim() || null;
    }
    catch(e)
    {
        return null;
    }
}

const IASL = find_tool("iasl", "IASL");
const ACPIEXEC = find_tool("acpiexec", "ACPIEXEC");
const skipped = [];

function write_installed_tables(dir)
{
    const platform = create_platform({ uart1: true }, 256 << 20);
    const { tables } = install(platform);
    for(const [name, { data }] of Object.entries(tables))
    {
        fs.writeFileSync(path.join(dir, name.toLowerCase() + ".dat"), data);
    }
}

if(IASL)
{
    test("iasl disassembles every table and recompiles the DSDT without errors", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v86-acpi-"));
        write_installed_tables(dir);
        const iasl = args => {
            const { status, stdout, stderr } = spawnSync(IASL, args, { cwd: dir, encoding: "utf8" });
            return { status, out: stdout + stderr };
        };
        for(const name of ["dsdt", "facp", "apic", "facs"])
        {
            const { status, out } = iasl(["-d", name + ".dat"]);
            assert.equal(status, 0, out);
            assert.doesNotMatch(out, /Error|Warning/, name + ": " + out);
        }
        // -oa: no optimizations, so the AML can be compared byte for byte
        const { status, out } = iasl(["-oa", "-p", "recompiled", "dsdt.dsl"]);
        assert.equal(status, 0, out);
        assert.match(out, /Compilation successful\. 0 Errors/, out);
        // The only accepted warning: Processor() instead of Device(ACPI0007), for Windows 2000/XP
        const warnings = out.match(/^Warning +\d+/gm) || [];
        assert.deepEqual(warnings.map(w => w.split(/ +/)[1]), ["3168"], out);
        // the recompiled AML is the same code (only the header's compiler id differs)
        const original = fs.readFileSync(path.join(dir, "dsdt.dat")).subarray(36);
        const recompiled = fs.readFileSync(path.join(dir, "recompiled.aml")).subarray(36);
        assert.ok(original.equals(recompiled), "iasl compiles the disassembly back to the same AML");
        fs.rmSync(dir, { recursive: true });
    });
}
else
{
    skipped.push("iasl (set IASL=/path/to/iasl)");
}

if(ACPIEXEC)
{
    test("acpiexec runs the interrupt link methods and the sleeping state packages", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v86-acpi-"));
        write_installed_tables(dir);
        const commands = [
            "evaluate \\_SB.LNKA._STA",
            "evaluate \\_SB.LNKA._CRS",
            "evaluate \\_SB.LNKA._SRS (89 06 00 09 01 0B 00 00 00 79 00)",
            "evaluate \\_SB.LNKA._CRS",
            "evaluate \\_SB.LNKA._DIS",
            "evaluate \\_SB.LNKA._STA",
            "evaluate \\_SB.LNKA._PRS",
            "evaluate \\_S3",
            "evaluate \\_S4",
            "evaluate \\_S5",
            "evaluate \\_SB.PCI0.ISA.KBD._HID",
        ].join("; ");
        let out;
        try
        {
            out = execFileSync(ACPIEXEC, ["-b", commands, "dsdt.dat"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
        }
        catch(e)
        {
            out = e.stdout; // acpiexec reports its own leak tracking as an error
        }
        const results = out.split(/Evaluating /).slice(1).map(block => {
            const value = block.match(/\[(Integer|Buffer)\][^\n]*/g) || [];
            return value.join(" | ");
        });
        assert.deepEqual(results, [
            "[Integer] = 000000000000000B",
            "[Buffer] Length 0B =     0000: 89 06 00 09 01 00 00 00 00 79 00                 // .........y.",
            "",
            "[Buffer] Length 0B =     0000: 89 06 00 09 01 0B 00 00 00 79 00                 // .........y.",
            "",
            "[Integer] = 0000000000000009",
            "[Buffer] Length 0F =     0000: 89 0A 00 09 02 0A 00 00 00 0B 00 00 00 79 00     // .............y.",
            "[Integer] = 0000000000000001 | [Integer] = 0000000000000001 | [Integer] = 0000000000000000 | [Integer] = 0000000000000000",
            "[Integer] = 0000000000000002 | [Integer] = 0000000000000002 | [Integer] = 0000000000000000 | [Integer] = 0000000000000000",
            "[Integer] = 0000000000000000 | [Integer] = 0000000000000000 | [Integer] = 0000000000000000 | [Integer] = 0000000000000000",
            "[Integer] = 000000000303D041",
        ]);
        assert.doesNotMatch(out, /ACPI Error: (?!\d+ \(0x[0-9a-f]+\) Outstanding cache allocations)/, out);
        fs.rmSync(dir, { recursive: true });
    });
}
else
{
    skipped.push("acpiexec (set ACPIEXEC=/path/to/acpiexec)");
}

let failed = 0;
for(const { name, fn } of tests)
{
    try
    {
        await fn();
        console.log("ok - " + name);
    }
    catch(e)
    {
        failed++;
        console.log("not ok - " + name);
        console.log(e);
    }
}
for(const tool of skipped)
{
    console.log("SKIP - not verified with " + tool);
}

console.log(`${tests.length - failed}/${tests.length} ACPI table tests passed` + (skipped.length ? `, ${skipped.length} ACPICA check(s) skipped` : ""));
process.exit(failed ? 1 : 0);
