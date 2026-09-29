#!/usr/bin/env node

import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const config_async_cdrom = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    filesystem: {},
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_sync_cdrom = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: false },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    filesystem: {},
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_filesystem = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    autostart: true,
    memory_size: 64 * 1024 * 1024,
    filesystem: {},
    bzimage: { url: __dirname + "/../../images/buildroot-bzimage68.bin" },
    cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
    network_relay_url: "<UNUSED>",
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

const config_large_memory = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 2048 * 1024 * 1024,
    vga_memory_size: 512 * 1024 * 1024,
    network_relay_url: "<UNUSED>",
    disable_jit: +process.env.DISABLE_JIT,
    log_level: 0,
};

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run_test(name, config, done)
{
    const emulator = new V86(config);

    await sleep(2000);

    console.log("Saving: %s", name);
    const before_save = await emulator.get_diagnostics();
    const state = await emulator.save_state();

    await sleep(1000);

    console.log("Restoring: %s", name);
    await emulator.restore_state(state);

    const booted = await emulator.wait_until_vga_screen_contains("~% ", { timeout_msec: 120000 });
    if(!booted)
    {
        console.error("Timed out after restoring: " + name);
        console.error(JSON.stringify({ before_save, after_restore: await emulator.get_diagnostics() }));
        console.error(emulator.screen_adapter.get_text_screen());
        emulator.destroy();
        throw new Error("Guest did not boot after restoring " + name);
    }
    await sleep(1000);

    emulator.keyboard_send_text("echo -n test; echo passed\n");
    const responded = await emulator.wait_until_vga_screen_contains("testpassed", { timeout_msec: 10000 });
    if(!responded)
    {
        console.warn("Failed: " + name);
        const lines = emulator.screen_adapter.get_text_screen();
        console.warn(lines.map(line => line.replace(/\x00/g, " ")));
        process.exit(1);
    }

    console.log("Done: %s", name);
    emulator.destroy();
}

(async function() {
    await run_test("async cdrom", config_async_cdrom);
    await run_test("sync cdrom", config_sync_cdrom);
    await run_test("filesystem", config_filesystem);
    await run_test("large memory size", config_large_memory);
})();
