#!/usr/bin/env node
// Delayed Wasm publication must not write a slot after restoring or resetting
// the machine. Use the real publication bridge with a deliberately held host
// compilation promise; validators are spies so a missing epoch guard is seen.
import assert from "node:assert/strict";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const vm = new V86({ graphics_adapter: "bochs_vga", acpi: true, cpu_cores: 2, memory_size: 16 << 20, autostart: false, log_level: 0 });
await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
try
{
    const cpu = vm.v86.cpu;
    const saved = await vm.save_state();
    // Valid tiny module exporting () -> i32 as f. Compile outside the held
    // promise to isolate publication ordering from host compiler timing.
    const code = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,5,1,1,102,0,0,10,6,1,4,0,65,7,11]);
    const instance = await WebAssembly.instantiate(code);
    const instantiate = WebAssembly.instantiate;
    for(const action of ["restore", "reset"])
    {
        let release;
        let writes = 0;
        const original = cpu.wm;
        const exports = { ...original.exports, ir_cache_validate: () => 1,
            ir_cache_finish: () => { writes++; return 1; }, ir_cache_cancel: () => { writes++; },
            ir_cache_collect: () => { writes++; } };
        const table = { set: () => { writes++; } };
        const owner = { exports, wasm_table: table };
        cpu.wm = owner;
        WebAssembly.instantiate = () => new Promise(resolve => { release = resolve; });
        const pending = cpu.ir_publish_cached({ wasm: owner, exports, table }, 1, 1, code, false);
        // Perform the real lifecycle action on the real CPU. Then restore the
        // owner identity: only the epoch, not an object mismatch, rejects it.
        cpu.wm = original;
        if(action === "restore") await vm.restore_state(saved);
        else cpu.reboot_internal();
        cpu.wm = owner;
        release(instance);
        assert.equal(await pending, false, `${action}: stale publication rejected`);
        assert.equal(writes, 0, `${action}: no slot installation, cancellation or completion in the new generation`);
        cpu.wm = original;
        WebAssembly.instantiate = instantiate;
    }
    console.log("SMP publication: callbacks held across restore/reset cannot install or cancel slots in the new machine generation");
}
finally { await vm.destroy(); }
