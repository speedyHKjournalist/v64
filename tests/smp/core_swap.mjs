#!/usr/bin/env node

// Two CPU contexts on one machine, switched at main-loop boundaries with
// CPU.save_core_state/load_core_state: the mechanism C1's cooperative
// multicore is built on. Each context must end exactly as when it runs alone,
// with the JIT (default) and the interpreter (DISABLE_JIT=1).
//
// The fixture (core_swap.asm) maps the same virtual page to a different
// physical page per context; a control run that keeps the TLB across switches
// must produce a difference, so the test is known to see cross-talk.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { CORE_STATE_RANGES, STATE_OFFSETS } = await import("../../src/state_layout.js");

const KERNEL = __dirname + "/../../build/smp/core_swap.bin";
const RESULTS = 0x380000;
const PAGES = [0x400000, 0x800000];
const REG_EDI = 7;

async function machine()
{
    const emulator = new V86({
        multiboot: { url: KERNEL },
        memory_size: 32 * 1024 * 1024,
        autostart: false,
        disable_jit: +process.env.DISABLE_JIT,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    return emulator;
}

/** The entry state twice, with EDI = context id */
function initial_contexts(cpu)
{
    const entry = cpu.save_core_state();
    return [0, 1].map(id => {
        cpu.load_core_state(entry);
        cpu.reg32[REG_EDI] = id;
        return cpu.save_core_state();
    });
}

const u32 = (cpu, address) => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint32(address, true);
const done = (cpu, id) => u32(cpu, RESULTS + 64 * id + 36) === 0xD0D0 + id;

/** Run the contexts in `order` (lists of ids), one main-loop slice at a time */
function run(cpu, contexts, order)
{
    const slices = [0, 0];
    const sequence = [];
    for(const ids of order)
    {
        for(let guard = 0; ids.some(id => !done(cpu, id)); guard++)
        {
            assert.ok(guard < 100000, "contexts did not finish");
            for(const id of ids)
            {
                if(done(cpu, id)) continue;
                cpu.load_core_state(contexts[id]);
                cpu.main_loop();
                contexts[id] = cpu.save_core_state();
                slices[id]++;
                sequence.push(id);
            }
        }
    }
    return { slices, sequence };
}

/** Core state read directly (x87 shadow written back first), independent of save_core_state */
function core_state(cpu)
{
    cpu.wm.exports["fpu_cache_barrier"]();
    const memory = new Uint8Array(cpu.wasm_memory.buffer);
    return CORE_STATE_RANGES.map(([start, end]) => Buffer.from(memory.slice(start, end)).toString("hex")).join("");
}

function outcome_of(cpu, id, state)
{
    return {
        results: Buffer.from(cpu.mem8.slice(RESULTS + 64 * id, RESULTS + 64 * id + 64)).toString("hex"),
        page: Buffer.from(cpu.mem8.slice(PAGES[id], PAGES[id] + 4096)).toString("hex"),
        state,
    };
}

const saved_state = saved => saved.map(bytes => Buffer.from(bytes).toString("hex")).join("");

const mode = +process.env.DISABLE_JIT ? "interpreter" : "JIT";

// Cached state flags (not core state) must follow the loaded core: an AP
// starts in real mode while the BSP runs in protected mode
{
    const m = await machine();
    const c = m.v86.cpu;
    const [a] = initial_contexts(c);
    c.load_core_state(a);
    c.is_32[0] = 0;
    c.stack_size_32[0] = 0;
    c.update_state_flags();
    const b = c.save_core_state();
    const state_flags = () => new Uint8Array(c.wasm_memory.buffer)[STATE_OFFSETS.state_flags];
    c.load_core_state(a);
    const flags_a = state_flags();
    c.load_core_state(b);
    const flags_b = state_flags();
    c.update_state_flags();
    assert.notEqual(flags_a, flags_b);
    assert.equal(flags_b, state_flags(), "state flags recomputed for the loaded core");
    await m.destroy();
}

// Reference: each context alone on its own machine, without any switching
const expected = [];
for(const id of [0, 1])
{
    const m = await machine();
    const c = m.v86.cpu;
    c.reg32[REG_EDI] = id;
    for(let guard = 0; !done(c, id); guard++)
    {
        assert.ok(guard < 100000, "reference run did not finish");
        c.main_loop();
    }
    expected.push(outcome_of(c, id, core_state(c)));
    await m.destroy();
}

// Interleaved: both contexts on one machine, switching after every slice
const interleaved = await machine();
const cpu = interleaved.v86.cpu;
const contexts = initial_contexts(cpu);
const { slices, sequence } = run(cpu, contexts, [[0, 1]]);
const actual = [0, 1].map(id => outcome_of(cpu, id, saved_state(contexts[id])));
await interleaved.destroy();

const switches = sequence.slice(1).filter((id, i) => id !== sequence[i]).length;
console.log(`${mode}: ${slices[0]} + ${slices[1]} slices, ${switches} switches between the contexts`);
assert.ok(slices[0] >= 3 && slices[1] >= 3 && switches >= 4, "the contexts must actually interleave");
for(const id of [0, 1])
{
    assert.equal(actual[id].results, expected[id].results, `context ${id}: results`);
    assert.equal(actual[id].page, expected[id].page, `context ${id}: physical page`);
    assert.equal(actual[id].state, expected[id].state, `context ${id}: final per-core state`);
}

// Control: without the TLB flush on a switch, the second context's accesses to
// the shared virtual page hit the first context's translation
const control = await machine();
const control_cpu = control.v86.cpu;
const control_contexts = initial_contexts(control_cpu);
const full_clear_tlb = control_cpu.full_clear_tlb;
control_cpu.full_clear_tlb = () => {};
run(control_cpu, control_contexts, [[0, 1]]);
control_cpu.full_clear_tlb = full_clear_tlb;
const broken = [0, 1].map(id => outcome_of(control_cpu, id, saved_state(control_contexts[id])).page);
await control.destroy();
assert.notDeepEqual(broken, expected.map(e => e.page), "control run without TLB flush must show cross-talk");

console.log(`${mode}: interleaved contexts match the reference; the control run without TLB flush differs`);
