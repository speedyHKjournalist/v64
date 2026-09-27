import assert from "node:assert/strict";
import fs from "node:fs";
const directory = "build/ir-simd-peephole";
const layout = JSON.parse(fs.readFileSync(`${directory}/layout.json`));
const shuffle = (a, b, mask) => Uint8Array.from(mask, i => i < 16 ? a[i] : b[i - 16]);
function oracle(test, a, b, c, scalar) {
    switch(test) {
        case 0: case 2: case 3: case 6: case 7: case 8: case 11: case 12:
        case 13: case 14: case 15: case 16: return a.slice();
        case 1: return b.slice();
        case 4: case 5: {
            const x = shuffle(a, b, Array.from({length: 16}, (_, i) => i * 7 % 32));
            return shuffle(x, test === 4 ? b : c, Array.from({length: 16}, (_, i) => i * 3 % 32));
        }
        case 9: case 10: return new Uint8Array(16);
        case 17: case 18: {
            const result = b.slice();
            new DataView(result.buffer).setUint32(0, test === 18 ? scalar & 0xFFFF : scalar, true);
            return result;
        }
        case 19: {
            const x = Uint8Array.from(b, (v, i) => v ^ c[i]);
            const result = new Uint8Array(16), out = new DataView(result.buffer);
            const av = new DataView(a.buffer, a.byteOffset, 16), xv = new DataView(x.buffer);
            for(let i = 0; i < 16; i += 4) out.setUint32(i, av.getUint32(i, true) + xv.getUint32(i, true), true);
            return result;
        }
        default: throw new Error(`unmodeled case ${test}`);
    }
}
let seed = 0x13A78609;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const inputs = [];
for(const byte of [0, 1, 0x7F, 0x80, 0xFF]) for(const scalar of [0, 0xFFFF, 0x80000000, 0xFEDCBA98]) {
    inputs.push({a: new Uint8Array(16).fill(byte), b: Uint8Array.from({length:16}, (_, i) => i * 17),
        c: Uint8Array.from({length:16}, (_, i) => 255 - i * 13), scalar});
}
for(let n = 0; n < 256; n++) inputs.push({a: Uint8Array.from({length:16}, random),
    b: Uint8Array.from({length:16}, random), c: Uint8Array.from({length:16}, random), scalar: random()});
let executions = 0, smaller = 0;
for(let test = 0; test < layout.cases; test++) {
    const memory = new WebAssembly.Memory({initial: 64});
    const data = new Uint8Array(memory.buffer), words = new Uint32Array(memory.buffer);
    const programs = [0, 1, 2].map(opt => {
        const bytes = fs.readFileSync(`${directory}/${test}-${opt}.wasm`);
        assert(WebAssembly.validate(bytes));
        // Real compiler output with a deterministic CPU-ABI host, not a full
        // boot/system test. The same harness is used by other MIR unit suites.
        const get_eflags = () => words[layout.flags / 4];
        const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {
            m: memory, ir_enter: () => {}, ir_tlb_base: () => 0,
            get_eflags,
            ir_read_cf: () => get_eflags() & 1,
            ir_read_pf: () => get_eflags() & 4,
            ir_read_af: () => get_eflags() & 16,
            ir_read_zf: () => get_eflags() & 64,
            ir_read_sf: () => get_eflags() & 128,
            ir_read_of: () => get_eflags() & 2048,
        }});
        return {instance, size: bytes.length};
    });
    smaller += Number(programs[2].size < programs[0].size);
    for(const {a,b,c,scalar} of inputs) for(const flags of [2, 0x8D7, 0x202]) {
        const expected = oracle(test,a,b,c,scalar);
        const outcomes = programs.map(({instance}) => {
            data.fill(0,0,4096);
            words.set([17,18,19,20,scalar,22,23,24],layout.gpr / 4);
            words[layout.flags / 4] = flags;
            words[layout.operand / 4] = 0x87654321;
            words[layout.counter / 4] = 0xFFFFFFFF;
            data.set(a, layout.xmm); data.set(b,layout.xmm + 16); data.set(c,layout.xmm + 32);
            instance.exports.f(0);
            assert.deepEqual(data.slice(layout.gpr,layout.gpr + 16),expected,`SIMD oracle case ${test}`);
            const vectors = [expected,a,b,c,a,b,c,expected];
            vectors.forEach((v,i) => assert.deepEqual(data.slice(layout.xmm+i*16,layout.xmm+(i+1)*16),v,`snapshot XMM${i}`));
            assert.equal(words[layout.flags / 4],flags);
            assert.equal(words[layout.operand / 4],0x87654321);
            assert.equal(words[layout.counter / 4],0,"instruction count wraps correctly");
            assert.equal(words[layout.eip / 4],0x5001);
            executions++;
            return data.slice(0,4096);
        });
        assert.deepEqual(outcomes[1],outcomes[0],"direct pass preserves complete observed CPU memory");
        assert.deepEqual(outcomes[2],outcomes[0],"whole pipeline preserves complete observed CPU memory");
    }
}
assert(smaller > 0,"optimized pipeline must reduce emitted module size on at least one fixture");
console.log(`PASS: ${executions} SIMD peephole Wasm executions; independent byte oracle, three-input rejection, PANDN ordering, lane truncation and full CPU snapshots; ${smaller}/${layout.cases} smaller modules`);
