#!/usr/bin/env node

// A virtio entropy device supplied through virtio_devices
// (docs/custom-virtio-devices.md), driven by Linux's own virtio_rng driver:
// the guest reads the device's bytes from /dev/hwrng.

import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const SHOW_LOGS = false;

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

// Not random at all, so that the guest's reads can be checked
const pattern = i => i * 37 + 11 & 0xFF;

let device;
const rng = {
    "name": "rng",
    "device_id": 0x1044,
    "subsystem_device_id": 4,
    "queues": [{ "size": 8 }],
    "init": handle => { device = handle; },
    "notify": queue => {
        let request;
        while((request = device["pop_request"](queue)))
        {
            const bytes = new Uint8Array(request["writable"]);
            for(let i = 0; i < bytes.length; i++) bytes[i] = pattern(i);
            request["write"](bytes);
            request["complete"]();
        }
        device["flush"](queue);
    },
};

const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    autostart: true,
    memory_size: 256 * 1024 * 1024,
    acpi: true,
    cmdline: "console=ttyS0 audit=0",
    disable_jit: +process.env.DISABLE_JIT,
    log_level: SHOW_LOGS ? 0x400000 : 0,
    virtio_devices: [rng],
});

const expected = Array.from({ length: 8 }, (_, i) => pattern(i).toString(16).padStart(2, "0")).join(" ");
let line = "";
let sent_command = false;
let passed = false;

const timeout = setTimeout(() => {
    console.error("\nTest failed: timeout");
    process.exit(1);
}, 120 * 1000);

emulator.add_listener("serial0-output-byte", function(byte)
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    line = chr === "\n" ? "" : line + chr;

    if(!sent_command && line.endsWith("~%"))
    {
        sent_command = true;
        emulator.serial0_send("cat /sys/class/misc/hw_random/rng_current; head -c 8 /dev/hwrng | od -An -tx1\n");
    }

    if(!passed && line.trim() === expected)
    {
        passed = true;
        clearTimeout(timeout);
        console.log("Test passed: /dev/hwrng reads " + expected);
        emulator.destroy();
    }
});
