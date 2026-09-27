// Capture hot XP code pages (bytes plus observed IR entry points) for offline
// region-formation and compiler-scaling experiments. Guest disk writes stay in
// the RAM overlay. Output: JSON lines, one per physical page.
import fs from "node:fs";
import assert from "node:assert/strict";
import { V86 } from "../../../build/libv86.mjs";
const [disk, out, wasm = "build/v86-ir-runtime.wasm"] = process.argv.slice(2);
assert(disk && out);
const vm = new V86({
    wasm_path: wasm, jit_backend: "ir",
    memory_size: 2048 * 1024 * 1024, vga_memory_size: 16 * 1024 * 1024,
    bios: { url: "bios/seabios.bin" }, vga_bios: { url: "bios/vgabios.bin" },
    hda: { url: disk, size: fs.statSync(disk).size, async: true },
    x87_fast_math: true, x87_jit_cache: true,
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "ne2k" }, autostart: false,
});
let milestone = false;
vm.add_listener("screen-set-size", size => {
    if(size[0] === 800 && size[1] === 600 && size[2] === 32) milestone = true;
});
await new Promise((resolve, reject) => {
    vm.add_listener("emulator-loaded", resolve);
    vm.add_listener("emulator-error", reject);
});
const cpu = vm.v86.cpu, e = cpu.wm.exports;
// key: physical page -> {linear page, cs_base, default_32, entries:Set(offset), publications}
const pages = new Map();
const publish = cpu.ir_auto_publish;
cpu.ir_auto_publish = function(id, ...args) {
    const get = (g, i, f) => e.ir_cache_replay_info(id, g, i, f) >>> 0;
    const sources = get(0, 0, 0), default_32 = get(0, 0, 4);
    for(let s = 0; s < sources; s++) {
        const pc = get(1, s, 0), linear = get(1, s, 1), maps = get(1, s, 4);
        const cs_base = (linear - pc) >>> 0;
        const mapping = Array.from({ length: maps }, (_, m) => [get(4, s * 65536 + m, 0), get(4, s * 65536 + m, 1)]);
        const offsets = [0, ...Array.from({ length: s === 0 ? get(0, 0, 1) : 0 }, (_, i) => get(2, i, 0))];
        for(const offset of offsets) {
            const at = (linear + offset) >>> 0;
            const m = mapping.find(([l]) => l === (at & ~4095) >>> 0);
            if(!m) continue;
            const physical = m[1];
            let page = pages.get(physical);
            if(!page) pages.set(physical, page = { physical, linear: m[0], cs_base, default_32, entries: new Set(), publications: 0 });
            page.entries.add(at & 4095);
            page.publications++;
        }
    }
    return publish.call(this, id, ...args);
};
vm.run();
const started = performance.now();
while(!milestone && performance.now() - started < 180000) await new Promise(r => setTimeout(r, 250));
await vm.stop();
const mem8 = cpu.mem8;
const lines = [];
for(const page of pages.values()) {
    const next = page.physical + 4096 < mem8.length ? mem8.subarray(page.physical + 4096, page.physical + 4096 + 16) : new Uint8Array(0);
    lines.push(JSON.stringify({ physical: page.physical, linear: page.linear, cs_base: page.cs_base, default_32: page.default_32,
        publications: page.publications, entries: [...page.entries].sort((a, b) => a - b),
        bytes: Buffer.from(mem8.subarray(page.physical, page.physical + 4096)).toString("hex"),
        next: Buffer.from(next).toString("hex") }));
}
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(JSON.stringify({ pages: pages.size, milestone, ms: performance.now() - started }));
await vm.destroy();
