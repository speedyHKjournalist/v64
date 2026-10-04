// The TCO watchdog of the Q35 machine's ICH9: registers at PMBASE + 0x60
// (src/acpi.js forwards them), a timer that counts down in 0.6 s ticks. Its
// first timeout sets TCO1_STS.TIMEOUT (and SMI_STS.TCO_STS); the second, if
// software did not reload the timer in between, sets TCO2_STS.SECOND_TO_STS
// and BOOT_STS and resets the machine unless NO_REBOOT (RCBA GCS bit 5,
// set at reset) forbids it. Linux's iTCO_wdt clears NO_REBOOT, programs
// TCO_TMR and reloads through TCO_RLD.
// ICH9 datasheet (316972), 13.9; QEMU hw/acpi/tco.c, whose behaviour this
// follows (the timer does not run until software reloads it or clears
// TCO_TMR_HLT), except that the status registers are write-one-to-clear as
// on the hardware.

import { LOG_ACPI } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";

/** The TCO registers' offset in the ICH9 PM I/O block */
export const ICH9_PM_TCO = 0x60;
export const ICH9_TCO_LENGTH = 0x20;

const TICK_MS = 600;

const TCO_RLD = 0x00;
const TCO_DAT_IN = 0x02;
const TCO_DAT_OUT = 0x03;
const TCO1_STS = 0x04;
const TCO2_STS = 0x06;
const TCO1_CNT = 0x08;
const TCO2_CNT = 0x0A;
const TCO_MESSAGE1 = 0x0C;
const TCO_MESSAGE2 = 0x0D;
const TCO_WDCNT = 0x0E;
const SW_IRQ_GEN = 0x10;
const TCO_TMR = 0x12;

// TCO1_STS
const TCO_INT_STS = 1 << 2;
const SW_TCO_SMI = 1 << 1;
const TCO_TIMEOUT = 1 << 3;
// TCO2_STS
const SECOND_TO_STS = 1 << 1;
const BOOT_STS = 1 << 2;
// TCO1_CNT
const TCO_TMR_HLT = 1 << 11;
const TCO_LOCK = 1 << 12;
const TCO1_CNT_WRITABLE = 0x1F00;

/** SMI_STS.TCO_STS and SMI_EN.TCO_EN */
export const SMI_TCO = 1 << 13;

/** RCBA GCS: NO_REBOOT */
const RCBA_GCS = 0x3410;
const GCS_NO_REBOOT = 1 << 5;

const STATE_FORMAT = 1;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {function()} smi a TCO SMI (SMI_STS.TCO_STS)
 */
export function TCO(cpu, smi)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    this.smi = smi;
    this.reset();
}

TCO.prototype.reset = function()
{
    /** TCO_RLD while the timer is stopped */
    this.rld = 0;
    this.dat_in = 0;
    this.dat_out = 0;
    this.sts1 = 0;
    this.sts2 = 0;
    this.cnt1 = 0;
    this.cnt2 = 0x0008;
    this.message1 = 0;
    this.message2 = 0;
    this.wdcnt = 0;
    this.sw_irq_gen = 0x03;
    this.tmr = 0x0004;
    /** Machine clock time of the next timeout, or -1: stopped */
    this.expire_time = -1;
    /** Timeouts since the last reload */
    this.timeouts = 0;
};

/** The timer may run: not halted, and no second timeout pending (BOOT_STS) */
TCO.prototype.can_start = function()
{
    return !(this.cnt1 & TCO_TMR_HLT) && !(this.sts2 & BOOT_STS);
};

/** TCO_RLD: the timer starts again from TCO_TMR, if it may run */
TCO.prototype.reload = function()
{
    this.timeouts = 0;
    if(this.can_start())
    {
        this.rld = this.tmr & 0x3FF;
        this.expire_time = this.cpu.clock.now() + this.rld * TICK_MS;
    }
    else
    {
        this.expire_time = -1;
    }
};

/**
 * @param {number} now machine clock, ms
 * @return {number} ms until the next timeout (at most 100)
 */
TCO.prototype.timer = function(now)
{
    if(this.expire_time === -1)
    {
        return 100;
    }
    if(now >= this.expire_time)
    {
        this.timeout();
        if(this.expire_time === -1)
        {
            return 100;
        }
    }
    return Math.min(100, Math.max(0, this.expire_time - now));
};

/** The timer reached zero */
TCO.prototype.timeout = function()
{
    this.rld = 0;
    this.sts1 |= TCO_TIMEOUT;
    this.timeouts++;
    dbg_log("TCO timeout " + this.timeouts, LOG_ACPI);
    if(this.timeouts === 2)
    {
        this.sts2 |= SECOND_TO_STS | BOOT_STS;
        this.timeouts = 0;
        const q35 = this.cpu.devices.q35;
        if(q35 && !(q35.rcba[RCBA_GCS] & GCS_NO_REBOOT))
        {
            dbg_log("TCO: second timeout, reset", LOG_ACPI);
            this.expire_time = -1;
            this.cpu.reboot_internal("tco");
            return;
        }
    }
    this.smi();
    // (it goes on from TCO_TMR; BOOT_STS keeps it stopped)
    if(this.can_start())
    {
        this.rld = this.tmr & 0x3FF;
        this.expire_time += this.rld * TICK_MS;
    }
    else
    {
        this.expire_time = -1;
    }
};

/**
 * @param {number} offset in the TCO block
 * @return {number}
 */
TCO.prototype.read_byte = function(offset)
{
    const word = (value, at) => value >> ((offset - at) << 3) & 0xFF;
    switch(offset)
    {
        case TCO_RLD: case TCO_RLD + 1:
        {
            // the ticks left
            const rld = this.expire_time === -1 ? this.rld :
                Math.max(0, Math.floor((this.expire_time - this.cpu.clock.now()) / TICK_MS));
            return word(rld, TCO_RLD);
        }
        case TCO_DAT_IN: return this.dat_in;
        case TCO_DAT_OUT: return this.dat_out;
        case TCO1_STS: case TCO1_STS + 1: return word(this.sts1, TCO1_STS);
        case TCO2_STS: case TCO2_STS + 1: return word(this.sts2, TCO2_STS);
        case TCO1_CNT: case TCO1_CNT + 1: return word(this.cnt1, TCO1_CNT);
        case TCO2_CNT: case TCO2_CNT + 1: return word(this.cnt2, TCO2_CNT);
        case TCO_MESSAGE1: return this.message1;
        case TCO_MESSAGE2: return this.message2;
        case TCO_WDCNT: return this.wdcnt;
        case SW_IRQ_GEN: return this.sw_irq_gen;
        case TCO_TMR: case TCO_TMR + 1: return word(this.tmr, TCO_TMR);
    }
    return 0;
};

/**
 * @param {number} offset in the TCO block
 * @param {number} byte
 */
TCO.prototype.write_byte = function(offset, byte)
{
    dbg_log("TCO write " + h(offset, 2) + " <- " + h(byte, 2), LOG_ACPI);
    const shift = (offset & 1) << 3;
    const merge = old => old & ~(0xFF << shift) | byte << shift;
    switch(offset)
    {
        case TCO_RLD: case TCO_RLD + 1:
            // any write reloads the timer (and restarts the count of timeouts)
            this.reload();
            break;
        case TCO_DAT_IN:
            this.dat_in = byte;
            this.sts1 |= SW_TCO_SMI;
            this.smi();
            break;
        case TCO_DAT_OUT:
            this.dat_out = byte;
            this.sts1 |= TCO_INT_STS;
            break;
        case TCO1_STS: case TCO1_STS + 1:
            this.sts1 &= ~(byte << shift);
            break;
        case TCO2_STS: case TCO2_STS + 1:
            this.sts2 &= ~(byte << shift);
            break;
        case TCO1_CNT: case TCO1_CNT + 1:
        {
            // TCO_LOCK, once set, stays until a reset
            const old = this.cnt1;
            this.cnt1 = merge(this.cnt1) & TCO1_CNT_WRITABLE | old & TCO_LOCK;
            if((old ^ this.cnt1) & TCO_TMR_HLT)
            {
                if(this.can_start())
                {
                    this.reload();
                }
                else if(this.expire_time !== -1)
                {
                    // halted: TCO_RLD keeps the ticks that were left
                    this.rld = Math.max(0, Math.floor((this.expire_time - this.cpu.clock.now()) / TICK_MS));
                    this.expire_time = -1;
                }
            }
            break;
        }
        case TCO2_CNT: case TCO2_CNT + 1:
            this.cnt2 = merge(this.cnt2);
            break;
        case TCO_MESSAGE1: this.message1 = byte; break;
        case TCO_MESSAGE2: this.message2 = byte; break;
        case TCO_WDCNT: this.wdcnt = byte; break;
        case SW_IRQ_GEN: this.sw_irq_gen = byte & 3; break;
        case TCO_TMR: case TCO_TMR + 1:
            this.tmr = merge(this.tmr) & 0x3FF;
            break;
    }
};

TCO.prototype.get_state = function()
{
    return [STATE_FORMAT, this.rld, this.dat_in, this.dat_out, this.sts1, this.sts2, this.cnt1, this.cnt2,
        this.message1, this.message2, this.wdcnt, this.sw_irq_gen, this.tmr, this.expire_time, this.timeouts];
};

TCO.prototype.set_state = function(state)
{
    [, this.rld, this.dat_in, this.dat_out, this.sts1, this.sts2, this.cnt1, this.cnt2,
        this.message1, this.message2, this.wdcnt, this.sw_irq_gen, this.tmr, this.expire_time, this.timeouts] = state;
};
