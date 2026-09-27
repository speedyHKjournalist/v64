import assert from "node:assert/strict";
import fs from "node:fs";
const scenarios = [[0, -1], [1, 0], [1, 2], [2, 2], [3, 2], [4, 2]];
function reference(n, budget, outcome, at) {
    let remaining = budget - 1, block = "header", completed = 0;
    for(;;) {
        if(remaining-- === 0) return {kind: "budget", completed};
        if(block === "header") block = completed === n ? "exit" : "body";
        else if(block === "exit") return {kind: "normal", completed};
        else {
            if(outcome && completed === at) return {kind: outcome === 1 ? "fault" : "owned", completed};
            completed++; block = "header";
        }
    }
}
let executions = 0, observations = 0, reentries = 0;
for(const opt of [0, 1]) for(const budget of [1, 2, 3, 4, 5, 9, 16, 100]) {
    const bytes = fs.readFileSync(`build/ir-dynamic-count/${opt}-${budget}.wasm`);
    assert(WebAssembly.validate(bytes));
    const m = new WebAssembly.Memory({initial: 64}), w = new Uint32Array(m.buffer);
    let start_x, start_n, start_count, cs, delta, outcome, at, completed, calls, deliveries;
    const count = () => (start_count + completed * (1 + delta)) >>> 0;
    const before = (decoded) => {
        assert.equal(w[16], (start_x + completed) >>> 0, "snapshot accumulator");
        assert.equal(w[17], (start_n - completed) >>> 0, "snapshot remaining work");
        assert.equal(w[166], count(), "only completed iterations counted, callback counter changes retained");
        assert.equal(w[140], (cs + 0x8000) >>> 0, "fault PC");
        assert.equal(w[139], (cs + (decoded ? 0x8001 : 0x8000)) >>> 0, "observer/recovery PC");
        assert.equal(w[30], 0x8D7);
    };
    const get_eflags = () => 0x8D7;
    const f = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {
        m, ir_enter: () => {}, ir_tlb_base: () => 0, get_eflags,
        ir_read_cf: () => get_eflags() & 1,
        ir_read_pf: () => get_eflags() & 4,
        ir_read_af: () => get_eflags() & 16,
        ir_read_zf: () => get_eflags() & 64,
        ir_read_sf: () => get_eflags() & 128,
        ir_read_of: () => get_eflags() & 2048,
        audit_count: x => {
            before(true); observations++; calls++;
            assert.equal(x >>> 0, (start_x + completed) >>> 0);
            if(outcome && completed === at) {
                w[16] = 0xABCDEF01; w[139] = 0xDEADBEEF; w[30] = 0x202;
                if(outcome !== 1) w[166] = (count() + 777) >>> 0;
                return [outcome, 0xBAD];
            }
            w[166] = (w[166] + delta) >>> 0;
            completed++;
            return [0, x + 1];
        },
        deliver_fault: () => {
            before(false); deliveries++;
            w[139] = 0xFA170001; w[30] = 0x202;
        },
        after_count: () => {
            before(true); observations++;
            return 0;
        },
    }}).exports.f;
    function execute(x, n, initial_count, base, adjustment, result, stop) {
        start_x = x; start_n = n; start_count = initial_count; cs = base;
        delta = adjustment; outcome = result; at = stop; completed = calls = deliveries = 0;
        const input = [x, n, 2, 3, 4, 5, 6, 7];
        w.set(input, 16); w[166] = initial_count; w[185] = base;
        w[30] = 0x8D7; w[25] = 0; w[26] = 0x76543210;
        f(0);
        const expected = reference(n, budget, result, stop);
        assert.equal(completed, expected.completed);
        assert.equal(calls, completed + Number(expected.kind === "fault" || expected.kind === "owned"));
        assert.equal(deliveries, Number(expected.kind === "fault"));
        assert.equal(w[166], (count() + (expected.kind === "owned" ? 777 : 0)) >>> 0);
        assert.equal(w[16], expected.kind === "owned" ? 0xABCDEF01 : (x + completed) >>> 0);
        assert.equal(w[17], (n - completed) >>> 0);
        assert.deepEqual(Array.from(w.slice(18, 24)), input.slice(2));
        assert.equal(w[139], expected.kind === "owned" ? 0xDEADBEEF : expected.kind === "fault" ? 0xFA170001 :
            (base + (expected.kind === "normal" ? 0x8001 : 0x8000)) >>> 0);
        assert.equal(w[30], expected.kind === "fault" || expected.kind === "owned" ? 0x202 : 0x8D7);
        assert.equal(w[26], 0x76543210);
        executions++;
        return expected;
    }
    for(const n of [0, 1, 2, 7, 0xFFFFFFFF]) for(const x of [0, 0xFFFFFFF0]) {
        for(const initial_count_local of [0, 0xFFFFFFFC]) for(const base of [0, 0xFFFFFF00]) {
            for(const adjustment of [0, 11]) for(const [result, stop] of scenarios) execute(x, n, initial_count_local, base, adjustment, result, stop);
        }
    }
    if([3, 5, 9].includes(budget)) for(const n of [1, 7, 19]) {
        let x = 0xFFFFFFF0, left = n, total = 0xFFFFFFFC, rounds = 0;
        for(;;) {
            assert(rounds++ < 100);
            const result = execute(x, left, total, 0xFFFFF000, 11, 0, -1);
            x = w[16]; left = w[17]; total = w[166]; reentries++;
            if(result.kind === "normal") break;
        }
        assert.equal(x, (0xFFFFFFF0 + n) >>> 0);
        assert.equal(total, (0xFFFFFFFC + n * 12) >>> 0);
    }
}
console.log(`PASS: ${executions} dynamically counted CPU loop executions, ${observations} helper snapshots and ${reentries} bounded reentries`);
