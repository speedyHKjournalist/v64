// graphics_adapter: "virtio_gpu" -- virtio-gpu as virtio-vga (1AF4:1050).
// Built into build/v86-virtio-gpu.js; from the source tree,
// src/graphics_adapter.js imports this file directly.

import { GraphicsMachine, register_graphics_adapter } from "../machine.js";
import { VirtioGPU } from "./virtio_gpu_device.js";

register_graphics_adapter({
    "name": "virtio_gpu",
    // The VGA BIOS's PCI ROM header must name the device (SeaBIOS checks it)
    "pci_vendor": 0x1AF4,
    "pci_device": 0x1050,
    "create": (handle, options) =>
    {
        const test = options["test"] || {};
        const device = new VirtioGPU(new GraphicsMachine(handle), {
            vram_size: options["vram_size"],
            // without it, the highest level there is
            level: test["level"],
            // how many displays the guest gets (tests; 1 otherwise)
            scanouts: test["scanouts"],
        });
        return {
            "vga": device.vga,
            "virtio_gpu": device,
            "get_state": () => device.get_state(),
            "set_state": state => device.set_state(state),
            "reset": () => device.reset(),
        };
    },
});
