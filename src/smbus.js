// The SMBus host controller of the Q35 machine's ICH9 (00:1f.3,
// settings.smbus) and the devices on its bus: eight 256-byte SPD EEPROMs at
// 0x50-0x57, zeroed, as QEMU's Q35 has them.
//
// The host interface (ICH9 datasheet 316972, 19.2; QEMU hw/i2c/pm_smbus.c):
// quick, byte, byte data, word data and block commands, process calls, the
// 32-byte block buffer (AUX_CTL.E32B), byte-by-byte block transfers with
// BYTE_DONE_STS, I2C block reads; INTA when a command ends with INTREN set.
// Transfers complete at once. The I/O BAR (BAR4) is decoded by the device
// while HOSTC.HST_EN is set: SeaBIOS puts it at the PM base + 0x100, among
// the legacy ports.

import { LOG_ACPI } from "./const.js";
import { h } from "./lib.js";
import { dbg_log } from "./log.js";
import { QEMU_PCI_SUBSYSTEM } from "./platform.js";

// For Types Only
import { CPU } from "./cpu.js";

export const ICH9_SMBUS_PCI_ID = 0x1F << 3 | 3;
const IO_SIZE = 32;
const HOSTC = 0x40;
const HOSTC_HST_EN = 1 << 0;
const HOSTC_I2C_EN = 1 << 2;
const HOSTC_WRITABLE = 0x1F;

// Host registers
const HST_STS = 0x00;
const HST_CNT = 0x02;
const HST_CMD = 0x03;
const XMIT_SLVA = 0x04;
const HST_D0 = 0x05;
const HST_D1 = 0x06;
const HOST_BLOCK_DB = 0x07;
const PEC = 0x08;
const AUX_STS = 0x0C;
const AUX_CTL = 0x0D;
const SMBUS_PIN_CTL = 0x0F;

const STS_HOST_BUSY = 1 << 0;
const STS_INTR = 1 << 1;
const STS_DEV_ERR = 1 << 2;
const STS_BUS_ERR = 1 << 3;
const STS_FAILED = 1 << 4;
const STS_SMBALERT = 1 << 5;
const STS_INUSE = 1 << 6;
const STS_BYTE_DONE = 1 << 7;
/** The statuses that end a command (and interrupt with INTREN), and BYTE_DONE */
const STS_INTERRUPTS = STS_INTR | STS_DEV_ERR | STS_BUS_ERR | STS_FAILED | STS_BYTE_DONE;

const CNT_INTREN = 1 << 0;
const CNT_KILL = 1 << 1;
const CNT_LAST_BYTE = 1 << 5;
const CNT_START = 1 << 6;

const PROT_QUICK = 0;
const PROT_BYTE = 1;
const PROT_BYTE_DATA = 2;
const PROT_WORD_DATA = 3;
const PROT_PROCESS_CALL = 4;
const PROT_BLOCK = 5;
const PROT_I2C_READ = 6;
const PROT_BLOCK_PROCESS = 7;

const AUX_E32B = 1 << 1;
const BLOCK_MAX = 32;

const STATE_FORMAT = 1;

/**
 * A 256-byte EEPROM (as an SPD EEPROM, or QEMU's smbus_eeprom): a current
 * offset that receive byte reads advance; send byte sets it; byte and word
 * reads and writes at the command's offset
 * @constructor
 * @param {number} address
 */
function SMBusEEPROM(address)
{
    this.address = address;
    this.data = new Uint8Array(256);
    this.offset = 0;
}

SMBusEEPROM.prototype.receive_byte = function()
{
    const value = this.data[this.offset];
    this.offset = this.offset + 1 & 0xFF;
    return value;
};

/** @param {number} value */
SMBusEEPROM.prototype.send_byte = function(value)
{
    this.offset = value & 0xFF;
};

/**
 * @param {number} offset
 * @param {number} value
 */
SMBusEEPROM.prototype.write_byte = function(offset, value)
{
    this.data[offset & 0xFF] = value;
    this.offset = offset + 1 & 0xFF;
};

/**
 * @constructor
 * @param {CPU} cpu
 */
export function SMBus(cpu)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    this.name = "smbus";
    this.pci_id = ICH9_SMBUS_PCI_ID;

    const qemu = cpu.platform.qemu_compatible;
    const space = new Array(256).fill(0);
    // 00:1f.3 SMBus: Intel Corporation 82801I (ICH9 Family) SMBus Controller (rev 02)
    space.splice(0, 16, 0x86, 0x80, 0x30, 0x29, 0x00, 0x00, 0x80, 0x02, 0x02, 0x00, 0x05, 0x0C, 0x00, 0x00, 0x00, 0x00);
    space.splice(0x20, 4, 0x01, 0x00, 0x00, 0x00);  // SMB_BASE: I/O, not placed yet
    space.splice(0x2C, 4, ...qemu ? QEMU_PCI_SUBSYSTEM : [0x86, 0x80, 0x30, 0x29]);
    space[0x3D] = 1; // INTA (as QEMU's)
    this.pci_space = space;
    this.pci_bars = [undefined, undefined, undefined, undefined,
        { size: IO_SIZE, on_move: port => this.update_decode() }];
    this.on_command_change = () => this.update_decode();
    this.on_config_restore = () => this.update_decode();
    this.on_config_write = (offset, size) => {
        if(offset <= HOSTC && offset + size > HOSTC)
        {
            const bytes = this.cpu.devices.pci.space_bytes(this.pci_id);
            bytes[HOSTC] &= HOSTC_WRITABLE;
            this.update_decode();
        }
    };

    /** @type {!Array<SMBusEEPROM>} */
    this.devices = [];
    for(let address = 0x50; address < 0x58; address++)
    {
        this.devices.push(new SMBusEEPROM(address));
    }

    /** Where the registers are decoded, or -1 */
    this.io_base = -1;
    this.irq_level = false;
    this.block = new Uint8Array(BLOCK_MAX);
    this.reset();

    /** @const @type {!Int32Array} */
    this.pci_config = cpu.devices.pci.register_device(this);
    this.update_decode();
}

SMBus.prototype.reset = function()
{
    this.status = 0;
    this.control = 0;
    this.command = 0;
    this.address = 0;
    this.data0 = 0;
    this.data1 = 0;
    this.pec = 0;
    this.aux_status = 0;
    this.aux_control = 0;
    this.block.fill(0);
    /** The block buffer's index (E32B), or the byte of a byte-by-byte transfer */
    this.index = 0;
    /** HOST_BLOCK_DB of a byte-by-byte transfer */
    this.block_byte = 0;
    /** A byte-by-byte transfer under way: "read", "write", "i2c", or none: "" */
    this.transfer = "";
    this.update_irq();
};

/** Decode the registers at SMB_BASE while I/O space and HST_EN are on (and I2C_EN off) */
SMBus.prototype.update_decode = function()
{
    const pci = this.cpu.devices.pci;
    const hostc = pci.function_read(this.pci_id, HOSTC, 1);
    const bar = this.pci_bars[4];
    const base = pci.is_io_enabled(this.pci_id) && hostc & HOSTC_HST_EN && !(hostc & HOSTC_I2C_EN) &&
        bar.base && bar.base + IO_SIZE <= 0x10000 ? bar.base : -1;
    if(base === this.io_base)
    {
        return;
    }
    const io = this.cpu.io;
    if(this.io_base !== -1)
    {
        io.unregister_range(this.io_base, IO_SIZE, this);
    }
    dbg_log("SMBus " + (base === -1 ? "not decoded" : "at " + h(base, 4)), LOG_ACPI);
    this.io_base = base;
    if(base !== -1)
    {
        for(let offset = 0; offset < IO_SIZE; offset++)
        {
            const bytes = size => {
                let value = 0;
                for(let i = 0; i < size; i++) value |= this.read(offset + i) << (i << 3);
                return value;
            };
            io.register_read(base + offset, this, () => bytes(1), () => bytes(2), () => bytes(4));
            io.register_write(base + offset, this,
                value => this.write(offset, value & 0xFF),
                value => { this.write(offset, value & 0xFF); this.write(offset + 1, value >> 8 & 0xFF); },
                value => { for(let i = 0; i < 4; i++) this.write(offset + i, value >>> (i << 3) & 0xFF); });
        }
    }
};

/**
 * @param {number} offset
 * @return {number}
 */
SMBus.prototype.read = function(offset)
{
    switch(offset)
    {
        case HST_STS:
        {
            // INUSE_STS: a semaphore, set by the read that finds it clear
            const value = this.status;
            this.status |= STS_INUSE;
            return value;
        }
        case HST_CNT:
            // (reading it resets the block buffer's index)
            this.index = 0;
            return this.control;
        case HST_CMD: return this.command;
        case XMIT_SLVA: return this.address;
        case HST_D0: return this.data0;
        case HST_D1: return this.data1;
        case HOST_BLOCK_DB:
            if(this.aux_control & AUX_E32B && !this.transfer)
            {
                const value = this.block[this.index];
                this.index = this.index + 1 & BLOCK_MAX - 1;
                return value;
            }
            return this.block_byte;
        case PEC: return this.pec;
        case AUX_STS: return this.aux_status;
        case AUX_CTL: return this.aux_control;
        case SMBUS_PIN_CTL: return 0x07; // SMBCLK, SMBDATA high; SMBCLK_CTL
    }
    return 0;
};

/**
 * @param {number} offset
 * @param {number} value
 */
SMBus.prototype.write = function(offset, value)
{
    dbg_log("SMBus write " + h(offset, 2) + " <- " + h(value, 2), LOG_ACPI);
    switch(offset)
    {
        case HST_STS:
        {
            const byte_done = this.status & value & STS_BYTE_DONE;
            // write one to clear (HOST_BUSY is read-only)
            this.status &= ~(value & ~STS_HOST_BUSY);
            if(byte_done)
            {
                this.next_byte();
            }
            this.update_irq();
            break;
        }
        case HST_CNT:
            this.control = value & ~CNT_START;
            if(value & CNT_KILL)
            {
                // the command in progress ends, failed
                if(this.status & STS_HOST_BUSY || this.transfer)
                {
                    this.transfer = "";
                    this.status = this.status & ~(STS_HOST_BUSY | STS_BYTE_DONE) | STS_FAILED;
                }
                this.index = 0;
            }
            else if(value & CNT_START)
            {
                this.start();
            }
            this.update_irq();
            break;
        case HST_CMD: this.command = value; break;
        case XMIT_SLVA: this.address = value; break;
        case HST_D0: this.data0 = value; break;
        case HST_D1: this.data1 = value; break;
        case HOST_BLOCK_DB:
            if(this.aux_control & AUX_E32B && !this.transfer)
            {
                this.block[this.index] = value;
                this.index = this.index + 1 & BLOCK_MAX - 1;
            }
            else
            {
                this.block_byte = value;
            }
            break;
        case PEC: this.pec = value; break;
        case AUX_STS: this.aux_status &= ~value; break;
        case AUX_CTL: this.aux_control = value & 0x03; break;
    }
};

/**
 * The device at a 7-bit address
 * @param {number} address
 * @return {SMBusEEPROM|undefined}
 */
SMBus.prototype.device = function(address)
{
    return this.devices.find(device => device.address === address);
};

/** START: run the command in HST_CNT */
SMBus.prototype.start = function()
{
    const protocol = this.control >> 2 & 7;
    const read = (this.address & 1) !== 0;
    const device = this.device(this.address >> 1);
    dbg_log("SMBus command " + protocol + (read ? " read" : " write") + " at " + h(this.address >> 1, 2), LOG_ACPI);

    if(this.status & (STS_DEV_ERR | STS_BUS_ERR | STS_FAILED) || this.transfer)
    {
        // (a previous error not cleared: the command does not run)
        this.status |= STS_DEV_ERR;
        return;
    }
    if(!device)
    {
        // no acknowledge
        this.status |= STS_DEV_ERR;
        return;
    }

    switch(protocol)
    {
        case PROT_QUICK:
            break;
        case PROT_BYTE:
            if(read) this.data0 = device.receive_byte();
            else device.send_byte(this.command);
            break;
        case PROT_BYTE_DATA:
            if(read)
            {
                device.send_byte(this.command);
                this.data0 = device.receive_byte();
            }
            else
            {
                device.write_byte(this.command, this.data0);
            }
            break;
        case PROT_WORD_DATA:
            if(read)
            {
                device.send_byte(this.command);
                this.data0 = device.receive_byte();
                this.data1 = device.receive_byte();
            }
            else
            {
                device.write_byte(this.command, this.data0);
                device.write_byte(this.command + 1, this.data1);
            }
            break;
        case PROT_PROCESS_CALL:
        {
            // write a word, read one back
            device.write_byte(this.command, this.data0);
            device.write_byte(this.command + 1, this.data1);
            device.send_byte(this.command);
            this.data0 = device.receive_byte();
            this.data1 = device.receive_byte();
            break;
        }
        case PROT_BLOCK:
        case PROT_BLOCK_PROCESS:
            if(read && protocol === PROT_BLOCK)
            {
                // the device sends the byte count first
                device.send_byte(this.command);
                const count = Math.min(device.receive_byte(), BLOCK_MAX);
                const data = new Uint8Array(BLOCK_MAX);
                for(let i = 0; i < count; i++) data[i] = device.receive_byte();
                this.data0 = count;
                this.block.set(data);
                this.index = 0;
                if(!(this.aux_control & AUX_E32B))
                {
                    // (also with a count of 0: software reads it with the first byte)
                    this.transfer = "read";
                    this.block_byte = this.block[0];
                    this.status |= STS_HOST_BUSY | STS_BYTE_DONE;
                    return;
                }
            }
            else
            {
                if(!(this.aux_control & AUX_E32B))
                {
                    // the bytes come one by one through HOST_BLOCK_DB
                    this.transfer = "write";
                    this.block[0] = this.block_byte;
                    this.index = 0;
                    this.status |= STS_HOST_BUSY | STS_BYTE_DONE;
                    return;
                }
                this.write_block(device);
                if(protocol === PROT_BLOCK_PROCESS)
                {
                    device.send_byte(this.command);
                    const count = Math.min(device.receive_byte(), BLOCK_MAX);
                    for(let i = 0; i < count; i++) this.block[i] = device.receive_byte();
                    this.data0 = count;
                }
                this.index = 0;
            }
            break;
        case PROT_I2C_READ:
            // I2C: the offset (HST_D1) sent, then bytes read one by one
            // until LAST_BYTE (QEMU ignores the R/W bit here, as Linux sets
            // it either way)
            device.send_byte(this.data1);
            this.transfer = "i2c";
            this.block_byte = device.receive_byte();
            this.status |= STS_HOST_BUSY | STS_BYTE_DONE;
            return;
    }
    this.status |= STS_INTR;
};

/**
 * A block write from the block buffer: the command, the byte count (HST_D0),
 * the bytes; an EEPROM stores the count and the bytes from the command's
 * offset on (as QEMU's), so that a block read returns them
 * @param {SMBusEEPROM} device
 */
SMBus.prototype.write_block = function(device)
{
    const count = Math.min(this.data0, BLOCK_MAX);
    device.write_byte(this.command, count);
    for(let i = 0; i < count; i++)
    {
        device.write_byte(this.command + 1 + i, this.block[i]);
    }
};

/** Byte-by-byte transfers: software cleared BYTE_DONE_STS, the next byte */
SMBus.prototype.next_byte = function()
{
    const device = this.device(this.address >> 1);
    if(!this.transfer || !device)
    {
        return;
    }
    this.index++;
    if(this.transfer === "write")
    {
        if(this.index >= Math.min(this.data0, BLOCK_MAX))
        {
            this.write_block(device);
            this.end_transfer();
            return;
        }
        this.block[this.index] = this.block_byte;
        this.status |= STS_BYTE_DONE;
        return;
    }
    // a read: the next byte, or with LAST_BYTE the end (software set it
    // before taking the last byte; as QEMU's, one more byte is fetched)
    this.block_byte = this.transfer === "i2c" ? device.receive_byte() : this.block[this.index & BLOCK_MAX - 1];
    if(this.control & CNT_LAST_BYTE)
    {
        this.end_transfer();
    }
    else
    {
        this.status |= STS_BYTE_DONE;
    }
};

SMBus.prototype.end_transfer = function()
{
    this.transfer = "";
    this.index = 0;
    this.status = this.status & ~STS_HOST_BUSY | STS_INTR;
};

/** INTA: a command ended (or a byte is done) with INTREN */
SMBus.prototype.update_irq = function()
{
    const level = (this.control & CNT_INTREN) !== 0 && (this.status & STS_INTERRUPTS) !== 0;
    if(level !== this.irq_level)
    {
        this.irq_level = level;
        level ? this.cpu.devices.pci.raise_irq(this.pci_id) : this.cpu.devices.pci.lower_irq(this.pci_id);
    }
};

SMBus.prototype.get_state = function()
{
    const state = [];
    state[0] = STATE_FORMAT;
    state[1] = [this.status, this.control, this.command, this.address, this.data0, this.data1,
        this.pec, this.aux_status, this.aux_control, this.index, this.block_byte, this.irq_level ? 1 : 0];
    state[2] = this.transfer;
    state[3] = this.block;
    state[4] = this.devices.map(device => [device.data, device.offset]);
    return state;
};

SMBus.prototype.set_state = function(state)
{
    [this.status, this.control, this.command, this.address, this.data0, this.data1,
        this.pec, this.aux_status, this.aux_control, this.index, this.block_byte] = state[1];
    this.irq_level = !!state[1][11];
    this.transfer = state[2];
    this.block.set(state[3]);
    state[4].forEach(([data, offset], i) => {
        this.devices[i].data.set(data);
        this.devices[i].offset = offset;
    });
};
