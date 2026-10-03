// Disabling IR scheduling at run time (ir_auto_config) stops promotion of a
// retained Tier-1 region for 128 CPU frames; re-enabling promotes the same entry.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-debug.wasm";
// Region tiers only; Tier 2 waits for an explicit promotion threshold below.
const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 32 << 20, ir_tier0: false,
    ir_region_budget: { hot_threshold: 2, promotion_threshold: 1000000 },
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/cpu-worker-test.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, message) => {
    const deadline = performance.now() + 15000;
    while(!test()) { assert(performance.now() < deadline, message); await sleep(1); }
};
try
{
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run(); await until(() => cpu.mem32s[0x500 >> 2] === 0xCAFE, "boot"); await vm.stop();
    cpu.jit_clear_cache();
    const pc = 0x1200000;
    vm.write_memory(Uint8Array.of(0x40, 0xEB, 0xFD), pc);
    cpu.instruction_pointer[0] = pc; cpu.in_hlt[0] = 0;
    const tier = () => e.ir_cache_entry_stat(pc, 0, 1, 5);
    vm.run(); await until(() => tier() === 1, "Tier 1 publication"); await vm.stop();
    const configure = (enabled, promote) => assert(e.ir_auto_config(enabled, 2, promote, 192, 256, 64));
    configure(0, 4);
    const promotions = vm.get_jit_info().ir.tier2_published, hits = e.ir_cache_entry_stat(pc, 0, 1, 1);
    let frames = 0;
    const main_loop = cpu.main_loop;
    cpu.main_loop = function() { const result = main_loop.call(this); frames++; return result; };
    vm.run(); await until(() => frames >= 128, "128 CPU frames"); await vm.stop();
    const retained_hits = (e.ir_cache_entry_stat(pc, 0, 1, 1) - hits) >>> 0;
    assert.equal(tier(), 1, "the Tier 1 entry is retained");
    assert(retained_hits > 0, "retained Tier 1 code still executed");
    assert.equal(vm.get_jit_info().ir.tier2_published, promotions, "disabled scheduling also suppresses promotion");
    configure(1, 4); vm.run(); await until(() => tier() === 2, "promotion after re-enabling"); await vm.stop();
    assert(vm.get_jit_info().ir.tier2_published > promotions, "same cached entry promotes after re-enabling scheduling");
    console.log(`PASS: ${wasm}: disabled IR scheduling prevents promotion for 128 CPU frames (retained Tier 1 entry ran ${retained_hits} times); re-enable promotes it`);
}
finally { await vm.destroy(); }
