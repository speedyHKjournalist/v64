// The PCI Express root ports of the Q35 machine's ICH9 (00:1c.0-5): PCI-to-
// PCI bridges (type 1 header, src/pci.js) with the PCI Express capability of
// a root port. Each one's secondary bus holds what the machine puts behind it
// (device 0 only, as behind any PCI Express downstream port), in a slot with
// PCI Express native hot plug, as QEMU's pcie-root-port has it: attention
// button, power controller, power and attention indicators, presence detect
// and data link layer state changed events, command completed, signalled by
// MSI or INTx. The guest takes the slots over through _OSC (acpi_tables.js).
// After reset, a slot with a card is on, an empty one off (as QEMU's).
//
// The card in a slot is the device the options put behind the port. The host
// plugs it in and pulls it out (V86.attach_pcie_device, detach_pcie_device;
// pcie_plugged: false starts with the slot empty), either at once (a
// surprise removal) or by pressing the attention button: the guest then
// releases the device and switches the slot and its power indicator off. A
// card out of the slot or without power is off the bus (src/pci.js
// set_function_present); plugged in or switched on again it starts afresh.
// The link is up (x1, 2.5 GT/s) while a card is in and powered. No PME or
// error events.
// ICH9 datasheet (316972), chapter 18; PCI Express Base 2.0, 6.7 and 7.8.

import { LOG_PCI } from "./const.js";
import { dbg_log } from "./log.js";
import { msi_capability } from "./pci.js";
import { QEMU_PCI_SUBSYSTEM, Q35_ROOT_PORT_SLOT } from "./platform.js";

// For Types Only
import { CPU } from "./cpu.js";

/** 82801I (ICH9) PCI Express Port 1; port n is 0x2940 + 2 * (n - 1) */
const ICH9_ROOT_PORT_DEVICE_ID = 0x2940;

const PCIE_CAP = 0x40;
const MSI_CAP = 0x80;
const SSVID_CAP = 0x90;
const PM_CAP = 0xA0;

const PCI_CAP_PCIE = 0x10;
const PCI_CAP_SSVID = 0x0D;
const PCI_CAP_PM = 0x01;

// PCI Express capability (version 1: PCI Express Base 1.1, 7.8)
const PCIE_FLAGS = 1 | 4 << 4 | 1 << 8;    // version 1, root port, slot implemented
const PCIE_DEVCAP = 1 << 15;                // role-based error reporting; 128-byte payload
const PCIE_LINK_SPEED_2_5 = 1;
const PCIE_LINK_WIDTH_X1 = 1 << 4;
const PCIE_LNKCAP_DLLLARC = 1 << 20;        // data link layer link active reporting
const PCIE_LNKSTA_SLOT_CLOCK = 1 << 12;
const PCIE_LNKSTA_DLLLA = 1 << 13;          // data link layer link active

const LNKSTA = PCIE_CAP + 0x12;
const SLTCAP = PCIE_CAP + 0x14;
const SLTCTL = PCIE_CAP + 0x18;
const SLTSTA = PCIE_CAP + 0x1A;

// Slot capabilities
const SLTCAP_ABP = 1 << 0;                  // attention button present
const SLTCAP_PCP = 1 << 1;                  // power controller present
const SLTCAP_AIP = 1 << 3;                  // attention indicator present
const SLTCAP_PIP = 1 << 4;                  // power indicator present
const SLTCAP_HPS = 1 << 5;                  // hot plug surprise
const SLTCAP_HPC = 1 << 6;                  // hot plug capable
const SLTCAP_PSN_SHIFT = 19;                // physical slot number

// Slot control: the enables of the events, in the bits of their status
// (but DLLSCE), the indicators, the power controller
const SLTCTL_EVENT_ENABLES = 0x1F;          // ABPE, PFDE, MRLSCE, PDCE, CCIE
const SLTCTL_HPIE = 1 << 5;                 // hot plug interrupt enable
const SLTCTL_AIC_OFF = 3 << 6;              // attention indicator off
const SLTCTL_PIC_ON = 1 << 8;               // power indicator on
const SLTCTL_PIC_OFF = 3 << 8;              // power indicator off
const SLTCTL_PIC = 3 << 8;                  // (the power indicator's field)
const SLTCTL_PCC = 1 << 10;                 // power controller control: set, the slot is off
const SLTCTL_DLLSCE = 1 << 12;              // data link layer state changed enable
/** What a guest may write (no electromechanical interlock: EIC reads as 0) */
const SLTCTL_WRITABLE = 0x17FF;
/** After reset, as QEMU's: a slot with a card powered, its power indicator on */
const SLTCTL_RESET_OCCUPIED = SLTCTL_AIC_OFF | SLTCTL_PIC_ON;
/** and an empty slot switched off, both indicators off */
const SLTCTL_RESET_EMPTY = SLTCTL_AIC_OFF | SLTCTL_PIC_OFF | SLTCTL_PCC;

// Slot status
const SLTSTA_ABP = 1 << 0;                  // attention button pressed
const SLTSTA_PDC = 1 << 3;                  // presence detect changed
const SLTSTA_CC = 1 << 4;                   // command completed
const SLTSTA_PDS = 1 << 6;                  // presence detect state
const SLTSTA_DLLSC = 1 << 8;                // data link layer state changed
/** The events: write one to clear (ABP, PFD, MRLSC, PDC, CC, DLLSC) */
const SLTSTA_EVENTS = 0x1F | SLTSTA_DLLSC;

/**
 * The bits of the capabilities (0x40-0xFF) a guest may write; MSI is
 * pci.msi_config_written's, the slot's control and status the port's own
 * (config_written). The other status registers (device, link, root; their
 * write-one-to-clear bits never get set) and everything else are read-only.
 */
const WRITABLE = new Uint8Array(256);
WRITABLE.set([0xFF, 0x7F], PCIE_CAP + 0x08);    // device control
WRITABLE.set([0xFB, 0x01], PCIE_CAP + 0x10);    // link control (retrain link reads as 0)
WRITABLE.set([0x1F, 0x00], PCIE_CAP + 0x1C);    // root control
WRITABLE.fill(0xFF, MSI_CAP, MSI_CAP + 14);
WRITABLE.set([0x03, 0x01], PM_CAP + 0x04);      // power state, PME enable

const STATE_FORMAT = 1;

/**
 * @constructor
 * @param {CPU} cpu
 * @param {number} number the port, 0-5 (function number on device 28)
 * @param {number} count the root ports the machine has (function 0 then is
 *     a multi-function device)
 */
export function PCIeRootPort(cpu, number, count)
{
    /** @const @type {CPU} */
    this.cpu = cpu;
    this.number = number;
    this.name = "pcie_root_port" + number;
    this.pci_id = Q35_ROOT_PORT_SLOT << 3 | number;
    /** The bus behind it, as pci_ids number it: device 0 there is pci_id secondary_bus << 8 */
    this.pci_secondary_bus = number + 1;
    /** A PCI Express downstream port: its secondary bus has only device 0 */
    this.pci_express_downstream = true;
    /** PCI Express: 4 KiB of configuration space (no extended capabilities) */
    this.pci_config_size = 4096;
    /** The card's function: device 0 on the secondary bus */
    this.card_pci_id = this.pci_secondary_bus << 8;

    const device_id = ICH9_ROOT_PORT_DEVICE_ID + 2 * number;
    const space = new Array(256).fill(0);
    // 00:1c.n PCI bridge: Intel Corporation 82801I (ICH9 Family) PCI Express Port n+1 (rev 02)
    space.splice(0, 16,
        0x86, 0x80, device_id & 0xFF, device_id >> 8,
        0x00, 0x00, 0x10, 0x00,             // command; status: capabilities list
        0x02, 0x00, 0x04, 0x06,             // revision; PCI-to-PCI bridge
        0x00, 0x00, number === 0 && count > 1 ? 0x81 : 0x01, 0x00);
    space[0x24] = space[0x26] = 0x01;       // prefetchable window: 64-bit
    space[0x34] = PCIE_CAP;
    // INTA-D for ports 1-4, then INTA, INTB (D28IP's default)
    space[0x3D] = (number & 3) + 1;

    const put = (offset, bytes, value) => {
        for(let i = 0; i < bytes; i++) space[offset + i] = value >>> (i << 3) & 0xFF;
    };
    space[PCIE_CAP] = PCI_CAP_PCIE;
    space[PCIE_CAP + 1] = MSI_CAP;
    put(PCIE_CAP + 0x02, 2, PCIE_FLAGS);
    put(PCIE_CAP + 0x04, 4, PCIE_DEVCAP);
    put(PCIE_CAP + 0x0C, 4, PCIE_LINK_SPEED_2_5 | PCIE_LINK_WIDTH_X1 | PCIE_LNKCAP_DLLLARC | number + 1 << 24);
    put(LNKSTA, 2, PCIE_LINK_SPEED_2_5 | PCIE_LINK_WIDTH_X1 | PCIE_LNKSTA_SLOT_CLOCK);
    put(SLTCAP, 4, SLTCAP_ABP | SLTCAP_PCP | SLTCAP_AIP | SLTCAP_PIP | SLTCAP_HPS | SLTCAP_HPC |
        number + 1 << SLTCAP_PSN_SHIFT);
    put(SLTCTL, 2, SLTCTL_RESET_OCCUPIED);
    space.splice(MSI_CAP, 14, ...msi_capability(SSVID_CAP));
    space.splice(SSVID_CAP, 8, PCI_CAP_SSVID, PM_CAP, 0, 0,
        ...cpu.platform.qemu_compatible ? QEMU_PCI_SUBSYSTEM : [0x86, 0x80, device_id & 0xFF, device_id >> 8]);
    // PM: version 2, PME from D0, D3hot and D3cold
    space.splice(PM_CAP, 8, PCI_CAP_PM, 0x00, 0x02, 0xC8, 0x00, 0x00, 0x00, 0x00);

    this.pci_space = space;
    /** The read-only values of the capabilities */
    this.template = Uint8Array.from(space);
    this.pci_bars = [];
    this.on_config_write = (offset, size) => this.config_written(offset, size);
    this.on_config_restore = () => this.load_slot();

    /** Slot control and the events of slot status (PDS: card) */
    this.slot_control = SLTCTL_RESET_OCCUPIED;
    this.slot_status = 0;
    /** A card is in the slot */
    this.card = false;
    /** The attention button was pressed to take the card out: the guest switches the slot off for it */
    this.removal_requested = false;
    /** @type {!Array<{resolve: function(), reject: function(Error)}>} the callers waiting for that */
    this.removal_waiters = [];
    /** Whether the hot plug interrupt is signalled (MSI: sent once, until it drops) */
    this.notified = false;

    /** @const @type {!Int32Array} */
    this.pci_config = cpu.devices.pci.register_device(this);
}

/**
 * The machine's devices exist: is there a card for the slot, and is it
 * plugged in (the options' pcie_plugged)? An empty slot starts switched off.
 * @param {boolean} plugged
 */
PCIeRootPort.prototype.setup = function(plugged)
{
    this.card = this.has_card() && plugged;
    if(this.has_card() && !this.card)
    {
        this.cpu.devices.pci.set_function_present(this.card_pci_id, false);
    }
    this.slot_control = this.card ? SLTCTL_RESET_OCCUPIED : SLTCTL_RESET_EMPTY;
    dbg_log(this.name + ": " + (this.card ? "card present, link up" : this.has_card() ? "card not plugged in" : "empty"), LOG_PCI);
    this.store_slot();
};

/** @return {boolean} whether the options put a device behind the port */
PCIeRootPort.prototype.has_card = function()
{
    return this.cpu.devices.pci.devices[this.card_pci_id] !== undefined;
};

/** @return {boolean} the power controller has the slot on */
PCIeRootPort.prototype.powered = function()
{
    return !(this.slot_control & SLTCTL_PCC);
};

/**
 * @return {boolean} the slot is off and its power indicator too: the card may
 *     be taken out (a blinking indicator: the guest is not done yet)
 */
PCIeRootPort.prototype.safe_to_remove = function()
{
    return !this.powered() && (this.slot_control & SLTCTL_PIC) === SLTCTL_PIC_OFF;
};

/** The slot's registers, as the fields have them */
PCIeRootPort.prototype.store_slot = function()
{
    const bytes = this.cpu.devices.pci.space_bytes(this.pci_id);
    const put = (offset, value) => {
        bytes[offset] = value & 0xFF;
        bytes[offset + 1] = value >> 8 & 0xFF;
    };
    const link_up = this.card && this.powered();
    put(LNKSTA, PCIE_LINK_SPEED_2_5 | PCIE_LINK_WIDTH_X1 | PCIE_LNKSTA_SLOT_CLOCK | (link_up ? PCIE_LNKSTA_DLLLA : 0));
    put(SLTCTL, this.slot_control);
    put(SLTSTA, this.slot_status & SLTSTA_EVENTS | (this.card ? SLTSTA_PDS : 0));
};

/** The fields, as the restored registers have them (a snapshot) */
PCIeRootPort.prototype.load_slot = function()
{
    const bytes = this.cpu.devices.pci.space_bytes(this.pci_id);
    this.slot_control = (bytes[SLTCTL] | bytes[SLTCTL + 1] << 8) & SLTCTL_WRITABLE;
    this.slot_status = (bytes[SLTSTA] | bytes[SLTSTA + 1] << 8) & SLTSTA_EVENTS;
};

/**
 * Hot plug events: their status bits, and the interrupt if they are enabled
 * (an event already pending signals nothing new)
 * @param {number} events
 */
PCIeRootPort.prototype.event = function(events)
{
    const added = events & ~this.slot_status;
    this.slot_status |= events;
    this.store_slot();
    if(added)
    {
        this.update_interrupt();
    }
};

/**
 * The hot plug interrupt (PCI Express Base 2.0, 6.7.3.4): asserted while hot
 * plug interrupts are enabled and an enabled event is pending; with MSI, a
 * message when that starts
 */
PCIeRootPort.prototype.update_interrupt = function()
{
    const pci = this.cpu.devices.pci;
    const enabled = this.slot_control & SLTCTL_EVENT_ENABLES | (this.slot_control & SLTCTL_DLLSCE ? SLTSTA_DLLSC : 0);
    const active = (this.slot_control & SLTCTL_HPIE) !== 0 && (this.slot_status & enabled) !== 0;
    if(pci.msi_enabled(this.pci_id, MSI_CAP))
    {
        pci.lower_irq(this.pci_id);
        if(active && !this.notified)
        {
            pci.msi_notify(this.pci_id, MSI_CAP);
        }
    }
    else
    {
        pci.set_irq_level(this.pci_id, active);
    }
    this.notified = active;
};

/**
 * Plug the card in (V86.attach_pcie_device): presence detect changed. A
 * powered slot brings the link up (data link layer state changed). An
 * unpowered one (empty slots start switched off, and guests switch them off)
 * waits for the guest to switch it on: as QEMU, the attention button is
 * pressed too, for guests
 * that, like Linux, enable the button's event and not presence detect's
 * when the slot has a button (Linux then finds presence detect changed as
 * well and switches the slot on at once).
 * @return {boolean} whether it was out
 */
PCIeRootPort.prototype.insert = function()
{
    if(!this.has_card())
    {
        throw new Error("attach_pcie_device: no device for root port " + this.number + " (pcie_root_port in its options)");
    }
    if(this.card)
    {
        return false;
    }
    dbg_log(this.name + ": card plugged in", LOG_PCI);
    this.card = true;
    if(this.powered())
    {
        this.cpu.devices.pci.set_function_present(this.card_pci_id, true, true);
        this.event(SLTSTA_PDC | SLTSTA_DLLSC);
    }
    else
    {
        this.event(SLTSTA_PDC | SLTSTA_ABP);
    }
    return true;
};

/**
 * Take the card out (V86.detach_pcie_device). A surprise removal pulls it at
 * once; otherwise the attention button asks the guest, which releases the
 * device and switches the slot and its power indicator off, and the card
 * leaves then (at once if the slot is off already).
 * @param {boolean} surprise
 * @return {!Promise<void>} settled once the card is out
 */
PCIeRootPort.prototype.remove = function(surprise)
{
    if(!this.card)
    {
        return Promise.resolve();
    }
    if(surprise || !this.powered())
    {
        dbg_log(this.name + ": card pulled out" + (surprise ? " (surprise)" : ""), LOG_PCI);
        const link_was_up = this.powered();
        this.card = false;
        this.cpu.devices.pci.set_function_present(this.card_pci_id, false);
        this.event(SLTSTA_PDC | (link_was_up ? SLTSTA_DLLSC : 0));
        this.removed();
        return Promise.resolve();
    }
    const done = new Promise((resolve, reject) => this.removal_waiters.push({ resolve, reject }));
    if(!this.removal_requested)
    {
        // (pressed once: a second press would cancel the request)
        dbg_log(this.name + ": attention button pressed", LOG_PCI);
        this.removal_requested = true;
        this.event(SLTSTA_ABP);
    }
    return done;
};

/** The card is out: those waiting for its removal hear of it */
PCIeRootPort.prototype.removed = function()
{
    this.removal_requested = false;
    const waiters = this.removal_waiters;
    this.removal_waiters = [];
    waiters.forEach(waiter => waiter.resolve());
};

/**
 * The guest wrote slot control: a command, completed at once (command
 * completed). Switching the slot off takes the card off the bus (the link
 * goes down), switching it on brings the card back afresh. A card whose
 * removal was requested leaves once the slot is off and its power indicator
 * too, as with QEMU: while the indicator blinks, the guest is not done
 * (Windows switches the power off first, the indicator a moment later)
 * @param {number} value
 */
PCIeRootPort.prototype.slot_control_written = function(value)
{
    const was_powered = this.powered();
    this.slot_control = value & SLTCTL_WRITABLE;
    let events = SLTSTA_CC;
    if(this.card && was_powered !== this.powered())
    {
        const pci = this.cpu.devices.pci;
        if(this.powered())
        {
            dbg_log(this.name + ": slot switched on, link up", LOG_PCI);
            pci.set_function_present(this.card_pci_id, true, true);
        }
        else
        {
            dbg_log(this.name + ": slot switched off", LOG_PCI);
            pci.set_function_present(this.card_pci_id, false);
        }
        events |= SLTSTA_DLLSC;
    }
    if(this.card && this.removal_requested && this.safe_to_remove())
    {
        dbg_log(this.name + ": slot and power indicator off, the card leaves", LOG_PCI);
        this.card = false;
        events |= SLTSTA_PDC;
        this.removed();
    }
    this.store_slot();
    this.event(events);
};

/**
 * A guest write to the capabilities: read-only bytes and bits keep their
 * values; slot control is a command, slot status has write-one-to-clear
 * events
 * @param {number} offset
 * @param {number} size
 */
PCIeRootPort.prototype.config_written = function(offset, size)
{
    const pci = this.cpu.devices.pci;
    const bytes = pci.space_bytes(this.pci_id);
    const written = at => at >= offset && at < offset + size;
    // (what the write put into the slot's registers)
    const control = written(SLTCTL) || written(SLTCTL + 1) ? bytes[SLTCTL] | bytes[SLTCTL + 1] << 8 : -1;
    const cleared = (written(SLTSTA) ? bytes[SLTSTA] : 0) | (written(SLTSTA + 1) ? bytes[SLTSTA + 1] << 8 : 0);
    for(let o = Math.max(offset, 0x40); o < offset + size; o++)
    {
        // (no extended capabilities: 0x100 and up read as zero)
        bytes[o] = o < 0x100 ? this.template[o] & ~WRITABLE[o] | bytes[o] & WRITABLE[o] : 0;
    }
    if(offset < MSI_CAP + 14 && offset + size > MSI_CAP)
    {
        pci.msi_config_written(this.pci_id, MSI_CAP, SSVID_CAP);
    }
    this.slot_status &= ~(cleared & SLTSTA_EVENTS);
    this.store_slot();
    if(control !== -1)
    {
        this.slot_control_written(control);
    }
    // (events cleared, enables changed, or MSI switched on or off)
    this.update_interrupt();
};

/**
 * PCIRST#: as QEMU, a slot with a card powered (the power indicator on), an
 * empty one switched off; no events; a requested removal is forgotten. The
 * card stays in.
 */
PCIeRootPort.prototype.reset = function()
{
    const was_powered = this.powered();
    this.slot_control = this.card ? SLTCTL_RESET_OCCUPIED : SLTCTL_RESET_EMPTY;
    this.slot_status = 0;
    this.notified = false;
    this.removal_requested = false;
    const waiters = this.removal_waiters;
    this.removal_waiters = [];
    waiters.forEach(waiter => waiter.reject(new Error("detach_pcie_device: the machine was reset before the guest released the device")));
    if(this.card && !was_powered)
    {
        this.cpu.devices.pci.set_function_present(this.card_pci_id, true, true);
    }
    this.store_slot();
    this.cpu.devices.pci.lower_irq(this.pci_id);
};

PCIeRootPort.prototype.get_state = function()
{
    return [STATE_FORMAT, this.card, this.removal_requested, this.notified];
};

PCIeRootPort.prototype.set_state = function(state)
{
    [, this.card, this.removal_requested, this.notified] = state;
    this.load_slot();
    // those waiting for a removal: done if the restored slot is empty, still
    // waiting if the restored guest has the request too
    if(!this.card)
    {
        this.removed();
    }
    else if(!this.removal_requested)
    {
        const waiters = this.removal_waiters;
        this.removal_waiters = [];
        waiters.forEach(waiter => waiter.reject(new Error("detach_pcie_device: a snapshot without the removal was restored")));
    }
};
