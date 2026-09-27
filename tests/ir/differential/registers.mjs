import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
import {COMPILED_ARMS, compiled_activations} from "../../rust/compiled_arms.mjs";
const programs = JSON.parse(fs.readFileSync("build/ir-integer/programs.json"));
const inputs = [[0, 0, 2], [0x7FFFFFFF, 1, 0x8D7], [0x80000000, 0xFFFFFFFF, 3],
    [0xFFFFFFFF, 0xFFFFFFFF, 3], [0x80FF7FFF, 0x7F018001, 2], [0xFFFF, 0x8001, 0x8D7]];
const CODE = 0x100000, OUT = 0x400000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gprs = (a, b) => [a, 0x1234FFFF, 0x80007F80, b, 0x90000, 0x80000002, 0xFFFF0007, 0xABCDEF01];
// Independent BigInt arithmetic oracle for the single-instruction ALU subset.
function reference(bytes, regs, flags) {
    const prefix = bytes[0] === 0x66 ? 1 : 0, op = bytes[prefix];
    if(bytes.length !== prefix + 2 || op > 0x3B || (op & 7) > 3) return null;
    const width = (op & 1) === 0 ? 8 : prefix ? 16 : 32;
    const m = bytes[prefix + 1], reg = m >> 3 & 7, rm = m & 7;
    const dst = op & 2 ? reg : rm, src = op & 2 ? rm : reg;
    const part = r => BigInt((regs[width === 8 ? r & 3 : r] >>> (width === 8 && r >= 4 ? 8 : 0)) >>> 0) & ((1n << BigInt(width)) - 1n);
    const a = part(dst), b = part(src), group = op >> 3, mask = (1n << BigInt(width)) - 1n;
    const carry = group === 2 || group === 3 ? BigInt(flags & 1) : 0n;
    const sub = [3, 5, 7].includes(group), logical = [1, 4, 6].includes(group);
    const raw = group === 1 ? a | b : group === 4 ? a & b : group === 6 ? a ^ b : sub ? a - b - carry : a + b + carry;
    const result = raw & mask, sign = 1n << BigInt(width - 1);
    const signed = n => n & sign ? n - mask - 1n : n;
    const signed_raw = sub ? signed(a) - signed(b) - carry : signed(a) + signed(b) + carry;
    const cf = logical ? false : raw < 0 || raw > mask;
    const of = !logical && (signed_raw < -sign || signed_raw >= sign);
    const af = !logical && ((a ^ b ^ result) & 16n) !== 0n;
    let parity = 0; for(let bit = 0n; bit < 8n; bit++) parity ^= Number(result >> bit & 1n);
    const bits = Number(cf) | Number(!parity) << 2 | Number(af) << 4 | Number(result === 0n) << 6 | Number(!!(result & sign)) << 7 | Number(of) << 11;
    const out = [...regs, (flags & ~0x8D5 | bits) >>> 0];
    if(group !== 7) {
        const r = width === 8 ? dst & 3 : dst, shift = width === 8 && dst >= 4 ? 8n : 0n;
        out[r] = Number((BigInt(out[r] >>> 0) & ~(mask << shift)) | result << shift) >>> 0;
    }
    return out;
}
const guest = [], expected = [];
const modules = programs.map((_, i) => [0, 1].map(opt => new WebAssembly.Module(fs.readFileSync(`build/ir-integer/${i}-${opt}.wasm`))));
for(let p = 0; p < programs.length; p++) for(const [a, b, flags] of inputs) {
    const regs = gprs(a, b), snapshots = [];
    for(const module of modules[p]) {
        const m = new WebAssembly.Memory({initial: 64}); const state = new Uint32Array(m.buffer);
        state.set(regs); state[8] = flags;
        new WebAssembly.Instance(module, {e: {m}}).exports.f(0);
        assert.equal(state[9], 0x1000 + programs[p].length, "IR resume EIP");
        snapshots.push(Array.from(state.slice(0, 9)));
    }
    const independent = reference(programs[p], regs, flags);
    if(independent) assert.deepEqual(snapshots[0], independent, `BigInt arithmetic oracle program ${p}`);
    assert.deepEqual(snapshots[1], snapshots[0], `pass differential opcode ${p}`);
    const address = OUT + expected.length * 40;
    for(let r = 0; r < 8; r++) guest.push(0xB8 + r, ...u32(regs[r]));
    guest.push(0x68, ...u32(flags), 0x9D, ...programs[p]);
    for(let r = 0; r < 8; r++) guest.push(0x89, 0x05 | r << 3, ...u32(address + r * 4));
    guest.push(0x9C, 0x8F, 0x05, ...u32(address + 32));
    expected.push({p, regs: snapshots[0], flags, a, b});
}
guest.push(0xFF, 0x05, ...u32(0x600)); // count full executions
const back = -guest.length - 5; guest.push(0xE9, ...u32(back));
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
for(const {label, options} of [{label: "interpreter", options: {disable_jit: true}}, ...COMPILED_ARMS]) {
    const interpreted = !!options.disable_jit;
    const vm = new V86({wasm_path: process.argv[2] || "build/v86.wasm", bios: {buffer: bios.slice(0)}, ...options,
        memory_size: 32 << 20, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
        net_device: {type: "none"}, autostart: false});
    try {
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        const word = address => new DataView(Uint8Array.from(vm.read_memory(address, 4)).buffer).getUint32(0, true);
        vm.run(); let deadline = performance.now() + 10000;
        while(word(0x500) !== 0xCAFE) { assert(performance.now() < deadline, "BIOS timeout"); await sleep(1); }
        await vm.stop();
        const cpu = vm.v86.cpu, e = cpu.wm.exports;
        vm.write_memory(Uint8Array.from(guest), CODE); vm.write_memory(new Uint8Array(4), 0x600);
        cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
        const start = compiled_activations(e);
        vm.run(); deadline = performance.now() + 30000;
        while(word(0x600) < 2 || !interpreted && compiled_activations(e) === start) {
            assert(performance.now() < deadline, "integer matrix timeout"); await sleep(1);
        }
        await vm.stop();
        // Stop can land in a later iteration; inputs and output addresses are identical each iteration.
        const results = new DataView(Uint8Array.from(vm.read_memory(OUT, expected.length * 40)).buffer);
        for(let i = 0; i < expected.length; i++) {
            const item = expected[i]; const actual = Array.from({length: 9}, (_, r) => results.getUint32(i * 40 + r * 4, true));
            actual[8] &= 0x8D5; const wanted = item.regs.slice(); wanted[8] &= 0x8D5;
            assert.deepEqual(actual, wanted, `${label}: program ${item.p} bytes ${programs[item.p]} input ${item.a.toString(16)}/${item.b.toString(16)} flags ${item.flags.toString(16)}`);
        }
        console.log(`PASS: ${expected.length} register/FLAGS cases: ${label} vs unoptimized and optimized IR`);
    } finally { await vm.destroy(); }
}
