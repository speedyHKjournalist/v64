#!/usr/bin/env node

// Device-level tests of the ACPI fixed hardware (src/acpi.js) and of shared
// level-triggered IRQ lines (CPU.set_shared_irq_level). Ports are accessed
// directly with an injected clock; no guest code runs.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// PM base as SeaBIOS programs it with v86's tables; the device decodes PMBA
const PM_BASE = 0x600;
const PM1_STS = PM_BASE + 0;
const PM1_EN = PM_BASE + 2;
const PM1_CNT = PM_BASE + 4;
const PM_TMR = PM_BASE + 8;
const GLBCTL = PM_BASE + 0x28;
const GPE0_STS = 0xAFE0;
const GPE0_EN = 0xAFE2;
const SMI_CMD = 0xB2;
const FW_CFG_SELECT = 0x510;
const FW_CFG_DATA = 0x511;
const FW_CFG_FILE_DIR = 0x19;
const PCI_CONFIG_ADDRESS = 0xCF8;
const PCI_CONFIG_DATA = 0xCFC;
const RESET_CONTROL = 0xCF9;
const ACPI_PCI_DEVICE = 7;
const PCI_PMBA = 0x40;
const PCI_PMREGMISC = 0x80;

const TMR = 1 << 0;
const PWRBTN = 1 << 8;
const WAK = 1 << 15;
const PM1_EN_DEFINED = 0x0721;
const SCI_EN = 1 << 0;
const BM_RLS = 1 << 1;
const SLP_TYP = 7 << 10;
const SLP_EN = 1 << 13;

const SCI_IRQ = 9;
const OTHER_SOURCE = 0x40; // stands in for a PCI function sharing IRQ 9

const TICKS_PER_MS = 3579545 / 1000;

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    acpi: true,
    autostart: false,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
});

await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));

const cpu = emulator.v86.cpu;
const acpi = cpu.devices.acpi;
const io = cpu.io;

// Line levels as driven through device_raise_irq/device_lower_irq
const line = new Array(24).fill(false);
{
    const raise = cpu.device_raise_irq;
    const lower = cpu.device_lower_irq;
    cpu.device_raise_irq = irq => { line[irq] = true; raise(irq); };
    cpu.device_lower_irq = irq => { line[irq] = false; lower(irq); };
}

// The slave 8259 as laid out in pic.rs (see CPU.set_state_pic)
const pic_slave = () => new Uint8Array(cpu.wasm_memory.buffer, cpu.get_pic_addr_slave(), 13);
const PIC_IRR = 3;
const PIC_ELCR = 10;
const slave_irr_has_irq9 = () => (pic_slave()[PIC_IRR] & 1 << (SCI_IRQ - 8)) !== 0;

let now = 0;
acpi.clock = () => now;

const power_off_events = [];
emulator.add_listener("acpi-power-off", state => power_off_events.push(state));
const sleep_events = [];
emulator.add_listener("acpi-sleep", state => sleep_events.push("sleep " + state));
emulator.add_listener("acpi-wake", cause => sleep_events.push("wake " + cause));

const pci_address = (device, reg) => (0x80000000 | device << 11 | reg & 0xFC) | 0;
function pci_write32(device, reg, value)
{
    io.port_write32(PCI_CONFIG_ADDRESS, pci_address(device, reg));
    io.port_write32(PCI_CONFIG_DATA, value);
}
function pci_write8(device, reg, value)
{
    io.port_write32(PCI_CONFIG_ADDRESS, pci_address(device, reg));
    io.port_write8(PCI_CONFIG_DATA + (reg & 3), value);
}
function pci_read32(device, reg)
{
    io.port_write32(PCI_CONFIG_ADDRESS, pci_address(device, reg));
    return io.port_read32(PCI_CONFIG_DATA);
}

/** What SeaBIOS does in piix4_pm_config_setup */
function program_pm_base(base)
{
    pci_write32(ACPI_PCI_DEVICE, PCI_PMBA, base | 1);
    pci_write8(ACPI_PCI_DEVICE, PCI_PMREGMISC, 1);
}

function power_on()
{
    acpi.reset();
    program_pm_base(PM_BASE);
    for(const sources of cpu.shared_irq_sources)
    {
        sources.clear();
    }
    line.fill(false);
    cpu.device_lower_irq(SCI_IRQ);
    now = 0;
    acpi.timer_offset = 0;
    acpi.timer_last = 0;
    acpi.timer_period = 0;
}

function enable_acpi_mode()
{
    io.port_write8(SMI_CMD, 0xF1);
}

const ms_for_ticks = ticks => ticks / TICKS_PER_MS;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Run before any PCI configuration access: the reset register must already
// exist when a new VM is created (including a VM that will restore a state).
test("reset control is independent of PCI configuration address accesses", () => {
    const reboot = cpu.reboot_internal;
    let resets = 0;
    cpu.reboot_internal = () => { resets++; };
    try
    {
        assert.equal(io.port_read8(RESET_CONTROL), 0);
        io.port_write8(RESET_CONTROL, 0x06);
        assert.equal(resets, 1, "FADT reset works before any access to 0xCF8");

        cpu.devices.pci.reset();
        io.port_write8(RESET_CONTROL, 0x02);
        for(const value of [0x0200, 0x0600])
        {
            io.port_write16(PCI_CONFIG_ADDRESS, value);
            assert.equal(cpu.devices.pci.pci_addr32[0] & 0xFFFF, value);
            io.port_write32(PCI_CONFIG_ADDRESS, pci_address(0, 0) | value);
            assert.equal(cpu.devices.pci.pci_addr32[0], pci_address(0, 0) | value);
            assert.equal(resets, 1, "word/dword config writes never reset the CPU");
            assert.equal(io.port_read8(RESET_CONTROL), 0x02, "config writes preserve RCR");
        }

        io.port_write8(RESET_CONTROL, 0x06); // Linux reboot=pci
        assert.equal(resets, 2);
        io.port_write32(PCI_CONFIG_ADDRESS, pci_address(0, 0));
        io.port_write8(RESET_CONTROL, 0x06);
        assert.equal(resets, 2, "PCI config accesses do not clear the RST_CPU latch");
    }
    finally
    {
        cpu.devices.pci.reset();
        cpu.reboot_internal = reboot;
    }
});

test("an event is latched while disabled and raises the SCI once enabled", () => {
    power_on();
    enable_acpi_mode();
    assert.equal(io.port_read16(PM1_CNT) & SCI_EN, SCI_EN);

    acpi.press_power_button();
    assert.equal(io.port_read16(PM1_STS) & PWRBTN, PWRBTN);
    assert.equal(line[SCI_IRQ], false);

    io.port_write16(PM1_EN, PWRBTN);
    assert.equal(line[SCI_IRQ], true);

    io.port_write16(PM1_STS, PWRBTN);
    assert.equal(io.port_read16(PM1_STS) & PWRBTN, 0);
    assert.equal(line[SCI_IRQ], false);
});

test("SCI_EN gates the SCI, is switched through SMI_CMD and preserved on PM1_CNT writes", () => {
    power_on();
    io.port_write16(PM1_EN, PWRBTN);
    acpi.press_power_button();
    assert.equal(line[SCI_IRQ], false, "no SCI in legacy mode");

    io.port_write16(PM1_CNT, SCI_EN);
    assert.equal(io.port_read16(PM1_CNT) & SCI_EN, 0, "OSPM cannot set SCI_EN");

    io.port_write8(SMI_CMD, 0xF1);
    assert.equal(line[SCI_IRQ], true);
    assert.equal(io.port_read8(SMI_CMD), 0xF1);

    io.port_write16(PM1_CNT, 0);
    assert.equal(io.port_read16(PM1_CNT) & SCI_EN, SCI_EN, "OSPM cannot clear SCI_EN");
    assert.equal(line[SCI_IRQ], true);

    io.port_write8(SMI_CMD, 0xF0);
    assert.equal(line[SCI_IRQ], false);
    assert.equal(io.port_read16(PM1_STS) & PWRBTN, PWRBTN, "status survives ACPI disable");
});

test("with two pending events, clearing one keeps the SCI asserted", () => {
    power_on();
    enable_acpi_mode();
    io.port_write16(PM1_EN, PWRBTN | TMR);
    acpi.press_power_button();
    now = ms_for_ticks((1 << 23) + 10);
    acpi.timer(now);
    assert.equal(io.port_read16(PM1_STS) & (PWRBTN | TMR), PWRBTN | TMR);
    assert.equal(line[SCI_IRQ], true);

    io.port_write16(PM1_STS, PWRBTN);
    assert.equal(line[SCI_IRQ], true);

    io.port_write16(PM1_STS, TMR);
    assert.equal(line[SCI_IRQ], false);
});

for(const first of ["sci", "other"])
{
    test(`SCI and another source share IRQ 9 (cleared ${first} first)`, () => {
        power_on();
        pic_slave()[PIC_ELCR] |= 1 << (SCI_IRQ - 8); // level-triggered, as the guest programs it
        enable_acpi_mode();
        io.port_write16(PM1_EN, PWRBTN);

        acpi.press_power_button();
        cpu.set_shared_irq_level(SCI_IRQ, OTHER_SOURCE, true);
        assert.equal(line[SCI_IRQ], true);
        assert.ok(slave_irr_has_irq9());

        const clear_sci = () => io.port_write16(PM1_STS, PWRBTN);
        const clear_other = () => cpu.set_shared_irq_level(SCI_IRQ, OTHER_SOURCE, false);
        const [a, b] = first === "sci" ? [clear_sci, clear_other] : [clear_other, clear_sci];

        a();
        assert.equal(line[SCI_IRQ], true, "remaining source keeps the line");
        assert.ok(slave_irr_has_irq9(), "remaining source keeps the PIC request");

        b();
        assert.equal(line[SCI_IRQ], false);
        assert.ok(!slave_irr_has_irq9());

        pic_slave()[PIC_ELCR] &= ~(1 << (SCI_IRQ - 8));
    });
}

test("a PCI function lowers the line it asserted even if the guest rerouted the pin", () => {
    power_on();
    const pci = cpu.devices.pci;
    const pci_id = pci.device_spaces.findIndex(space => space && (space[0x3C >> 2] >> 8 & 0xFF) !== 0);
    assert.ok(pci_id >= 0, "a PCI function with an interrupt pin");

    const routing = pci.isa_bridge_space8.slice(0x60, 0x64);
    try
    {
        pci.isa_bridge_space8.fill(10, 0x60, 0x64);
        pci.raise_irq(pci_id);
        assert.equal(line[10], true);

        pci.isa_bridge_space8.fill(11, 0x60, 0x64);
        pci.lower_irq(pci_id);
        assert.equal(line[10], false);
        assert.equal(cpu.shared_irq_sources[10].size, 0);
        assert.equal(cpu.shared_irq_sources[11].size, 0);

        // PIRQ routing disabled (bit 7): the pin reaches no ISA IRQ
        pci.isa_bridge_space8.fill(0x8A, 0x60, 0x64);
        pci.raise_irq(pci_id);
        assert.ok(cpu.shared_irq_sources.every(sources => sources.size === 0));
        pci.lower_irq(pci_id);
        assert.equal(line[10], false);

        // disabling the route while asserted deasserts the old line
        pci.isa_bridge_space8.fill(11, 0x60, 0x64);
        pci.raise_irq(pci_id);
        assert.equal(line[11], true);
        pci.isa_bridge_space8.fill(0x8B, 0x60, 0x64);
        pci.raise_irq(pci_id);
        assert.equal(line[11], false);
        pci.lower_irq(pci_id);
    }
    finally
    {
        pci.isa_bridge_space8.set(routing, 0x60);
    }
});

test("PM1 registers: write-one-to-clear, defined bits only, every access width", () => {
    power_on();
    enable_acpi_mode();
    acpi.press_power_button();
    now = ms_for_ticks((1 << 23) + 1);
    acpi.timer(now);

    io.port_write16(PM1_STS, 0);
    assert.equal(io.port_read16(PM1_STS), PWRBTN | TMR, "writing zero changes nothing");

    io.port_write8(PM1_STS + 1, PWRBTN >> 8);
    assert.equal(io.port_read16(PM1_STS), TMR, "byte write to the upper half");

    io.port_write16(PM1_EN, 0xFFFF);
    assert.equal(io.port_read16(PM1_EN), PM1_EN_DEFINED);
    assert.equal(io.port_read32(PM1_STS) >>> 0, (PM1_EN_DEFINED << 16 | TMR) >>> 0, "dword read of PM1_EVT");
    assert.equal(io.port_read8(PM1_EN + 1), PM1_EN_DEFINED >> 8);

    io.port_write16(PM1_CNT, 0xFFFF & ~SLP_EN);
    assert.equal(io.port_read16(PM1_CNT), SLP_TYP | BM_RLS | SCI_EN, "GBL_RLS/SLP_EN read as zero, reserved bits ignored");
    io.port_write16(PM1_CNT, SCI_EN);

    assert.equal(io.port_read8(PM_BASE + 6), 0);
    assert.equal(io.port_read16(PM_BASE + 0xC), 0);
    assert.equal(io.port_read32(PM_BASE + 0x3C), 0);

    io.port_write32(GLBCTL, 0x12345678);
    assert.equal(io.port_read32(GLBCTL), 0x12345678);
    assert.equal(io.port_read8(GLBCTL + 1), 0x56);
});

test("PM timer: 3.579545 MHz, 24 bits, monotonic, does not advance on reads", () => {
    power_on();
    assert.equal(io.port_read32(PM_TMR), 0);

    now = 1.5;
    const a = io.port_read32(PM_TMR);
    assert.equal(io.port_read32(PM_TMR), a, "repeated reads at the same time");
    assert.equal(io.port_read32(PM_TMR), a);

    now = 1000;
    assert.equal(io.port_read32(PM_TMR), 3579545);
    const bytes = [0, 1, 2, 3].map(i => io.port_read8(PM_TMR + i));
    assert.deepEqual(bytes, [3579545 & 0xFF, 3579545 >> 8 & 0xFF, 3579545 >> 16 & 0xFF, 0]);
    assert.equal(io.port_read16(PM_TMR + 2), 3579545 >> 16);

    now = ms_for_ticks((1 << 24) + 1000);
    const wrapped = io.port_read32(PM_TMR);
    assert.equal(wrapped, Math.floor(now * TICKS_PER_MS) & 0xFFFFFF);
    assert.ok(wrapped < 2000, "wrapped at 24 bits");

    now = 0;
    assert.equal(io.port_read32(PM_TMR), wrapped, "never goes back");

    io.port_write32(PM_TMR, 0);
    assert.equal(io.port_read32(PM_TMR), wrapped, "read-only");
});

test("TMR_STS latches at bit 23 toggles regardless of TMR_EN; timer() reports the deadline", () => {
    power_on();
    enable_acpi_mode();
    assert.equal(acpi.timer(0), 100);

    now = ms_for_ticks((1 << 23) - 100);
    acpi.timer(now);
    assert.equal(io.port_read16(PM1_STS) & TMR, 0);

    now = ms_for_ticks((1 << 23) + 1);
    acpi.timer(now);
    assert.equal(io.port_read16(PM1_STS) & TMR, TMR);
    assert.equal(line[SCI_IRQ], false);

    io.port_write16(PM1_EN, TMR);
    assert.equal(line[SCI_IRQ], true);
    io.port_write16(PM1_STS, TMR);
    assert.equal(line[SCI_IRQ], false);

    // the status is also latched when only PM1_STS is read
    now = ms_for_ticks((1 << 24) + 1);
    assert.equal(io.port_read16(PM1_STS) & TMR, TMR);
    io.port_write16(PM1_STS, TMR);

    now = ms_for_ticks((1 << 24) + 10);
    assert.equal(acpi.timer(now), 100);
    now = ms_for_ticks(3 * (1 << 23) - 5 * TICKS_PER_MS);
    const deadline = acpi.timer(now);
    assert.ok(Math.abs(deadline - 5) < 0.01, "5 ms until the next toggle, got " + deadline);
});

test("GPE0: status is write-one-to-clear, enable is read/write, both feed the SCI", () => {
    power_on();
    enable_acpi_mode();
    io.port_write16(GPE0_EN, 0x0003);
    assert.equal(io.port_read16(GPE0_EN), 0x0003);

    // No GPE source is implemented yet; inject the status bits
    acpi.gpe_sts = 0x0101;
    acpi.update_sci();
    assert.equal(line[SCI_IRQ], true);
    assert.equal(io.port_read32(GPE0_STS) >>> 0, (0x0003 << 16 | 0x0101) >>> 0);

    io.port_write8(GPE0_STS, 0xFF);
    assert.equal(io.port_read16(GPE0_STS), 0x0100);
    assert.equal(line[SCI_IRQ], false, "GPE 8 is not enabled");

    io.port_write8(GPE0_STS + 1, 0x01);
    assert.equal(io.port_read16(GPE0_STS), 0);
    assert.equal(io.port_read8(GPE0_EN + 1), 0);
});

test("SLP_EN: S5 and S4 turn the machine off, unsupported types wake up at once", () => {
    power_on();
    power_off_events.length = 0;

    io.port_write16(PM1_CNT, 5 << 10 | SLP_EN); // a type no sleep state uses
    assert.equal(acpi.soft_off, 0);
    assert.equal(acpi.sleeping, 0);
    assert.equal(io.port_read16(PM1_STS) & WAK, WAK);
    assert.equal(io.port_read16(PM1_CNT) & SLP_EN, 0, "SLP_EN reads as zero");
    io.port_write16(PM1_STS, WAK);
    assert.equal(io.port_read16(PM1_STS) & WAK, 0);

    io.port_write16(PM1_CNT, 0 << 10); // writing SLP_TYP alone does nothing
    assert.equal(acpi.soft_off, 0);

    io.port_write16(PM1_CNT, 2 << 10 | SLP_EN);
    assert.equal(acpi.soft_off, 4);

    power_on();
    io.port_write8(PM1_CNT + 1, SLP_EN >> 8); // byte access, SLP_TYP = 0
    assert.equal(acpi.soft_off, 5);
    io.port_write8(PM1_CNT + 1, SLP_EN >> 8);
    assert.deepEqual(power_off_events, ["S4", "S5"], "one event per power-off");

    power_on();
    assert.equal(acpi.soft_off, 0);
});

const RTC_EVENT = 1 << 10;
const CMOS_SHUTDOWN_STATUS = 0x0F;

test("S3: cores stop, RAM and the BIOS shadow stay, the power button wakes through the resume path", () => {
    power_on();
    sleep_events.length = 0;
    const ram = 0x300000, shadow = 0xFFF00;
    cpu.mem8[ram] = 0x5A;
    const bios_byte = cpu.mem8[shadow];
    cpu.mem8[shadow] = bios_byte ^ 0xFF; // like SeaBIOS's "POST ran" flag in its RAM copy

    io.port_write16(PM1_CNT, SCI_EN | 1 << 10 | SLP_EN); // S3 (SLP_TYP 1)
    assert.equal(acpi.sleeping, 3);
    assert.equal(acpi.soft_off, 0, "not a power-off");
    assert.equal(cpu.devices.rtc.cmos_read(CMOS_SHUTDOWN_STATUS), 0xFE, "SeaBIOS will resume through the FACS waking vector");
    assert.deepEqual(sleep_events, ["sleep S3"]);
    assert.equal(cpu.run_cores() > 0, true, "while asleep only device timers run");

    // a second SLP_EN is ignored while asleep
    io.port_write16(PM1_CNT, 1 << 10 | SLP_EN);
    assert.deepEqual(sleep_events, ["sleep S3"]);

    acpi.press_power_button();
    assert.equal(acpi.sleeping, 0);
    assert.deepEqual(sleep_events, ["sleep S3", "wake power-button"]);
    assert.equal(acpi.pm1_sts & (WAK | PWRBTN), WAK | PWRBTN, "WAK_STS and the cause");
    assert.equal(acpi.pm1_cnt & SCI_EN, 0, "the hardware reset clears SCI_EN (the OS sets it again)");
    assert.equal(cpu.mem8[ram], 0x5A, "RAM kept");
    assert.equal(cpu.mem8[shadow], bios_byte ^ 0xFF, "the BIOS is not reloaded on wake");
    assert.equal(cpu.instruction_pointer[0] >>> 0, 0xFFFF0, "the CPU starts at the reset vector");
    cpu.mem8[shadow] = bios_byte;
});

test("S3: the RTC alarm wakes only with RTC_EN; RTC_STS names the cause", () => {
    power_on();
    enable_acpi_mode();
    sleep_events.length = 0;
    io.port_write16(PM1_CNT, SCI_EN | 1 << 10 | SLP_EN);
    assert.equal(acpi.sleeping, 3);
    acpi.rtc_alarm(); // RTC_EN clear
    assert.equal(acpi.sleeping, 3, "no wake without RTC_EN");
    acpi.press_power_button();
    assert.equal(acpi.sleeping, 0);

    power_on();
    enable_acpi_mode();
    sleep_events.length = 0;
    io.port_write16(PM1_EN, RTC_EVENT);
    io.port_write16(PM1_CNT, SCI_EN | 1 << 10 | SLP_EN);
    assert.equal(acpi.sleeping, 3);
    acpi.rtc_alarm();
    assert.equal(acpi.sleeping, 0);
    assert.deepEqual(sleep_events, ["sleep S3", "wake rtc"]);
    assert.equal(acpi.pm1_sts & (WAK | RTC_EVENT | PWRBTN), WAK | RTC_EVENT);

    // while running, the alarm latches RTC_STS (an SCI when enabled)
    power_on();
    enable_acpi_mode();
    io.port_write16(PM1_EN, RTC_EVENT);
    acpi.rtc_alarm();
    assert.equal(io.port_read16(PM1_STS) & RTC_EVENT, RTC_EVENT);
    assert.equal(line[SCI_IRQ], true);
});

test("S3 survives a snapshot: the restored machine is asleep and wakes", () => {
    power_on();
    io.port_write16(PM1_CNT, SCI_EN | 1 << 10 | SLP_EN);
    const state = acpi.get_state();
    acpi.press_power_button();
    assert.equal(acpi.sleeping, 0);
    acpi.set_state(state);
    assert.equal(acpi.sleeping, 3, "format 3 keeps the sleeping state");
    acpi.press_power_button();
    assert.equal(acpi.sleeping, 0);

    // a format 2 image (before S3) is awake
    const old = state.slice(0, 10);
    old[4] = 2;
    acpi.set_state(old);
    assert.equal(acpi.sleeping, 0);
});

test("fw_cfg etc/system-states advertises S3, S4 and S5", () => {
    const file = cpu.option_roms.find(f => f.name === "etc/system-states");
    assert.ok(file);
    assert.deepEqual(Array.from(file.data), [0x80, 0, 0, 0x81, 0x82, 0x80]);

    // Read it through the fw_cfg ports, as SeaBIOS does
    const read_bytes = n => Array.from({ length: n }, () => io.port_read8(FW_CFG_DATA));
    const be = bytes => bytes.reduce((v, b) => v * 256 + b, 0);

    io.port_write16(FW_CFG_SELECT, FW_CFG_FILE_DIR);
    const count = be(read_bytes(4));
    let select = -1;
    for(let i = 0; i < count; i++)
    {
        const size = be(read_bytes(4));
        const sel = be(read_bytes(2));
        read_bytes(2);
        const name = String.fromCharCode(...read_bytes(56)).replace(/\0.*$/s, "");
        if(name === "etc/system-states")
        {
            assert.equal(size, 6);
            select = sel;
        }
    }
    assert.ok(select >= 0, "listed in the file directory");

    io.port_write16(FW_CFG_SELECT, select);
    assert.deepEqual(read_bytes(6), [0x80, 0, 0, 0x81, 0x82, 0x80]);
});

test("snapshot: registers, timer phase and SCI survive save_state/restore_state", async () => {
    power_on();
    pic_slave()[PIC_ELCR] |= 1 << (SCI_IRQ - 8);
    enable_acpi_mode();
    io.port_write16(PM1_EN, PWRBTN);
    io.port_write16(GPE0_EN, 0x0004);
    io.port_write32(GLBCTL, 1);
    acpi.press_power_button();
    cpu.set_shared_irq_level(SCI_IRQ, OTHER_SOURCE, true);
    now = 500;
    const timer = io.port_read32(PM_TMR);
    const registers = () => [PM1_STS, PM1_EN, PM1_CNT, GPE0_STS, GPE0_EN].map(port => io.port_read16(port));
    const before = registers();

    io.port_write8(RESET_CONTROL, 0x02);
    const state = await emulator.save_state();

    power_on();
    program_pm_base(0xB000);
    cpu.devices.pci.reset();
    io.port_write16(PM1_EN, 0);
    now = 10000; // host time moved on while the image was stored

    await emulator.restore_state(state);
    assert.equal(acpi.pm_base, PM_BASE, "PM decode follows the restored PCI configuration");
    assert.equal(io.port_read32(0xB008), -1, "the pre-restore mapping is released");
    assert.equal(io.port_read8(RESET_CONTROL), 0x02, "RCR survives restore");
    assert.deepEqual(registers(), before);
    assert.equal(io.port_read32(GLBCTL), 1);
    assert.equal(io.port_read32(PM_TMR), timer, "the timer continues from the saved value");
    now = 10100;
    assert.equal(io.port_read32(PM_TMR), timer + Math.floor(100 * TICKS_PER_MS));

    assert.deepEqual([...cpu.shared_irq_sources[SCI_IRQ]].sort(), [OTHER_SOURCE, 0x100].sort());
    assert.ok(slave_irr_has_irq9());

    // The other source leaving must not drop the SCI
    cpu.set_shared_irq_level(SCI_IRQ, OTHER_SOURCE, false);
    assert.ok(slave_irr_has_irq9());
    io.port_write16(PM1_STS, PWRBTN);
    assert.ok(!slave_irr_has_irq9());
    pic_slave()[PIC_ELCR] &= ~(1 << (SCI_IRQ - 8));
});

test("snapshot restores both enabled and disabled PM I/O decode", async () => {
    power_on();
    io.port_write16(PM1_EN, PWRBTN);
    const enabled_state = await emulator.save_state();
    acpi.reset();
    const disabled_state = await emulator.save_state();

    await emulator.restore_state(enabled_state);
    assert.equal(acpi.pm_base, PM_BASE);
    assert.equal(io.port_read16(PM1_EN), PWRBTN, "restore enables a previously disabled PM block");

    await emulator.restore_state(disabled_state);
    assert.equal(acpi.pm_base, -1);
    assert.equal(io.port_read16(PM1_EN), 0xFFFF, "restore disables a previously enabled PM block");
});

test("state images from before the rewrite are imported", () => {
    power_on();
    enable_acpi_mode();
    now = 0;
    // format 1: [PM1_CNT as written, PM1_STS, PM1_EN, raw GPE bytes]
    acpi.set_state([0x2001, PWRBTN, PWRBTN, new Uint8Array([0xFF, 0xFF, 0x01, 0x00])]);
    acpi.sync_sci();
    assert.equal(io.port_read16(PM1_CNT), SCI_EN, "SLP_EN dropped, SCI_EN kept");
    assert.equal(io.port_read16(GPE0_STS), 0, "stale GPE status bytes dropped");
    assert.equal(io.port_read16(GPE0_EN), 1);
    assert.equal(line[SCI_IRQ], true, "pending enabled event raises the SCI");
    assert.equal(acpi.soft_off, 0);
});

test("reset returns to power-on values, releases the SCI and keeps the timer running", () => {
    power_on();
    enable_acpi_mode();
    io.port_write16(PM1_EN, PWRBTN);
    acpi.press_power_button();
    assert.equal(line[SCI_IRQ], true);
    now = 20;
    const timer = io.port_read32(PM_TMR);

    acpi.reset();
    assert.equal(line[SCI_IRQ], false);
    assert.equal(io.port_read16(PM1_STS), 0xFFFF, "PCIRST# disables the PM I/O space");
    program_pm_base(PM_BASE);
    assert.deepEqual([PM1_STS, PM1_EN, PM1_CNT, GPE0_STS, GPE0_EN].map(port => io.port_read16(port)), [0, 0, 0, 0, 0]);
    assert.equal(io.port_read32(PM_TMR), timer);
});

test("a machine reset deasserts every shared source (like PCIRST#)", () => {
    power_on();
    cpu.set_shared_irq_level(11, OTHER_SOURCE, true);
    enable_acpi_mode();
    io.port_write16(PM1_EN, PWRBTN);
    acpi.press_power_button();
    assert.equal(line[11], true);
    assert.equal(line[SCI_IRQ], true);

    cpu.reboot_internal();
    assert.equal(line[11], false);
    assert.equal(line[SCI_IRQ], false);
    assert.ok(cpu.shared_irq_sources.every(sources => sources.size === 0));
    assert.equal(acpi.pm1_cnt & SCI_EN, 0, "legacy mode after reset");
    assert.equal(io.port_read16(PM1_CNT), 0xFFFF, "PM I/O space disabled until the firmware programs PMBA");
});

test("the PM block is decoded at PMBA once PMREGMISC enables it", () => {
    power_on();
    now = 1000;
    const timer = io.port_read32(PM_TMR);
    assert.equal(timer, 3579545);

    program_pm_base(0xB000);
    assert.equal(io.port_read32(0xB008), timer, "moved");
    assert.equal(io.port_read32(PM_TMR), -1, "old base released");

    pci_write8(ACPI_PCI_DEVICE, PCI_PMREGMISC, 0);
    assert.equal(io.port_read32(0xB008), -1, "disabled");

    pci_write32(ACPI_PCI_DEVICE, PCI_PMBA, 0xB0FF);
    assert.equal(pci_read32(ACPI_PCI_DEVICE, PCI_PMBA), 0xB0C1, "reserved bits read as 0, bit 0 as 1");
    pci_write8(ACPI_PCI_DEVICE, PCI_PMREGMISC, 1);
    assert.equal(io.port_read32(0xB0C8), timer, "64-byte aligned base");

    program_pm_base(PM_BASE);
    assert.equal(io.port_read32(0xB0C8), -1);
    assert.equal(io.port_read32(PM_TMR), timer);
});

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

console.log(`${tests.length - failed}/${tests.length} ACPI device tests passed`);
await emulator.destroy();
process.exit(failed ? 1 : 0);
