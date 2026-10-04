// The PCI Express root ports of the Q35 machine's ICH9 (00:1c.0-5): PCI-to-
// PCI bridges (type 1 header, src/pci.js) with the PCI Express capability of
// a root port. Each one's secondary bus holds what the machine puts behind it
// (device 0 only, as behind any PCI Express downstream port). Neither hot
// plug nor PME or error events: the slot reports its device present, the
// link is up (x1, 2.5 GT/s) when there is one.
// ICH9 datasheet (316972), chapter 18: PCI Express configuration registers.

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
const PCIE_SLTSTA_PDS = 1 << 6;             // presence detect state

/**
 * The bits of the capabilities (0x40-0xFF) a guest may write; MSI is
 * pci.msi_config_written's. The status registers (device, link, slot, root;
 * their write-one-to-clear bits never get set) and everything else are
 * read-only.
 */
const WRITABLE = new Uint8Array(256);
WRITABLE.set([0xFF, 0x7F], PCIE_CAP + 0x08);    // device control
WRITABLE.set([0xFB, 0x01], PCIE_CAP + 0x10);    // link control (retrain link reads as 0)
WRITABLE.set([0xFF, 0x1F], PCIE_CAP + 0x18);    // slot control
WRITABLE.set([0x1F, 0x00], PCIE_CAP + 0x1C);    // root control
WRITABLE.fill(0xFF, MSI_CAP, MSI_CAP + 14);
WRITABLE.set([0x03, 0x01], PM_CAP + 0x04);      // power state, PME enable

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
    put(PCIE_CAP + 0x12, 2, PCIE_LINK_SPEED_2_5 | PCIE_LINK_WIDTH_X1 | PCIE_LNKSTA_SLOT_CLOCK);
    put(PCIE_CAP + 0x14, 4, number + 1 << 19);     // physical slot number; no hot plug
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

    /** @const @type {!Int32Array} */
    this.pci_config = cpu.devices.pci.register_device(this);
}

/**
 * Something is behind it (or not): the slot's presence detect state and the
 * link's data link layer active bit
 * @param {boolean} present
 */
PCIeRootPort.prototype.set_present = function(present)
{
    dbg_log(this.name + ": " + (present ? "device present, link up" : "empty"), LOG_PCI);
    const bytes = this.cpu.devices.pci.space_bytes(this.pci_id);
    const set = (offset, bit) => {
        const value = (bytes[offset] | bytes[offset + 1] << 8) & ~bit | (present ? bit : 0);
        bytes[offset] = this.template[offset] = value & 0xFF;
        bytes[offset + 1] = this.template[offset + 1] = value >> 8;
    };
    set(PCIE_CAP + 0x12, PCIE_LNKSTA_DLLLA);
    set(PCIE_CAP + 0x1A, PCIE_SLTSTA_PDS);
};

/**
 * A guest write to the capabilities: read-only bytes and bits keep their
 * values
 * @param {number} offset
 * @param {number} size
 */
PCIeRootPort.prototype.config_written = function(offset, size)
{
    const pci = this.cpu.devices.pci;
    const bytes = pci.space_bytes(this.pci_id);
    for(let o = Math.max(offset, 0x40); o < offset + size; o++)
    {
        // (no extended capabilities: 0x100 and up read as zero)
        bytes[o] = o < 0x100 ? this.template[o] & ~WRITABLE[o] | bytes[o] & WRITABLE[o] : 0;
    }
    if(offset < MSI_CAP + 14 && offset + size > MSI_CAP)
    {
        pci.msi_config_written(this.pci_id, MSI_CAP, SSVID_CAP);
    }
};
