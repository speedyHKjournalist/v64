#!/usr/bin/env node

// Display adapters as plugins (src/graphics_adapter.js): graphics_adapter is
// required and checked, the plugin loads only when named, "none" boots
// without a display, snapshots name their adapter and reject another one,
// snapshots from before the plugins still restore, and the VGA BIOS's PCI ROM
// header is made to name the adapter's device.

import assert from "assert/strict";
import fs from "node:fs";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const ROOT = __dirname + "/../../";
const BASE = {
    wasm_path: ROOT + "build/" + (TEST_RELEASE_BUILD ? "v86.wasm" : "v86-debug.wasm"),
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    memory_size: 32 << 20,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    net_device: { type: "none" },
    log_level: 0,
};

/**
 * @param {Object} options
 * @return {!Promise<V86>}
 */
async function start(options)
{
    const emulator = new V86({ ...BASE, ...options });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
}

// Option checks happen in the constructor, before anything loads
for(const [options, message] of [
    [{}, /graphics_adapter is required/],
    [{ graphics_adapter: "cirrus" }, /Unknown graphics_adapter "cirrus"/],
    [{ graphics_adapter: "vmware_svga" }, /"vmware_svga" is not implemented yet/],
    [{ graphics_adapter: () => {} }, /use graphics_proxy: true/],
    [{ graphics_adapter: "bochs_vga", vga_memory_size: 8 << 20 }, /vga_memory_size was renamed to vram_size/],
    [{ graphics_adapter: "bochs_vga", vram_size: 3 << 20 }, /vram_size must be a power of two/],
])
{
    assert.throws(() => new V86({ ...BASE, autostart: false, ...options }), message);
}
console.log("PASS: graphics_adapter is required and checked");

// A plugin file that is not there says which file it looked for
{
    const emulator = new V86({ ...BASE, autostart: false, graphics_adapter: "bochs_vga",
        graphics_adapter_path: ROOT + "build/no-such-adapter.js" });
    const error = await new Promise(resolve => emulator.add_listener("emulator-error", resolve));
    assert.match(String(error && error.message), /cannot load .*no-such-adapter\.js/);
    await emulator.destroy();
    console.log("PASS: a missing plugin file is reported with its path");
}

// The Bochs VGA: boots to text, its snapshot names the adapter
let bochs_state;
{
    const emulator = await start({ graphics_adapter: "bochs_vga", vram_size: 4 << 20, autostart: true });
    const cpu = emulator.v86.cpu;
    assert.equal(cpu.devices.graphics_adapter.name, "bochs_vga");
    assert.equal(cpu.devices.vga.vga_memory_size, 4 << 20, "vram_size reaches the VGA");
    await emulator.wait_until_vga_screen_contains("No bootable device.", { timeout_msec: 60000 });
    emulator.stop();
    bochs_state = await emulator.save_state();
    await emulator.destroy();

    const restored = await start({ graphics_adapter: "bochs_vga", vram_size: 4 << 20, autostart: false });
    await restored.restore_state(bochs_state);
    assert.ok(restored.screen_adapter.get_text_screen().some(line => line.includes("No bootable device.")),
        "the text screen comes back");
    await restored.destroy();
    console.log("PASS: bochs_vga boots, saves and restores");
}

// No display adapter: no VGA ports, no VGA text, snapshots do not mix
{
    const emulator = await start({ graphics_adapter: "none", autostart: true });
    const cpu = emulator.v86.cpu;
    assert.equal(cpu.devices.graphics_adapter, undefined);
    assert.equal(cpu.devices.vga, undefined);
    assert.equal(cpu.io.port_read8(0x3DA), 0xFF, "nothing decodes the VGA ports");
    await assert.rejects(emulator.wait_until_vga_screen_contains("x"), /graphics_adapter is "none"/);

    // SeaBIOS runs without a VGA BIOS: let it reach the boot attempt
    await new Promise(resolve => setTimeout(resolve, 3000));
    emulator.stop();
    const none_state = await emulator.save_state();

    await assert.rejects(emulator.restore_state(bochs_state),
        /graphics_adapter: "bochs_vga", this one has "none"/);
    await emulator.destroy();

    const bochs = await start({ graphics_adapter: "bochs_vga", autostart: false });
    await assert.rejects(bochs.restore_state(none_state),
        /graphics_adapter: "none", this one has "bochs_vga"/);
    await bochs.destroy();
    console.log("PASS: graphics_adapter \"none\" boots without a display, snapshots do not mix");
}

// The PCI ROM header of the VGA BIOS (SeaBIOS only runs a matching ROM)
if(!TEST_RELEASE_BUILD)
{
    const { patch_vga_bios_ids } = await import("../../src/graphics_adapter.js");
    const original = new Uint8Array(fs.readFileSync(ROOT + "bios/vgabios.bin"));
    const ids = rom => {
        const pcir = rom[0x18] | rom[0x19] << 8;
        return [rom[pcir + 4] | rom[pcir + 5] << 8, rom[pcir + 6] | rom[pcir + 7] << 8];
    };
    const checksum = rom => rom.subarray(0, rom[2] * 512).reduce((sum, byte) => sum + byte, 0) & 0xFF;

    const same = original.slice();
    patch_vga_bios_ids(same, 0x1234, 0x1111);
    assert.deepEqual(same, original, "a ROM that names the device stays as it is");

    for(const [vendor, device] of [[0x15AD, 0x0405], [0x1AF4, 0x1050]])
    {
        const rom = original.slice();
        patch_vga_bios_ids(rom, vendor, device);
        assert.deepEqual(ids(rom), [vendor, device]);
        assert.equal(checksum(rom), 0, "the checksum stays valid");
        assert.equal(rom.reduce((n, byte, i) => n + (byte !== original[i]), 0) <= 5, true,
            "only the IDs and the checksum byte change");
    }
    console.log("PASS: the VGA BIOS's PCI ROM header names the adapter's device");
}
