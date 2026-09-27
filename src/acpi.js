// ACPI fixed hardware of the PIIX4 power management function (PCI 00:07.0).
//
// Block addresses and sizes match the FADT that SeaBIOS 1.16.2 builds for this
// device (src/fw/acpi.c, piix4_fadt_setup): PM1a event block at 0xB000
// (4 bytes), PM1a control block at 0xB004 (2 bytes), 24-bit PM timer at 0xB008,
// GPE0 block at 0xAFE0 (4 bytes, 16 GPEs), SCI on IRQ 9, SMI_CMD at 0xB2 with
// ACPI_ENABLE = 0xF1 and ACPI_DISABLE = 0xF0. The FADT flags leave PWR_BUTTON
// and FIX_RTC clear, so the power button and RTC status are fixed features.
//
// Register semantics: ACPI 6.6, section 4.8 (fixed hardware registers)
// https://uefi.org/specs/ACPI/6.6/04_ACPI_Hardware_Specification.html

import { v86 } from "./main.js";
import { LOG_ACPI } from "../src/const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

export const ACPI_PM_BASE = 0xB000;
const ACPI_PM_LENGTH = 0x40;
export const ACPI_GPE0_BASE = 0xAFE0;
const ACPI_GPE0_LENGTH = 4;
export const ACPI_SMI_CMD_PORT = 0xB2;
export const ACPI_SCI_IRQ = 9;

/** Source id of the SCI on its (possibly shared) IRQ line; PCI functions use their pci_id */
export const ACPI_SCI_SOURCE = 0x100;

const ACPI_ENABLE = 0xF1;
const ACPI_DISABLE = 0xF0;

const PM_TIMER_TICKS_PER_MS = 3579545 / 1000;
// TMR_STS is set whenever bit 23 of the 24-bit timer changes
const PM_TIMER_STATUS_PERIOD = 1 << 23;

// PM1_STS and PM1_EN bits
const TMR = 1 << 0;
const BM = 1 << 4;
const GBL = 1 << 5;
const PWRBTN = 1 << 8;
const SLPBTN = 1 << 9;
const RTC = 1 << 10;
const WAK = 1 << 15;

const PM1_STS_MASK = TMR | BM | GBL | PWRBTN | SLPBTN | RTC | WAK;
const PM1_EN_MASK = TMR | GBL | PWRBTN | SLPBTN | RTC;

// PM1_CNT bits
const SCI_EN = 1 << 0;
const BM_RLS = 1 << 1;
const SLP_TYP_SHIFT = 10;
const SLP_TYP = 7 << SLP_TYP_SHIFT;
const SLP_EN = 1 << 13;

// SCI_EN belongs to the hardware (changed through SMI_CMD, preserved by
// OSPM); GBL_RLS and SLP_EN are write-only and read as zero
const PM1_CNT_WRITABLE = BM_RLS | SLP_TYP;

// PIIX4 GLBCTL: SeaBIOS sets SMI_EN in it. Without SMM it is plain storage.
const PM_GLBCTL = 0x28;

const STATE_FORMAT = 2;

/**
 * Sleep states of this platform. The SLP_TYP values must match the \_Sx
 * packages of the firmware tables: SeaBIOS's SSDT (ssdt-misc.dsl) has
 * _S3_ = 1 and _S5_ = 0, while _S4_ gets its value from etc/system-states
 * (below). A state is only advertised to the guest when it is supported.
 */
export const ACPI_SLEEP_STATES = [
    // S3 (suspend to RAM): not implemented
    { state: 3, slp_typ: 1, supported: false },
    // S4 (OS-directed hibernation, a soft off for the hardware): not validated yet
    { state: 4, slp_typ: 2, supported: false },
    // S5 (soft off)
    { state: 5, slp_typ: 0, supported: true },
];

/**
 * Contents of the fw_cfg file etc/system-states, read by SeaBIOS's ACPI
 * builder: indexed by sleep state, bit 7 = advertised, bits 0-6 = SLP_TYP.
 * @return {!Uint8Array}
 */
export function acpi_system_states_file()
{
    const states = new Uint8Array(6);
    states[0] = 0x80;
    for(const { state, slp_typ, supported } of ACPI_SLEEP_STATES)
    {
        states[state] = (supported ? 0x80 : 0) | slp_typ;
    }
    return states;
}

/**
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function ACPI(cpu, bus)
{
    /** @type {CPU} */
    this.cpu = cpu;

    /** @const */
    this.bus = bus;

    /**
     * Time in milliseconds for port reads and snapshots. timer() gets the
     * same time from the main loop. Tests may replace it.
     * @type {function():number}
     */
    this.clock = () => v86.microtick();

    const acpi = {
        pci_id: 0x07 << 3,
        pci_space: [
            0x86, 0x80, 0x13, 0x71, 0x07, 0x00, 0x80, 0x02, 0x08, 0x00, 0x80, 0x06, 0x00, 0x00, 0x80, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x01, 0x00, 0x00,
        ],
        pci_bars: [],
        name: "acpi",
    };

    // 00:07.0 Bridge: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)
    cpu.devices.pci.register_device(acpi);

    this.pm1_sts = 0;
    this.pm1_en = 0;
    this.pm1_cnt = 0;
    this.gpe_sts = 0;
    this.gpe_en = 0;
    this.smi_cmd = 0;
    this.glbctl = 0;

    /**
     * 0 while the machine is on, otherwise the sleeping state (4 or 5) the
     * guest used to turn it off
     */
    this.soft_off = 0;

    /** Level this device currently drives on the SCI line */
    this.sci_level = false;

    // The PM timer counts from 0 at power-on. timer_last keeps it monotonic,
    // timer_offset keeps it continuous across snapshots (like the TSC).
    this.timer_last = 0;
    this.timer_offset = -Math.floor(this.clock() * PM_TIMER_TICKS_PER_MS);
    this.timer_period = 0;

    const io = cpu.io;
    this.register_block(io, ACPI_PM_BASE, ACPI_PM_LENGTH, this.pm_read, this.pm_write);
    this.register_block(io, ACPI_GPE0_BASE, ACPI_GPE0_LENGTH, this.gpe_read, this.gpe_write);

    io.register_read(ACPI_SMI_CMD_PORT, this,
        () => this.smi_cmd,
        () => this.smi_cmd,
        () => this.smi_cmd);
    io.register_write(ACPI_SMI_CMD_PORT, this,
        value => this.smi_cmd_write(value & 0xFF),
        value => this.smi_cmd_write(value & 0xFF),
        value => this.smi_cmd_write(value & 0xFF));
}

/**
 * Registers every access width on every port of a register block. Accesses
 * wider than a byte are handled as one access, so a register read cannot tear.
 * @param {Object} io
 * @param {number} base
 * @param {number} length
 * @param {function(this:ACPI, number, number):number} read
 * @param {function(this:ACPI, number, number, number)} write
 */
ACPI.prototype.register_block = function(io, base, length, read, write)
{
    for(let offset = 0; offset < length; offset++)
    {
        io.register_read(base + offset, this,
            () => read.call(this, offset, 1),
            () => read.call(this, offset, 2),
            () => read.call(this, offset, 4));
        io.register_write(base + offset, this,
            value => write.call(this, offset, 1, value),
            value => write.call(this, offset, 2, value),
            value => write.call(this, offset, 4, value));
    }
};

ACPI.prototype.pm_read = function(offset, size)
{
    let timer = 0;
    if(offset < 12 && offset + size > 8 || offset < 2)
    {
        const ticks = this.timer_ticks(this.clock());
        timer = ticks & 0xFFFFFF;
        this.update_timer_status(ticks);
    }

    let value = 0;
    for(let i = 0; i < size; i++)
    {
        value |= this.pm_read_byte(offset + i, timer) << (i << 3);
    }
    return value;
};

ACPI.prototype.pm_read_byte = function(offset, timer)
{
    switch(offset)
    {
        case 0: return this.pm1_sts & 0xFF;
        case 1: return this.pm1_sts >> 8;
        case 2: return this.pm1_en & 0xFF;
        case 3: return this.pm1_en >> 8;
        case 4: return this.pm1_cnt & 0xFF;
        case 5: return this.pm1_cnt >> 8;
        case 8: return timer & 0xFF;
        case 9: return timer >> 8 & 0xFF;
        case 10: return timer >> 16 & 0xFF;
        case PM_GLBCTL: case PM_GLBCTL + 1: case PM_GLBCTL + 2: case PM_GLBCTL + 3:
            return this.glbctl >>> ((offset - PM_GLBCTL) << 3) & 0xFF;
        default:
            // reserved, and the upper byte of the 24-bit timer
            return 0;
    }
};

ACPI.prototype.pm_write = function(offset, size, value)
{
    dbg_log("ACPI PM write" + (size << 3) + " offset=" + h(offset, 2) + " value=" + h(value >>> 0), LOG_ACPI);

    let sleep = false;

    for(let i = 0; i < size; i++)
    {
        const o = offset + i;
        const shift = (o & 1) << 3;
        const byte = value >>> (i << 3) & 0xFF;
        const bits = byte << shift;
        const byte_mask = 0xFF << shift;

        switch(o)
        {
            case 0: case 1:
                // write one to clear
                this.pm1_sts &= ~(bits & PM1_STS_MASK);
                break;
            case 2: case 3:
                this.pm1_en = (this.pm1_en & ~byte_mask | bits) & PM1_EN_MASK;
                break;
            case 4: case 5:
                this.pm1_cnt = this.pm1_cnt & ~(byte_mask & PM1_CNT_WRITABLE) | bits & PM1_CNT_WRITABLE;
                sleep = sleep || (bits & SLP_EN) !== 0;
                break;
            case PM_GLBCTL: case PM_GLBCTL + 1: case PM_GLBCTL + 2: case PM_GLBCTL + 3:
            {
                const glbctl_shift = (o - PM_GLBCTL) << 3;
                this.glbctl = this.glbctl & ~(0xFF << glbctl_shift) | byte << glbctl_shift;
                break;
            }
            default:
                // the timer is read-only; everything else is reserved
                break;
        }
    }

    this.update_sci();

    if(sleep)
    {
        this.enter_sleep_state((this.pm1_cnt & SLP_TYP) >> SLP_TYP_SHIFT);
    }
};

ACPI.prototype.gpe_read = function(offset, size)
{
    const value = (this.gpe_sts | this.gpe_en << 16) >>> (offset << 3);
    return size === 4 ? value | 0 : value & ((1 << (size << 3)) - 1);
};

ACPI.prototype.gpe_write = function(offset, size, value)
{
    dbg_log("ACPI GPE write" + (size << 3) + " offset=" + offset + " value=" + h(value >>> 0), LOG_ACPI);

    for(let i = 0; i < size && offset + i < ACPI_GPE0_LENGTH; i++)
    {
        const o = offset + i;
        const shift = (o & 1) << 3;
        const bits = (value >>> (i << 3) & 0xFF) << shift;

        if(o < 2)
        {
            // GPE0_STS: write one to clear
            this.gpe_sts &= ~bits;
        }
        else
        {
            this.gpe_en = this.gpe_en & ~(0xFF << shift) | bits;
        }
    }

    this.update_sci();
};

/**
 * Port 0xB2 (APM control). The FADT names it SMI_CMD: OSPM writes
 * ACPI_ENABLE/ACPI_DISABLE to switch SCI_EN. On real hardware this goes
 * through an SMI handler; v86 has no SMM, so the device switches it.
 */
ACPI.prototype.smi_cmd_write = function(value)
{
    this.smi_cmd = value;

    if(value === ACPI_ENABLE)
    {
        dbg_log("ACPI enable", LOG_ACPI);
        this.pm1_cnt |= SCI_EN;
        this.update_sci();
    }
    else if(value === ACPI_DISABLE)
    {
        dbg_log("ACPI disable", LOG_ACPI);
        this.pm1_cnt &= ~SCI_EN;
        this.update_sci();
    }
};

/**
 * The SCI is a level-triggered interrupt: it stays asserted while an
 * enabled fixed event or GPE is pending and SCI_EN is set.
 */
ACPI.prototype.update_sci = function()
{
    const level = (this.pm1_cnt & SCI_EN) !== 0 &&
        ((this.pm1_sts & this.pm1_en & PM1_EN_MASK) !== 0 || (this.gpe_sts & this.gpe_en) !== 0);

    if(level !== this.sci_level)
    {
        dbg_log("ACPI SCI " + (level ? "raise" : "lower"), LOG_ACPI);
        this.sci_level = level;
        this.cpu.set_shared_irq_level(ACPI_SCI_IRQ, ACPI_SCI_SOURCE, level);
    }
};

/**
 * Re-derive the SCI after the interrupt controllers were restored from a
 * snapshot: sci_level must describe the restored line, not the pre-restore one.
 */
ACPI.prototype.sync_sci = function()
{
    this.sci_level = this.cpu.shared_irq_sources[ACPI_SCI_IRQ].has(ACPI_SCI_SOURCE);
    this.update_sci();
};

ACPI.prototype.enter_sleep_state = function(slp_typ)
{
    const sleep_state = ACPI_SLEEP_STATES.find(s => s.slp_typ === slp_typ);

    if(sleep_state && sleep_state.state >= 4)
    {
        // S4 and S5 turn the machine off; for S4 the guest resumes from disk
        // at the next power-on
        this.power_off(sleep_state.state);
    }
    else
    {
        // Sleeping states that are not implemented: behave as if a wake event
        // arrived immediately, so that the guest does not wait forever
        dbg_log("ACPI: sleep type " + slp_typ + " not supported, waking up", LOG_ACPI);
        this.pm1_sts |= WAK;
    }
};

ACPI.prototype.power_off = function(sleep_state)
{
    if(this.soft_off)
    {
        return;
    }

    dbg_log("ACPI: soft off (S" + sleep_state + ")", LOG_ACPI);
    this.soft_off = sleep_state;
    this.bus.send("acpi-power-off", "S" + sleep_state);
};

/**
 * Press the power button of a running machine. The guest sees a fixed
 * power button event; with SCI_EN clear (no ACPI OS) nothing happens.
 */
ACPI.prototype.press_power_button = function()
{
    this.pm1_sts |= PWRBTN;
    this.update_sci();
};

/** Hardware reset: the registers return to their power-on values; the PM timer keeps running */
ACPI.prototype.reset = function()
{
    this.pm1_sts = 0;
    this.pm1_en = 0;
    this.pm1_cnt = 0;
    this.gpe_sts = 0;
    this.gpe_en = 0;
    this.smi_cmd = 0;
    this.glbctl = 0;
    this.soft_off = 0;
    this.update_sci();
};

/**
 * PM timer ticks since power-on (not truncated to 24 bits). Monotonic; it
 * advances with time only, not with the number of reads.
 * @param {number} now
 * @return {number}
 */
ACPI.prototype.timer_ticks = function(now)
{
    const ticks = Math.floor(now * PM_TIMER_TICKS_PER_MS) + this.timer_offset;

    if(ticks > this.timer_last)
    {
        this.timer_last = ticks;
    }

    return this.timer_last;
};

ACPI.prototype.update_timer_status = function(ticks)
{
    const period = Math.floor(ticks / PM_TIMER_STATUS_PERIOD);

    if(period !== this.timer_period)
    {
        this.timer_period = period;
        this.pm1_sts |= TMR;
        this.update_sci();
    }
};

/**
 * Called from the main loop
 * @param {number} now
 * @return {number} milliseconds until this device needs to be called again
 */
ACPI.prototype.timer = function(now)
{
    const ticks = this.timer_ticks(now);
    this.update_timer_status(ticks);

    if((this.pm1_en & TMR) && (this.pm1_cnt & SCI_EN))
    {
        const next = (this.timer_period + 1) * PM_TIMER_STATUS_PERIOD;
        return Math.min(100, (next - ticks) / PM_TIMER_TICKS_PER_MS);
    }

    return 100;
};

ACPI.prototype.get_state = function()
{
    const state = [];
    state[0] = this.pm1_cnt;
    state[1] = this.pm1_sts;
    state[2] = this.pm1_en;
    state[3] = new Uint8Array([this.gpe_sts & 0xFF, this.gpe_sts >> 8, this.gpe_en & 0xFF, this.gpe_en >> 8]);
    state[4] = STATE_FORMAT;
    state[5] = this.timer_ticks(this.clock());
    state[6] = this.timer_period;
    state[7] = this.smi_cmd;
    state[8] = this.glbctl;
    state[9] = this.soft_off;
    return state;
};

ACPI.prototype.set_state = function(state)
{
    const gpe = state[3];
    this.pm1_sts = state[1] & PM1_STS_MASK;
    this.pm1_en = state[2] & PM1_EN_MASK;
    this.gpe_en = gpe[2] | gpe[3] << 8;

    let ticks = 0;

    if(state[4] === undefined)
    {
        // Before STATE_FORMAT 2, PM1_CNT was stored as last written (including
        // SLP_EN), the GPE bytes were raw storage (status bits the guest had
        // cleared read back as set) and the timer phase was not saved.
        this.pm1_cnt = state[0] & (SCI_EN | PM1_CNT_WRITABLE);
        this.gpe_sts = 0;
        this.smi_cmd = 0;
        this.glbctl = 0;
        this.soft_off = 0;
    }
    else
    {
        this.pm1_cnt = state[0] & (SCI_EN | PM1_CNT_WRITABLE);
        this.gpe_sts = gpe[0] | gpe[1] << 8;
        ticks = state[5];
        this.timer_period = state[6];
        this.smi_cmd = state[7];
        this.glbctl = state[8];
        this.soft_off = state[9];
    }

    this.timer_offset = ticks - Math.floor(this.clock() * PM_TIMER_TICKS_PER_MS);
    this.timer_last = ticks;
    if(state[4] === undefined)
    {
        this.timer_period = Math.floor(ticks / PM_TIMER_STATUS_PERIOD);
    }
    // sci_level is re-derived by sync_sci once the interrupt controllers are restored
};
