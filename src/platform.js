// Description of the emulated PC platform: the single source for the ACPI
// tables (src/acpi_tables.js), the fw_cfg and CMOS inputs of the firmware,
// and the fixed resources of the devices that implement them.
// See docs/acpi.md.

import { dbg_assert } from "./log.js";
import { h } from "./lib.js";

/** Must match MAX_CORES in src/rust/cpu/apic.rs */
export const MAX_CORES = 8;

export const LAPIC_ADDRESS = 0xFEE00000;
export const IOAPIC_ADDRESS = 0xFEC00000;
/** Must match IOAPIC_ID in src/rust/cpu/ioapic.rs */
export const IOAPIC_ID = 0;

/** PCI memory BARs must lie below the IOAPIC; v86 does not relocate them */
export const PCI_MMIO_END = 0xFEBFFFFF;

// PIIX4 power management function (PCI 00:07.0)
export const ACPI_PM_PCI_ID = 0x07 << 3;
/** PM I/O block size decoded at PMBA (PCI config 0x40) */
export const ACPI_PM_LENGTH = 0x40;
/**
 * PM base that SeaBIOS programs when it loads v86's tables through
 * etc/table-loader (src/fw/paravirt.c). The device decodes whatever the
 * firmware writes to PMBA; the tables are generated from that value.
 */
export const ACPI_PM_BASE_DEFAULT = 0x600;
export const ACPI_GPE0_BASE = 0xAFE0;
export const ACPI_GPE0_LENGTH = 4;
export const ACPI_SMI_CMD_PORT = 0xB2;
export const ACPI_ENABLE = 0xF1;
export const ACPI_DISABLE = 0xF0;
export const ACPI_SCI_IRQ = 9;

/** PIIX reset control register; the FADT reset register writes RESET_VALUE to it */
export const RESET_PORT = 0xCF9;
export const RESET_VALUE = 0x06;

export const FW_CFG_PORT = 0x510;

/**
 * ISA IRQs that the PCI interrupt links (PIRQA..D) may use. SeaBIOS routes
 * them to 10, 10, 11, 11. IRQ 5 is not offered: the SB16 uses it.
 */
export const PCI_LINK_IRQS = [10, 11];

/**
 * Sleep states. The SLP_TYP values are what the ACPI device decodes; the
 * tables advertise a state only when it is supported.
 */
export const ACPI_SLEEP_STATES = [
    // S3 (suspend to RAM): cores stop, RAM and the BIOS shadow are kept; a
    // wake event resets CPUs and devices and SeaBIOS jumps to the FACS
    // waking vector
    { state: 3, slp_typ: 1, supported: true },
    // S4 (OS-directed hibernation): a soft off for the hardware; the guest
    // restores itself from disk at the next power-on
    { state: 4, slp_typ: 2, supported: true },
    // S5 (soft off)
    { state: 5, slp_typ: 0, supported: true },
];

/**
 * Legacy devices at fixed resources. `when` names the setting that enables an
 * optional device.
 */
const UARTS = [
    { port: 0x3F8, irq: 4 },
    { port: 0x2F8, irq: 3, when: "uart1" },
    { port: 0x3E8, irq: 4, when: "uart2" },
    { port: 0x2E8, irq: 3, when: "uart3" },
];

const PARALLEL_PORTS = [
    { port: 0x378, irq: 7 },
    { port: 0x278, irq: 5, when: "parallel1" },
];

/**
 * @typedef {{
 *     cores: number,
 *     topology: {sockets: number, cores_per_socket: number, threads_per_core: number, logical_processors: number, package_shift: number},
 *     cpuid_profile: string,
 *     apic_ids: !Array<number>,
 *     memory_size: number,
 *     pci_mmio_start: number,
 *     uarts: !Array<{index: number, port: number, irq: number}>,
 *     parallel_ports: !Array<{index: number, port: number, irq: number}>,
 * }}
 */
export var Platform;

/**
 * @param {Object} settings
 * @param {number} memory_size RAM below 4 GiB in bytes
 * @return {Platform}
 */
export function create_platform(settings, memory_size)
{
    const enabled = device => !device.when || !!settings[device.when];
    const indexed = list => list.map((device, index) => ({ index, port: device.port, irq: device.irq })).filter((_, i) => enabled(list[i]));

    // One socket, `cpu_cores` cores, one thread per core. CPUID, fw_cfg, CMOS
    // and the MADT all read the core count from here.
    const cores = settings.cpu_cores === undefined ? 1 : settings.cpu_cores;
    if(!Number.isInteger(cores) || cores < 1 || cores > MAX_CORES)
    {
        throw new Error("cpu_cores must be an integer from 1 to " + MAX_CORES + ", got " + cores);
    }
    if(cores > 1 && !settings.acpi)
    {
        throw new Error("cpu_cores > 1 requires acpi: true (it enables the local APICs)");
    }

    // The PCI memory window starts at the first 256 MiB boundary above RAM
    const pci_mmio_start = Math.ceil(memory_size / 0x10000000) * 0x10000000;

    const platform = {
        cores,
        topology: {
            sockets: 1,
            cores_per_socket: cores,
            threads_per_core: 1,
            logical_processors: cores,
            package_shift: Math.ceil(Math.log2(cores)),
        },
        cpuid_profile: cores === 1 ? "legacy" : "smp32",
        apic_ids: Array.from({ length: cores }, (_, i) => i),
        memory_size,
        pci_mmio_start,
        uarts: indexed(UARTS),
        parallel_ports: indexed(PARALLEL_PORTS),
    };

    check_platform(platform);
    return platform;
}

/**
 * I/O port ranges with a fixed owner. Everything the tables describe must be
 * in here, and no two ranges may overlap.
 * @param {Platform} platform
 * @param {number=} pm_base
 * @return {!Array<{name: string, start: number, length: number}>}
 */
export function platform_io_ranges(platform, pm_base)
{
    const ranges = [
        { name: "dma1", start: 0x00, length: 0x10 },
        { name: "pic1", start: 0x20, length: 2 },
        { name: "pit", start: 0x40, length: 4 },
        { name: "kbd-data", start: 0x60, length: 1 },
        { name: "speaker", start: 0x61, length: 1 },
        { name: "kbd-cmd", start: 0x64, length: 1 },
        { name: "rtc", start: 0x70, length: 2 },
        { name: "dma-page", start: 0x80, length: 0x10 },
        { name: "port92", start: 0x92, length: 1 },
        { name: "pic2", start: 0xA0, length: 2 },
        { name: "smi-cmd", start: ACPI_SMI_CMD_PORT, length: 2 },
        { name: "dma2", start: 0xC0, length: 0x20 },
        { name: "fpu", start: 0xF0, length: 0x10 },
        { name: "sb16", start: 0x220, length: 0x10 },
        { name: "fdc", start: 0x3F2, length: 4 },
        { name: "fdc-dir", start: 0x3F7, length: 1 },
        { name: "elcr", start: 0x4D0, length: 2 },
        { name: "fw-cfg", start: FW_CFG_PORT, length: 2 },
        { name: "pci-config", start: 0xCF8, length: 8 },
        { name: "gpe0", start: ACPI_GPE0_BASE, length: ACPI_GPE0_LENGTH },
    ];

    for(const { index, port } of platform.uarts)
    {
        ranges.push({ name: "uart" + index, start: port, length: 8 });
    }
    for(const { index, port } of platform.parallel_ports)
    {
        ranges.push({ name: "parallel" + index, start: port, length: 8 });
    }
    if(pm_base !== undefined)
    {
        ranges.push({ name: "acpi-pm", start: pm_base, length: ACPI_PM_LENGTH });
    }

    return ranges;
}

/**
 * @param {Platform} platform
 * @param {number=} pm_base
 */
export function check_platform(platform, pm_base)
{
    const ranges = platform_io_ranges(platform, pm_base).sort((a, b) => a.start - b.start);

    for(let i = 1; i < ranges.length; i++)
    {
        const a = ranges[i - 1];
        const b = ranges[i];
        if(a.start + a.length > b.start)
        {
            throw new Error("Platform I/O conflict: " + a.name + " " + h(a.start, 4) + " overlaps " + b.name + " " + h(b.start, 4));
        }
    }

    dbg_assert(platform.cores >= 1 && platform.apic_ids.length === platform.cores);
    dbg_assert(platform.pci_mmio_start <= 0xE0000000, "RAM overlaps the PCI memory window");
}
