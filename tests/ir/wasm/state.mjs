import assert from "node:assert/strict";
import fs from "node:fs";
const cases = JSON.parse(fs.readFileSync("build/ir-mir-state/cases.json"));
const input = [0x12345678, 0x87654321, 0xFFFFFEF0, 3, 0xABCDEF01, 5, 6, 7];
const vectors = Array.from({length: 8}, (_, r) => Uint8Array.from({length: 16}, (_, i) => r * 37 + i * 13));
let executions = 0;
for(const [index, [mode, xmm, backing]] of cases.entries()) for(const opt of [0, 1]) {
    for(const target of xmm ? ["cpu"] : ["cpu", "standalone"]) {
        const cpu = target === "cpu";
        const bytes = fs.readFileSync(`build/ir-mir-state/${index}-${opt}-${target}.wasm`);
        assert(WebAssembly.validate(bytes));
        const m = new WebAssembly.Memory({initial: 64});
        const words = new Uint32Array(m.buffer), data = new Uint8Array(m.buffer);
        const gpr = (cpu ? 64 : 256) / 4, flags = (cpu ? 120 : 288) / 4;
        const eip = (cpu ? 556 : 292) / 4, counter = (cpu ? 664 : 296) / 4, operand = (cpu ? 104 : 300) / 4;
        let computed = 0;
        const get_eflags = () => words[flags] & ~64 | computed << 6;
        const f = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {
            m, ir_enter: () => {}, ir_tlb_base: () => 0,
            get_eflags,
            ir_read_cf: () => get_eflags() & 1,
            ir_read_pf: () => get_eflags() & 4,
            ir_read_af: () => get_eflags() & 16,
            ir_read_zf: () => get_eflags() & 64,
            ir_read_sf: () => get_eflags() & 128,
            ir_read_of: () => get_eflags() & 2048,
        }}).exports.f;
        for(const cs of cpu ? [0, 0x7000, 0xFFFFF000, 0xFFFFFFFF] : [0]) {
            for(const count of [0, 0xFFFFFFFE]) for(const lazy of [0, 1]) for(const raw of [0, 1]) {
                for(const value of lazy ? [0, 1] : [raw]) for(let repeat = 0; repeat < 2; repeat++) {
                    computed = value;
                    const raw_flags = 0x897 | raw << 6;
                    const computed_flags = 0x897 | computed << 6;
                    words.set(input, gpr); words[flags] = raw_flags;
                    words[counter] = cpu ? (count + 7 * repeat) >>> 0 : count;
                    words[operand] = 0x55667788;
                    words[25] = lazy << 6; words[28] = 0x1234; words[24] = 17; words[185] = cs;
                    words[140] = 0x55AA55AA;
                    for(let r = 0; r < 8; r++) data.set(vectors[r], 832 + r * 16);
                    f(0);
                    assert.deepEqual(Array.from(words.slice(gpr, gpr + 8)), input.slice().reverse());
                    assert.equal(words[flags], cpu && !backing ? computed_flags : raw_flags);
                    assert.equal(words[operand], backing ? input[0] : 0x55667788);
                    const logical = mode === 3 ? input[2] : mode === 1 ? 0x1004 : 0x1000;
                    assert.equal(words[eip], (logical + (cpu ? cs : 0)) >>> 0);
                    assert.equal(words[counter], cpu ? (count + 7 * (repeat + 1)) >>> 0 : 7);
                    assert.equal(words[140], cpu ? (cs + 0x1000) >>> 0 : 0x55AA55AA);
                    if(cpu) {
                        assert.equal(words[25], backing ? lazy << 6 : 0);
                        assert.equal(words[28], backing ? 1 - computed : 0x1234);
                        assert.equal(words[24], backing ? 31 : 17);
                    }
                    if(xmm) for(let r = 0; r < 8; r++) assert.deepEqual(data.slice(832 + r * 16, 848 + r * 16), vectors[(r + 1) % 8]);
                    executions++;
                }
            }
        }
    }
}
console.log(`PASS: ${executions} MIR state materialization executions: PC modes, CS/count wrapping, raw/lazy ZF, GPR/XMM writes and reentry`);
