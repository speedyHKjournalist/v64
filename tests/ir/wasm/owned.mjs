import assert from "node:assert/strict";
import fs from "node:fs";
const directory = "build/ir-mir-owned";
const cases = JSON.parse(fs.readFileSync(`${directory}/literals.json`));
const oracle = ([op, left, right, condition, wide]) => {
    const width = op === "Select" ? wide ? 64 : 32 : op.startsWith("I64") ? 64 : 32;
    const signed = n => BigInt.asIntN(width, n), unsigned = n => BigInt.asUintN(width, n);
    const a = signed(BigInt(left)), b = signed(BigInt(right)), ua = unsigned(a), ub = unsigned(b);
    if(op === "I32WrapI64") return BigInt.asIntN(32, BigInt(left));
    if(op === "I64ExtendSignedI32") return BigInt.asIntN(32, BigInt(left));
    if(op === "I64ExtendUnsignedI32") return BigInt.asUintN(32, BigInt(left));
    if(op === "Select") return condition ? a : b;
    const operation = op.slice(3), shift = ub & BigInt(width - 1);
    let value;
    switch(operation) {
        case "Add": value = a + b; break;
        case "Sub": value = a - b; break;
        case "Mul": value = a * b; break;
        case "And": value = ua & ub; break;
        case "Or": value = ua | ub; break;
        case "Xor": value = ua ^ ub; break;
        case "Shl": value = ua << shift; break;
        case "Shr": value = ua >> shift; break;
        case "Sar": value = a >> shift; break;
        case "Eq": return BigInt(a === b);
        case "Ult": return BigInt(ua < ub);
        case "Slt": return BigInt(a < b);
        case "Clz": value = BigInt(ua ? width - ua.toString(2).length : width); break;
        case "Ctz": {
            value = BigInt(width);
            if(ua) { value = 0n; for(let n = ua; !(n & 1n); n >>= 1n) value++; }
            break;
        }
        case "Popcnt": value = BigInt([...ua.toString(2)].filter(bit => bit === "1").length); break;
        default: throw new Error(op);
    }
    return BigInt.asIntN(wide ? 64 : 32, value);
};
const sizes = [];
for(const optimization of [0, 1]) {
    const bytes = fs.readFileSync(`${directory}/literals-${optimization}.wasm`); sizes.push(bytes.length);
    assert(WebAssembly.validate(bytes));
    const m = new WebAssembly.Memory({initial: 64});
    new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {m}}).exports.f(0);
    const view = new DataView(m.buffer);
    cases.forEach((entry, index) => {
        const actual = entry[4] ? view.getBigInt64(index * 8, true) : BigInt(view.getInt32(index * 8, true));
        assert.equal(actual, oracle(entry), `MIR literal ${optimization}/${index}: ${entry}`);
    });
}
assert(sizes[1] < sizes[0]);
let executions = 0;
for(const program of [0, 1, 2]) for(const optimized of [0, 1]) {
    const module = new WebAssembly.Module(fs.readFileSync(`${directory}/mov-${program}-${optimized}.wasm`));
    for(const initial of [0, 1, -1, 0x12345678, -2147483648, 2147483647]) {
        const m = new WebAssembly.Memory({initial: 64}), words = new Uint32Array(m.buffer);
        for(let reg = 0; reg < 8; reg++) words[reg] = initial + reg * 0x1020304;
        words[8] = 0x246;
        const expected = Array.from(words.slice(0, 8));
        expected[0] = (program === 0 ? initial & ~255 | 255 : program === 1 ? initial & ~0xFF00 | 0x8000 : initial & ~0xFFFF | 0x9234) >>> 0;
        new WebAssembly.Instance(module, {e: {m}}).exports.f(0);
        assert.deepEqual(Array.from(words.slice(0, 8)), expected);
        assert.equal(words[8], 0x246); assert.equal(words[9], 0x1000 + (program === 2 ? 4 : 2)); assert.equal(words[10], 1);
        executions++;
    }
}
console.log(`PASS: ${cases.length * 2} independent BigInt/Wasm literal executions and ${executions} HIR-free MIR rewrite executions; literal modules ${sizes[0]} -> ${sizes[1]} bytes`);

const stack_count=JSON.parse(fs.readFileSync(`${directory}/stack.json`));
for(let program=0;program<stack_count;program++) {
    const modules=[0,1,2].map(v=>new WebAssembly.Module(fs.readFileSync(`${directory}/stack-${program}-${v}.wasm`)));
    for(let seed=0;seed<64;seed++) {
        let expected;
        for(const module of modules) {
            const m=new WebAssembly.Memory({initial:64}),words=new Uint32Array(m.buffer);
            for(let n=0;n<8;n++) words[n]=(seed*0x1234567+n*0x7654321)>>>0;
            words[8]=seed&1?0x8D7:2;
            new WebAssembly.Instance(module,{e:{m}}).exports.f(0);
            const actual=Array.from(words.slice(0,16));
            if(expected) assert.deepEqual(actual,expected,`owned MIR allocation ${program}/${seed}`);
            else expected=actual;
        }
    }
}
console.log(`PASS: ${stack_count*64*3} stack scheduling/reallocation executions, including typed phi-copy cycles`);
