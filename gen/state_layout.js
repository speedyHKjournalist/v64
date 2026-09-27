#!/usr/bin/env node
// Layout of the CPU state at fixed addresses in the Wasm memory (below Rust's
// --global-base, 4096), and who owns each piece of CPU-related state.
//
// This is the single source for
//   src/rust/cpu/global_pointers.rs  the constants between the GENERATED markers
//   src/state_layout.js              offsets and per-core ranges for JavaScript
// Regenerate with `node gen/state_layout.js`; `--check` fails if either file is
// stale, a field overlaps another, or a Rust static is missing from STATICS.
//
// Owners (docs/acpi-x86-64-multicore-plan.zh-CN.md, P2a and C1):
//   core     architectural state of one core: copied when the active core
//            changes and saved in snapshots
//   cache    derived from core state; dropped or recomputed when the active
//            core changes (see CPU.prototype.load_core_state)
//   scratch  only live inside one instruction, helper or generated-code
//            activation; never live at a main-loop safe point
//   machine  shared by all cores (devices, configuration, JIT caches that are
//            re-validated against the live TLB and CPU state on every use)
//   debug    diagnostics and profiling counters

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const RUST_SIZE = { u8: 1, bool: 1, u16: 2, i32: 4, u32: 4, u64: 8, reg128: 16, F80: 16, CachedStateFlags: 1, "[u64; 8]": 64 };

// size: bytes the field owns. JavaScript views some 1-byte Rust fields as
// 32-bit (e.g. protected_mode), so a slot can be larger than the Rust type.
export const STATE_FIELDS = [
    { name: "reg32", offset: 64, rust: "i32", count: 8, size: 32, owner: "core", aliases: [["reg8", "u8"], ["reg16", "u16"]] },
    { name: "last_op_size", offset: 96, rust: "i32", size: 4, owner: "core" },
    { name: "flags_changed", offset: 100, rust: "i32", size: 4, owner: "core" },
    { name: "last_op1", offset: 104, rust: "i32", size: 4, owner: "core" },
    { name: "state_flags", offset: 108, rust: "CachedStateFlags", size: 4, owner: "cache", note: "recomputed by update_state_flags" },
    { name: "last_result", offset: 112, rust: "i32", size: 4, owner: "core" },
    { name: "flags", offset: 120, rust: "i32", size: 4, owner: "core" },
    { name: "segment_access_bytes", offset: 512, rust: "u8", count: 8, size: 8, owner: "core", comment: "TODO: reorder below segment_limits" },
    { name: "apic_enabled", offset: 548, rust: "bool", size: 4, owner: "core", note: "IA32_APIC_BASE.EN" },
    { name: "acpi_enabled", offset: 552, rust: "bool", size: 4, owner: "machine" },
    { name: "instruction_pointer", offset: 556, rust: "i32", size: 4, owner: "core", note: "linear address (EIP + CS base)" },
    { name: "previous_ip", offset: 560, rust: "i32", size: 4, owner: "core" },
    { name: "idtr_size", offset: 564, rust: "i32", size: 4, owner: "core" },
    { name: "idtr_offset", offset: 568, rust: "i32", size: 4, owner: "core" },
    { name: "gdtr_size", offset: 572, rust: "i32", size: 4, owner: "core" },
    { name: "gdtr_offset", offset: 576, rust: "i32", size: 4, owner: "core" },
    { name: "cr", offset: 580, rust: "i32", count: 8, size: 32, owner: "core" },
    { name: "cpl", offset: 612, rust: "u8", size: 4, owner: "core" },
    { name: "in_hlt", offset: 616, rust: "bool", size: 4, owner: "core" },
    { name: "last_virt_eip", offset: 620, rust: "i32", size: 4, owner: "cache", note: "reset by full_clear_tlb" },
    { name: "eip_phys", offset: 624, rust: "i32", size: 4, owner: "cache", note: "valid while last_virt_eip is" },
    { name: "nmi_blocked", offset: 628, rust: "bool", size: 4, owner: "core", note: "an NMI handler runs; cleared by IRET" },
    { name: "sysenter_cs", offset: 636, rust: "i32", size: 4, owner: "core" },
    { name: "sysenter_esp", offset: 640, rust: "i32", size: 4, owner: "core" },
    { name: "sysenter_eip", offset: 644, rust: "i32", size: 4, owner: "core" },
    // Should be 0 at instruction boundaries, but the IR entry path tests it,
    // so it travels with the core
    { name: "prefixes", offset: 648, rust: "u8", size: 4, owner: "core" },
    { name: "instruction_counter", offset: 664, rust: "u32", size: 4, owner: "machine", note: "monotonic count of retired instructions, used for slice budgets" },
    { name: "sreg", offset: 668, rust: "u16", count: 8, size: 16, owner: "core" },
    { name: "dreg", offset: 684, rust: "i32", count: 8, size: 32, owner: "core" },
    { name: "svga_dirty_bitmap_min_offset", offset: 716, rust: "u32", size: 4, owner: "machine",
        comment: "filled in by svga_fill_pixel_buffer, read by javacsript for optimised putImageData calls" },
    { name: "svga_dirty_bitmap_max_offset", offset: 720, rust: "u32", size: 4, owner: "machine" },
    { name: "segment_is_null", offset: 724, rust: "bool", count: 8, size: 8, owner: "core" },
    { name: "segment_offsets", offset: 736, rust: "i32", count: 8, size: 32, owner: "core" },
    { name: "segment_limits", offset: 768, rust: "u32", count: 8, size: 32, owner: "core" },
    { name: "protected_mode", offset: 800, rust: "bool", size: 4, owner: "core" },
    { name: "is_32", offset: 804, rust: "bool", size: 4, owner: "core" },
    { name: "stack_size_32", offset: 808, rust: "bool", size: 4, owner: "core" },
    { name: "memory_size", offset: 812, rust: "u32", size: 4, owner: "machine" },
    { name: "fpu_stack_empty", offset: 816, rust: "u8", size: 1, owner: "core" },
    { name: "mxcsr", offset: 824, rust: "i32", size: 4, owner: "core" },
    { name: "reg_xmm", offset: 832, rust: "reg128", count: 8, size: 128, owner: "core" },
    { name: "current_tsc", offset: 960, rust: "u64", size: 8, owner: "cache", note: "written by store_current_tsc for snapshots" },
    { name: "reg_pdpte", offset: 968, rust: "u64", count: 4, size: 32, owner: "core", comment: "4 64-bit entries" },
    { name: "fpu_stack_ptr", offset: 1032, rust: "u8", size: 1, owner: "core" },
    { name: "fpu_control_word", offset: 1036, rust: "u16", size: 2, owner: "core" },
    { name: "fpu_status_word", offset: 1040, rust: "u16", size: 2, owner: "core" },
    { name: "fpu_opcode", offset: 1044, rust: "i32", size: 4, owner: "core" },
    { name: "fpu_ip", offset: 1048, rust: "i32", size: 4, owner: "core" },
    { name: "fpu_ip_selector", offset: 1052, rust: "i32", size: 4, owner: "core" },
    { name: "fpu_dp", offset: 1056, rust: "i32", size: 4, owner: "core" },
    { name: "fpu_dp_selector", offset: 1060, rust: "i32", size: 4, owner: "core" },
    { name: "tss_size_32", offset: 1128, rust: "bool", size: 4, owner: "core" },
    { name: "sse_scratch_register", offset: 1136, rust: "reg128", size: 16, owner: "scratch" },
    { name: "fpu_st", offset: 1152, rust: "F80", count: 8, size: 128, owner: "core" },
    { name: "x87_shadow_values", offset: 1280, rust: "[u64; 8]", size: 64, owner: "cache", note: "synced into fpu_st before a switch",
        doc: ["f64 shadow of the physical x87 registers (cpu::fpu), with VALID/DIRTY", "masks, at fixed addresses so natively generated IR fixtures stay valid."] },
    { name: "x87_shadow_valid", offset: 1344, rust: "u32", size: 4, owner: "cache" },
    { name: "x87_shadow_dirty", offset: 1348, rust: "u32", size: 4, owner: "cache" },
    { name: "x87_native_policy", offset: 1352, rust: "u8", size: 1, owner: "machine",
        doc: ["Nonzero while generated IR code may inline fast-math x87 on that cache."] },
    { name: "ir_tlb_base", offset: 2048, rust: "u32", size: 4, owner: "machine",
        doc: ["Address of cpu::tlb_data, written at startup. Generated IR code loads it", "from this fixed slot (below --global-base) instead of calling an import."] },
];

// Every static in src/rust, by file. The check fails on a static that is not
// listed here, so new state has to be classified when it is added.
export const STATICS = {
    // one local APIC per core, indexed by core; the scheduler's current core and INIT/SIPI events
    "cpu/apic.rs": { APICS: "core", CURRENT_CORE: "machine", CORE_COUNT: "machine", CORE_EVENTS: "machine", NMI_PENDING: "machine" },
    "cpu/cpu.rs": {
        INTERPRETED: "debug", INTERPRETED_OFFSETS: "debug", INTERPRETED_PAGES: "debug", INTERPRETED_WATCH: "debug",
        cpuid_level: "machine", debug_last_jump: "debug", jit_block_boundary: "scratch", core_yield: "scratch",
        jit_link_batch: "scratch", jit_link_batch_start: "scratch",
        // one TLB, flushed when the active core changes
        tlb_data: "cache", valid_tlb_entries: "cache", valid_tlb_entries_count: "cache",
        // TSC offset and monotonicity guard: shared, cores see a synchronized TSC
        tsc_last_extra: "machine", tsc_last_value: "machine", tsc_number_of_same_readings: "machine",
        tsc_offset: "machine", tsc_resolution: "machine", tsc_speed: "machine",
    },
    "cpu/fpu.rs": { X87_JIT_CACHE: "machine" },
    "cpu/ioapic.rs": { IOAPIC: "machine" },
    "cpu/memory.rs": { mem8: "machine", vga_mem8: "machine", vga_memory_size: "machine" },
    "cpu/pic.rs": { PIC: "machine" },
    "cpu/vga.rs": { dest_buffer: "machine", dirty_bitmap: "machine" },
    "ir/debug.rs": { AUDIT: "debug", RECORDS: "debug" },
    "ir/frontend/encodings.rs": { ENCODINGS: "machine", OPCODES: "machine" },
    "ir/runtime/cache.rs": {
        // compiled code and lookup caches; hits re-check the live TLB and CPU context
        CACHE: "machine", COLLECTION_PENDING: "machine", FAST: "machine", FAST_CHAINS: "machine", FAST_HITS: "debug",
        FAST_STAMP: "machine", FUSION_PROFILE: "debug", LINK_RANDOM: "machine", MERGED_VALIDATION_ENABLED: "machine",
        MISSING_ENTRIES: "machine", MISSING_HINT_ENABLED: "machine", MISSING_HINT_HITS: "debug", NEG_STAMP: "machine",
        PAGE_FAST: "machine", PAGE_OUT: "machine", PAGE_REFILL: "machine", POLL_REUSE_ENABLED: "machine",
        STRICT_VALIDATION: "machine", T0_CHAINS: "machine", T0_ENTRIES: "debug", T0_LINKABLE: "machine", T0_SLOTS: "machine",
        // the running activation and its entry state; never across a host yield
        ACTIVE: "scratch", T0_CONTROL: "scratch", T0_CS: "scratch",
    },
    "ir/runtime/diagnostics.rs": Object.fromEntries([
        "ADMISSION", "CALIBRATION", "CALLS", "CELLS", "CHAIN", "CLOCK", "COMPILER", "COMPILER_BENCHMARK", "COMPILER_BUCKETS",
        "COMPILE_CONTEXT", "CONTROL_EXITS", "CURRENT", "DEPTH", "DISCOVERY", "HELPER_EXITS", "HOT", "HOT_REPLACEMENTS",
        "INTERPRETER_HOT", "IN_BATCH", "MISSING", "PERIOD", "PUBLICATION", "RANDOM", "REASONS", "SESSION", "STACK", "TIMES",
        "TOTALS", "START",
    ].map(name => [name, "debug"])),
    "ir/runtime/entry.rs": { ADMISSION_EPOCH: "machine", CONTINUATION_EPOCH: "machine", EXIT_KIND: "scratch" },
    "ir/runtime/live.rs": { LIVE: "machine" },
    "ir/runtime/memory.rs": { RMW_VALUE: "scratch" },
    "ir/runtime/region.rs": { TIER1_INSTRUCTIONS: "debug", TIER2_INSTRUCTIONS: "debug" },
    "ir/runtime/rep.rs": { LAST_RESULT: "scratch" },
    "ir/runtime/schedule.rs": {
        DIRECT_T2: "machine", FORCED: "machine", HEAT: "machine", HEAT_STEPS: "machine", HEAT_STEPS_PER_VISIT: "machine",
        PAGE_HEAT: "machine", SCHEDULER: "machine", T0_RANGES: "machine", TIER0: "machine", RESERVED: "machine",
    },
    "ir/runtime/tier0.rs": { COMPILED: "machine", STEPS: "debug", T0_LINK: "machine", T0_TAIL_CALLS: "machine", TEMPLATES: "machine" },
    "jit.rs": { JIT_STATE: "machine" },
    "profiler.rs": Object.fromEntries([
        "PERFORMANCE_BATCH_CHUNKS", "PERFORMANCE_CODEGEN", "PERFORMANCE_COUNTDOWN", "PERFORMANCE_COUNTERS", "PERFORMANCE_EXECUTION",
        "PERFORMANCE_NEXT_SAMPLE", "PERFORMANCE_PENDING_ROW", "PERFORMANCE_PREVIOUS_CHUNKS", "PERFORMANCE_RANDOM",
        "PERFORMANCE_RECORDING", "PERFORMANCE_ROWS", "PERFORMANCE_SAMPLE_TIME", "PERFORMANCE_STARTED", "stat_array",
    ].map(name => [name, "debug"])),
    // SoftFloat's C globals: set from the x87 control word before each operation
    "softfloat.rs": {
        X87_FAST_MATH: "machine", X87_POLICY_OBSERVER: "machine",
        softfloat_roundingMode: "scratch", extF80_roundingPrecision: "scratch", softfloat_exceptionFlags: "scratch",
    },
    "x87_profiler.rs": { CACHE: "debug", COUNTS: "debug", ENABLED: "debug" },
};

const OWNERS = new Set(["core", "cache", "scratch", "machine", "debug"]);

function validate()
{
    const sorted = [...STATE_FIELDS].sort((a, b) => a.offset - b.offset);
    for(const [i, f] of sorted.entries())
    {
        assert.ok(OWNERS.has(f.owner) && f.owner !== "debug", f.name + ": owner");
        const rust_size = RUST_SIZE[f.rust] * (f.count || 1);
        assert.ok(rust_size, f.name + ": unknown Rust type " + f.rust);
        assert.ok(f.size >= rust_size, f.name + ": slot smaller than the Rust type");
        assert.ok(f.offset >= 64 && f.offset + f.size <= 4096, f.name + ": outside the fixed region");
        const next = sorted[i + 1];
        assert.ok(!next || f.offset + f.size <= next.offset, f.name + " overlaps " + (next && next.name));
    }
    for(const statics of Object.values(STATICS))
    {
        for(const [name, owner] of Object.entries(statics)) assert.ok(OWNERS.has(owner), name + ": owner");
    }
}

/** [start, end) byte ranges covering the core fields, merged across unused gaps */
export function core_ranges()
{
    const sorted = [...STATE_FIELDS].sort((a, b) => a.offset - b.offset);
    const ranges = [];
    let current = null;
    for(const f of sorted)
    {
        if(f.owner === "core")
        {
            if(current) current[1] = f.offset + f.size;
            else current = [f.offset, f.offset + f.size];
        }
        else if(current)
        {
            ranges.push(current);
            current = null;
        }
    }
    if(current) ranges.push(current);
    return ranges;
}

function rust_consts()
{
    const lines = [];
    for(const f of [...STATE_FIELDS].sort((a, b) => a.offset - b.offset))
    {
        const type = f.rust;
        for(const line of f.doc || []) lines.push("/// " + line);
        for(const [alias, alias_type] of f.aliases || [])
        {
            lines.push(`pub const ${alias}: *mut ${alias_type} = ${f.offset} as *mut ${alias_type};`);
        }
        const comment = f.comment ? " // " + f.comment : "";
        lines.push(`pub const ${f.name}: *mut ${type} = ${f.offset} as *mut ${type};${comment}`);
    }
    return lines.join("\n") + "\n";
}

const BEGIN = "// BEGIN GENERATED by gen/state_layout.js (edit the layout there)\n";
const END = "// END GENERATED\n";

function rust_file(current)
{
    const start = current.indexOf(BEGIN);
    const end = current.indexOf(END);
    assert.ok(start !== -1 && end > start, "global_pointers.rs: GENERATED markers missing");
    return current.slice(0, start + BEGIN.length) + rust_consts() + current.slice(end);
}

function js_file()
{
    const offsets = {};
    for(const f of [...STATE_FIELDS].sort((a, b) => a.offset - b.offset))
    {
        for(const [alias] of f.aliases || []) offsets[alias] = f.offset;
        offsets[f.name] = f.offset;
    }
    return `// Generated by gen/state_layout.js from the CPU state layout; do not edit.

/** Offsets of the CPU state fields in the Wasm memory */
export const STATE_OFFSETS = {
${Object.entries(offsets).map(([name, offset]) => `    ${name}: ${offset},`).join("\n")}
};

/**
 * Byte ranges [start, end) of the per-core state; copied when the active core
 * changes (CPU.prototype.save_core_state/load_core_state)
 */
export const CORE_STATE_RANGES = [
${core_ranges().map(([a, b]) => `    [${a}, ${b}],`).join("\n")}
];
`;
}

/** Statics declared in src/rust, as {file: [names]} */
function find_statics()
{
    const found = {};
    const walk = dir => {
        for(const entry of fs.readdirSync(dir, { withFileTypes: true }))
        {
            const p = path.join(dir, entry.name);
            if(entry.isDirectory()) walk(p);
            else if(p.endsWith(".rs"))
            {
                const text = fs.readFileSync(p, "utf8");
                const names = [...text.matchAll(/^\s*(?:pub(?:\([a-z]+\))?\s+)?static\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(m => m[1]);
                if(names.length) found[path.relative(path.join(ROOT, "src/rust"), p)] = names;
            }
        }
    };
    walk(path.join(ROOT, "src/rust"));
    return found;
}

function check_statics()
{
    const problems = [];
    const found = find_statics();
    for(const [file, names] of Object.entries(found))
    {
        for(const name of names)
        {
            if(!STATICS[file] || !STATICS[file][name]) problems.push(`src/rust/${file}: static ${name} has no owner in gen/state_layout.js`);
        }
    }
    for(const [file, statics] of Object.entries(STATICS))
    {
        for(const name of Object.keys(statics))
        {
            if(!found[file] || !found[file].includes(name)) problems.push(`gen/state_layout.js: ${file} ${name} no longer exists`);
        }
    }
    assert.deepEqual(problems, [], "\n" + problems.join("\n"));
}

if(process.argv[1] === url.fileURLToPath(import.meta.url))
{
    validate();
    const check = process.argv.includes("--check");
    const rust_path = path.join(ROOT, "src/rust/cpu/global_pointers.rs");
    const outputs = [[rust_path, rust_file(fs.readFileSync(rust_path, "utf8"))], [path.join(ROOT, "src/state_layout.js"), js_file()]];
    for(const [file, content] of outputs)
    {
        if(check) assert.equal(fs.existsSync(file) && fs.readFileSync(file, "utf8"), content, file + " is stale; run node gen/state_layout.js");
        else fs.writeFileSync(file, content);
    }
    check_statics();
    const core_bytes = core_ranges().reduce((n, [a, b]) => n + b - a, 0);
    console.log(`state layout: ${STATE_FIELDS.length} fields, per-core ranges ${JSON.stringify(core_ranges())} (${core_bytes} bytes), ` +
        `${Object.values(STATICS).reduce((n, s) => n + Object.keys(s).length, 0)} Rust statics classified`);
}
