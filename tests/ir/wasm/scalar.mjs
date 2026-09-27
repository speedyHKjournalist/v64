import assert from "node:assert/strict";
import fs from "node:fs";

// This arithmetic oracle does not import or mirror the optimizer's matcher.
// --oracle-only checks the identities, NOT the Rust pass or emitted modules.
const names = [
    "add-r0", "add-l0", "sub-r0", "sub-self", "mul-r1", "mul-l1", "mul-r0", "mul-l0",
    "and-rmask", "and-lmask", "and-self", "and-r0", "and-l0", "or-r0", "or-l0", "or-self",
    "or-rmask", "or-lmask", "xor-r0", "xor-l0", "xor-self", "eq-self", "ult-self", "slt-self",
    "shl-zero", "shr-zero", "sar-zero", "shl-masked-zero", "shr-masked-zero", "sar-masked-zero",
    "select-same", "select-true", "select-false", "truncate-unsigned", "truncate-signed",
    "shl-nonzero", "shr-nonzero", "sar-nonzero",
];
const cases = [1, 8, 16, 32, 64].flatMap(bits => names
    .filter(name => bits !== 64 || !name.startsWith("truncate-"))
    .map(name => [bits, name]));
function expression(bits, name, x, y) {
    const mask = (1n << BigInt(bits)) - 1n;
    const signed = value => BigInt.asIntN(bits, value);
    let result;
    switch(name) {
    case "add-r0": result = x + 0n; break;
    case "add-l0": result = 0n + x; break;
    case "sub-r0": result = x - 0n; break;
    case "sub-self": result = x - x; break;
    case "mul-r1": result = x * 1n; break;
    case "mul-l1": result = 1n * x; break;
    case "mul-r0": result = x * 0n; break;
    case "mul-l0": result = 0n * x; break;
    case "and-rmask": result = x & mask; break;
    case "and-lmask": result = mask & x; break;
    case "and-self": result = x & x; break;
    case "and-r0": result = x & 0n; break;
    case "and-l0": result = 0n & x; break;
    case "or-r0": result = x | 0n; break;
    case "or-l0": result = 0n | x; break;
    case "or-self": result = x | x; break;
    case "or-rmask": result = x | mask; break;
    case "or-lmask": result = mask | x; break;
    case "xor-r0": result = x ^ 0n; break;
    case "xor-l0": result = 0n ^ x; break;
    case "xor-self": result = x ^ x; break;
    case "eq-self": result = BigInt(x === x); break;
    case "ult-self": result = BigInt(x < x); break;
    case "slt-self": result = BigInt(signed(x) < signed(x)); break;
    case "select-same": result = y === 0n ? x : x; break;
    case "select-true": result = 1n !== 0n ? x : y; break;
    case "select-false": result = 0n !== 0n ? x : y; break;
    case "truncate-unsigned": result = BigInt.asUintN(bits, BigInt.asUintN(64, x)); break;
    case "truncate-signed": result = BigInt.asUintN(bits, BigInt.asUintN(64, signed(x))); break;
    default: {
        const count = name.endsWith("masked-zero") ? BigInt(bits === 64 ? 64 : 32)
            : name.endsWith("nonzero") ? BigInt(bits < 32 ? bits : 1) : 0n;
        const shift = BigInt.asUintN(bits, count) & BigInt(bits === 64 ? 63 : 31);
        if(name.startsWith("shl-")) result = x << shift;
        else if(name.startsWith("shr-")) result = x >> shift;
        else if(name.startsWith("sar-")) result = signed(x) >> shift;
        else throw new Error(`unknown scalar oracle ${name}`);
    }
    }
    return BigInt.asUintN(bits, result);
}
function simplified(bits, name, x, y) {
    if(["sub-self", "mul-r0", "mul-l0", "and-r0", "and-l0", "xor-self", "ult-self", "slt-self"].includes(name)) return 0n;
    if(name === "eq-self") return 1n;
    if(name === "or-rmask" || name === "or-lmask") return (1n << BigInt(bits)) - 1n;
    if(name === "select-false") return y;
    if(name.endsWith("nonzero")) return expression(bits, name, x, y); // Deliberately NOT an identity.
    return x;
}
function inputs(bits) {
    if(bits <= 8) return Array.from({length: 2 ** bits}, (_, n) => BigInt(n));
    const mask = (1n << BigInt(bits)) - 1n;
    const high = 1n << BigInt(bits - 1);
    const values = [0n, 1n, 2n, mask, mask - 1n, high, high - 1n, high + 1n, 0xFFFFFFFFn, 0x100000000n];
    let seed = 0x123456789ABCDEF0n;
    for(let n = 0; n < 256; n++) {
        seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1442695040888963407n);
        values.push(seed);
    }
    return [...new Set(values.map(n => n & mask))];
}
let oracle_checks = 0;
for(const [bits, name] of cases) {
    for(const x of inputs(bits)) {
        const y = BigInt.asUintN(bits, ~x);
        assert.equal(expression(bits, name, x, y), simplified(bits, name, x, y), `${bits}/${name}/${x}`);
        oracle_checks++;
    }
}
console.log(`PASS: ${oracle_checks} independent scalar identity checks (not a Rust compiler execution)`);

if(!process.argv.includes("--oracle-only")) {
    const manifest = JSON.parse(fs.readFileSync("build/ir-scalar/cases.json", "utf8"));
    assert.deepEqual(manifest, cases, "all scalar fixture families must be generated; no silent skips");
    const memory = new WebAssembly.Memory({initial: 64});
    const words = new Uint32Array(memory.buffer, 0, 16);
    let executions = 0;
    for(const [bits, name] of manifest) {
        const functions = [false, true].map(opt => {
            const bytes = fs.readFileSync(`build/ir-scalar/${bits}-${name}-${opt}.wasm`);
            assert(WebAssembly.validate(bytes), `${bits}/${name}/${opt} validates`);
            const module = new WebAssembly.Module(bytes);
            // Scalar identities must not introduce a generic instruction helper.
            assert(WebAssembly.Module.imports(module).every(item => item.kind === "memory"));
            return new WebAssembly.Instance(module, {e: {m: memory}}).exports.f;
        });
        for(const x of inputs(bits)) {
            const y = BigInt.asUintN(bits, ~x);
            const initial = new Uint32Array(16).fill(0xA5A5A5A5);
            initial[0] = Number(x & 0xFFFFFFFFn);
            initial[1] = Number(x >> 32n);
            initial[2] = Number(y & 0xFFFFFFFFn);
            initial[3] = Number(y >> 32n);
            initial[7] = Number(x & 1n);
            initial[8] = 2 | Number(x & 0x8D5n);
            initial[10] = 17;
            let reference;
            for(const f of functions) {
                words.set(initial);
                f(0);
                const state = Array.from(words);
                const expected = expression(bits, name, x, y);
                assert.equal(words[0], Number(expected & 0xFFFFFFFFn), `${bits}/${name}/${x}: low result`);
                assert.equal(words[1], Number(expected >> 32n), `${bits}/${name}/${x}: high result`);
                assert.equal(words[9], 0x9001, "exit EIP");
                assert.equal(words[10], 1, "standalone ABI reports one completed instruction");
                assert.deepEqual(state.slice(12), Array.from(initial.slice(12)), "state boundary canaries");
                if(reference) assert.deepEqual(state, reference, `${bits}/${name}/${x}: complete StateMap`);
                else reference = state;
                executions++;
            }
        }
    }
    console.log(`PASS: ${manifest.length * 2} emitted scalar modules and ${executions} optimized/unoptimized executions`);
}

if(!process.argv.includes("--oracle-only")) {
    const memory = new WebAssembly.Memory({initial: 64});
    const words = new Uint32Array(memory.buffer, 0, 16);
    let executions = 0;
    for(const budget of [1, 2, 3, 100]) {
        const functions = [false, true].map(opt => new WebAssembly.Instance(
            new WebAssembly.Module(fs.readFileSync(`build/ir-scalar/cfg-${budget}-${opt}.wasm`)),
            {e: {m: memory}},
        ).exports.f);
        for(const eax of [0, 1, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF]) {
            for(const flags of [2, 0x8D7]) {
                const input = new Uint32Array(16).fill(0xCDCDCDCD);
                input[0] = eax;
                input[3] = 123;
                input[8] = flags;
                let reference;
                for(const f of functions) {
                    words.set(input);
                    f(0);
                    const state = Array.from(words);
                    if(reference) assert.deepEqual(state, reference, `CFG/budget=${budget}/eax=${eax}`);
                    else reference = state;
                    if(budget === 100) {
                        assert.equal(words[0], 1, "reachable INC after zeroing EAX");
                        assert.equal(words[3], 123, "constant FLAGS exclude the dead INC EBX");
                    }
                    executions++;
                }
            }
        }
    }
    console.log(`PASS: ${executions} cross-block FLAGS/branch-pruning and budget-recovery executions`);
}
