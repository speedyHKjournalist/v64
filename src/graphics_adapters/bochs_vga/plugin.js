// graphics_adapter: "bochs_vga" -- the Bochs/QEMU standard VGA (1234:1111):
// VGA plus the Bochs VBE interface and a linear frame buffer in BAR0.
// Built into build/v86-bochs-vga.js; from the source tree, src/graphics_adapter.js
// imports this file directly.

import { VGAScreen } from "../vga_core.js";
import { GraphicsMachine, register_graphics_adapter } from "../machine.js";

/** Without vram_size: the size v86 always had */
const DEFAULT_VRAM_SIZE = 8 * 1024 * 1024;

register_graphics_adapter({
    "name": "bochs_vga",
    // The VGA BIOS's PCI ROM header must name the device (SeaBIOS checks it)
    "pci_vendor": 0x1234,
    "pci_device": 0x1111,
    "create": (handle, options) =>
    {
        const vga = new VGAScreen(new GraphicsMachine(handle), options["vram_size"] || DEFAULT_VRAM_SIZE);
        return {
            "vga": vga,
            "get_state": () => vga.get_state(),
            "set_state": state => vga.set_state(state),
        };
    },
});
