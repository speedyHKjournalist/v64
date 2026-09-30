#!/usr/bin/env node

import url from "node:url";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// This test checks that emulator.destroy() works before the emulator has
// loaded: it resolves, the emulator never starts, and the nodejs process
// exits by itself.

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

process.on("unhandledRejection", exn => { throw exn; });

const config = {
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: __dirname + "/../../images/linux4.iso", async: true },
    autostart: true,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
    disable_jit: +process.env.DISABLE_JIT,
};

async function destroy_early(name, wait)
{
    const emulator = new V86(config);
    emulator.add_listener("emulator-loaded", () => {
        console.error("Failed: the emulator loaded after destroy() (%s)", name);
        process.exit(1);
    });
    await wait(emulator);
    await emulator.destroy();
    console.log("Destroyed: %s", name);
}

await destroy_early("while the wasm module loads", async () => {});
await destroy_early("while the images load", async emulator => {
    while(!emulator.v86) await new Promise(resolve => setTimeout(resolve, 1));
});

// Loading goes on in the background: give it the time to (not) finish
await new Promise(resolve => setTimeout(resolve, 2000));
console.log("Done");
