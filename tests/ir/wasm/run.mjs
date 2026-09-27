import assert from "node:assert/strict";
import fs from "node:fs";
import "./helpers.mjs";
import "./control.mjs";
import "./value.mjs";
import "./state.mjs";
import "./dynamic_count.mjs";
import "./dataflow.mjs";
import "./owned.mjs";
import "./licm.mjs";
import "./simd_peephole.mjs";
import "./scalar.mjs";
import "./sccp.mjs";
for(const n of [127, 128, 255, 256, 1023, 1024]) {
    for(const kind of ["locals", "groups", "imports", "depth"]) {
        const bytes = fs.readFileSync(`build/ir-wasm/${kind}-${n}.wasm`);
        assert(WebAssembly.validate(bytes), `${kind}-${n} validates`);
        const module = new WebAssembly.Module(bytes);
        const m = new WebAssembly.Memory({initial: 64});
        let calls = 0;
        const e = {m};
        for(const item of WebAssembly.Module.imports(module)) {
            if(item.kind === "function") e[item.name] = () => { calls++; };
        }
        new WebAssembly.Instance(module, {e}).exports.f(0);
        if(kind === "imports") assert.equal(calls, n);
        if(kind === "locals" || kind === "groups") {
            const words = new Int32Array(m.buffer, 0, n);
            for(let i = 0; i < n; i++) assert.equal(words[i], i, `${kind}-${n} local ${i}`);
        }
    }
}
console.log("PASS: 24 Wasm modules: locals, mixed type groups, signatures/imports, branch depths; boundaries 127/128, 255/256, 1023/1024");
{
    const m = new WebAssembly.Memory({initial: 64});
    const bytes = new Uint8Array(m.buffer);
    const module = new WebAssembly.Module(fs.readFileSync("build/ir-wasm/fresh-zeroed-locals.wasm"));
    const instance = new WebAssembly.Instance(module, {e: {m}});
    for(let run = 0; run < 2; run++) {
        bytes.fill(0xA5, 0, 1088);
        instance.exports.f(0);
        assert(bytes.slice(32, 1064).every(value => value === 0));
        assert(bytes.slice(1072, 1088).every(value => value === 0));
        assert(bytes.slice(0, 32).every(value => value === 0xA5));
    }
}
console.log("PASS: fresh I32/I64/V128 local declarations remain zero across calls and skip freed nonzero slots");
for(const budget of [3, 100]) {
    const module = new WebAssembly.Module(fs.readFileSync(`build/ir-wasm/ssa-loop-${budget}.wasm`));
    for(const entry of [0, 1, -1, 2]) {
        const m = new WebAssembly.Memory({initial: 64});
        const words = new Uint32Array(m.buffer); words[0] = 123;
        new WebAssembly.Instance(module, {e: {m}}).exports.f(entry);
        if(entry < 0 || entry > 1) { assert.equal(words[0], 123); continue; }
        assert.deepEqual(Array.from(words.slice(0, 3)), budget === 3 ? entry === 0 ? [1, 2, 3] : [10, 20, 2] : entry === 0 ? [2, 1, 0] : [10, 20, 0]);
        assert.equal(words[9], 0x1000, "cold exit restored EIP");
    }
}
console.log("PASS: native IR SSA loops, multi-entry, parallel-copy cycles, typed local reuse and budget StateMaps");
{
    // A Wasm-to-Wasm v128 helper; vector values never cross the JS call ABI.
    const identity = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from([
        0,97,115,109,1,0,0,0,
        1,6,1,0x60,1,0x7B,1,0x7B,
        3,2,1,0,
        7,5,1,1,0x66,0,0,
        10,6,1,4,0,0x20,0,0x0B,
    ]))).exports.f;
    const m = new WebAssembly.Memory({initial: 64});
    const data = new Uint8Array(m.buffer); for(let i = 0; i < 16; i++) data[i] = i * 13 + 7;
    new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync("build/ir-wasm/typed-helpers.wasm")), {
        e: {m, vector_identity: identity, pair: () => [12345, 0x123456789ABCDEF0n]},
    }).exports.f(0);
    assert.deepEqual(data.slice(0, 16), data.slice(16, 32));
    const view = new DataView(m.buffer);
    assert.equal(view.getInt32(32, true), 12345); assert.equal(view.getBigUint64(40, true), 0x123456789ABCDEF0n);
}
console.log("PASS: v128 Wasm helper ABI and typed multivalue return execution");
{
    const cases = JSON.parse(fs.readFileSync("build/ir-branches/cases.json"));
    for(let i = 0; i < cases.length; i++) {
        const [cc, length, displacement, operand32] = cases[i];
        for(const opt of [0, 1]) {
            const module = new WebAssembly.Module(fs.readFileSync(`build/ir-branches/${i}-${opt}.wasm`));
            for(let bits = 0; bits < 32; bits++) {
                const [cf, pf, zf, sf, of] = Array.from({length: 5}, (_, i) => bits >> i & 1);
                const conditions = [of, !of, cf, !cf, zf, !zf, cf || zf, !cf && !zf,
                    sf, !sf, pf, !pf, sf !== of, sf === of, zf || sf !== of, !zf && sf === of];
                const flags = 2 | cf | pf << 2 | zf << 6 | sf << 7 | of << 11;
                const m = new WebAssembly.Memory({initial: 64}), state = new Uint32Array(m.buffer);
                state[8] = flags;
                new WebAssembly.Instance(module, {e: {m}}).exports.f(0);
                let target = 0xFFFC + length;
                if(conditions[cc]) { target += displacement; if(!operand32) target &= 65535; }
                assert.equal(state[9], target, `Jcc ${cc}, opt ${opt}, flags ${flags}`);
                assert.equal(state[8], flags, "Jcc preserves FLAGS");
                assert.equal(state[10], 1, "guest instruction accounted once");
            }
        }
    }
}
console.log("PASS: 4,096 terminal Jcc executions, all conditions, optimized/unoptimized and 16-bit target wrapping");
