// graphics_adapter: "vmware_svga" -- VMware SVGA II (15AD:0405).
// Built into build/v86-vmware-svga.js; from the source tree,
// src/graphics_adapter.js imports this file directly.

import { GraphicsMachine, register_graphics_adapter } from "../machine.js";
import { SVGADevice } from "./svga_device.js";

register_graphics_adapter({
    "name": "vmware_svga",
    // The VGA BIOS's PCI ROM header must name the device (SeaBIOS checks it)
    "pci_vendor": 0x15AD,
    "pci_device": 0x0405,
    "create": (handle, options) =>
    {
        const test = options["test"] || {};
        const device = new SVGADevice(new GraphicsMachine(handle), {
            vram_size: options["vram_size"],
            // without it, the highest level there is a renderer for
            level: test["level"],
            // the channel to the 3D renderer (svga_renderer.js); tests bring their own
            renderer: options["renderer"] || test["renderer"],
        });
        return {
            "vga": device.vga,
            "svga": device,
            "get_state": () => device.get_state(),
            "set_state": state => device.set_state(state),
            "reset": () => device.reset(),
        };
    },
});
