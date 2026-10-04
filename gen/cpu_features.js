#!/usr/bin/env node
// The CPUID features of docs/simd-xsave-plan.md (SSSE3 to x86-64-v3 and
// XSAVE): where each is reported, what it depends on, which CPU profiles may
// have it, and the milestone that opens it. The instruction forms of each are
// in gen/isa_forms.json (`make isa-forms`).
//
// `node gen/cpu_features.js --check` validates this table against
// gen/isa_forms.json and against the observed CPUID contract
// (tests/platform/cpu-contract.json): a feature reports its bit in exactly the
// profiles it is open in, and nowhere else.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

// Features of the current profiles that the plan builds on
export const EXISTING = ["FPU", "MMX", "FXSR", "SSE", "SSE2", "SSE3", "CMPXCHG16B", "LAHF64", "POPCNT"];

// cpuid: [leaf, subleaf, register, bit]
// requires: features that must be present too (a profile without them is rejected)
// profiles: the CPU profiles (cpu_type) the feature may be opened in
// open: the profiles it is open in now (reported by CPUID); [] while planned
// disabled: what the encodings do when the feature is not present (default #UD)
export const FEATURES = [
    // M1: x86-64-v2 (with the CX16, LAHF/SAHF, POPCNT and SSE3 of the x64 profile)
    { name: "SSSE3", cpuid: [1, 0, "ecx", 9], requires: ["SSE3"], milestone: "M1", phase: "P3" },
    { name: "SSE4.1", cpuid: [1, 0, "ecx", 19], requires: ["SSSE3"], milestone: "M1", phase: "P4b" },
    { name: "SSE4.2", cpuid: [1, 0, "ecx", 20], requires: ["SSE4.1", "POPCNT"], milestone: "M1", phase: "P4b" },
    // POPCNT is reported already; the plan audits its forms
    { name: "POPCNT", cpuid: [1, 0, "ecx", 23], requires: [], milestone: "existing", phase: "P4b", open: ["x86", "x86_64"] },

    // M2: XSAVE with x87 and SSE state; OSXSAVE (CPUID.1:ECX[27]) mirrors CR4.OSXSAVE
    { name: "XSAVE", cpuid: [1, 0, "ecx", 26], requires: ["FXSR"], min_cpuid_level: 0xD, state: ["x87", "SSE"], milestone: "M2", phase: "P2" },

    // M3: AVX, with the YMM state component. AVX includes the VEX forms of the
    // SSSE3 and SSE4 instructions (and every AVX processor has SSE4.2)
    { name: "AVX", cpuid: [1, 0, "ecx", 28], requires: ["XSAVE", "SSE4.2"], state: ["YMM"], milestone: "M3", phase: "P5-P6" },

    // M4: x86-64-v3, opened together
    { name: "AVX2", cpuid: [7, 0, "ebx", 5], requires: ["AVX"], min_cpuid_level: 7, milestone: "M4", phase: "P7-P8" },
    { name: "FMA", cpuid: [1, 0, "ecx", 12], requires: ["AVX"], milestone: "M4", phase: "P11" },
    { name: "F16C", cpuid: [1, 0, "ecx", 29], requires: ["AVX"], milestone: "M4", phase: "P11" },
    // VEX-encoded general-purpose instructions: not gated by CR4.OSXSAVE or XCR0
    { name: "BMI1", cpuid: [7, 0, "ebx", 3], requires: [], min_cpuid_level: 7, milestone: "M4", phase: "P10",
        disabled: { TZCNT: "BSF" } },
    { name: "BMI2", cpuid: [7, 0, "ebx", 8], requires: [], min_cpuid_level: 7, milestone: "M4", phase: "P10" },
    // in an extended leaf, which only the x86-64 profile has (Q7)
    { name: "LZCNT", cpuid: [0x80000001, 0, "ecx", 5], requires: [], milestone: "M4", phase: "P10",
        profiles: ["x86_64"], disabled: { LZCNT: "BSR" } },
    { name: "MOVBE", cpuid: [1, 0, "ecx", 22], requires: [], milestone: "M4", phase: "P10" },

    // M5: the XSAVE family (CPUID.(EAX=0DH,ECX=1):EAX)
    { name: "XSAVEOPT", cpuid: [0xD, 1, "eax", 0], requires: ["XSAVE"], milestone: "M5", phase: "P9" },
    { name: "XSAVEC", cpuid: [0xD, 1, "eax", 1], requires: ["XSAVE"], milestone: "M5", phase: "P9" },
    { name: "XGETBV1", cpuid: [0xD, 1, "eax", 2], requires: ["XSAVE"], milestone: "M5", phase: "P9" },
    // the last step of M5 (Q3)
    { name: "XSAVES", cpuid: [0xD, 1, "eax", 3], requires: ["XSAVEC"], milestone: "M5", phase: "P9" },
];

const PROFILES = ["x86", "x86_64"];
// contract profiles by cpu_type (tools/cpu_contract.mjs)
const CONTRACT_PROFILES = { x86: ["legacy-1", "legacy-4"], x86_64: ["x64-1", "x64-4"] };
const REGISTERS = ["eax", "ebx", "ecx", "edx"];

function validate()
{
    const names = new Set(FEATURES.map(f => f.name));
    for(const f of FEATURES)
    {
        assert.ok(!EXISTING.includes(f.name) || f.milestone === "existing", f.name + ": listed as existing");
        for(const r of f.requires) assert.ok(names.has(r) || EXISTING.includes(r), `${f.name}: unknown requirement ${r}`);
        for(const p of f.profiles || PROFILES) assert.ok(PROFILES.includes(p), `${f.name}: profile ${p}`);
        for(const p of f.open || []) assert.ok((f.profiles || PROFILES).includes(p), `${f.name}: open in ${p}, which may not have it`);
        assert.ok(REGISTERS.includes(f.cpuid[2]) && f.cpuid[3] >= 0 && f.cpuid[3] < 32, f.name + ": CPUID location");
    }
    // one bit per feature
    const at = new Map();
    for(const f of FEATURES)
    {
        const key = f.cpuid.join(":");
        assert.ok(!at.has(key), `${f.name} and ${at.get(key)} share CPUID ${key}`);
        at.set(key, f.name);
    }
    // requirements form no cycle, and a feature is open only where they are
    const by_name = new Map(FEATURES.map(f => [f.name, f]));
    const visit = (f, seen) => {
        assert.ok(!seen.includes(f.name), "requirement cycle: " + [...seen, f.name].join(" -> "));
        for(const r of f.requires)
        {
            const g = by_name.get(r);
            if(!g) continue;
            visit(g, [...seen, f.name]);
            for(const p of f.open || []) assert.ok((g.open || []).includes(p), `${f.name} is open in ${p} without ${r}`);
        }
    };
    for(const f of FEATURES) visit(f, []);
}

/** Every extension with forms in gen/isa_forms.json has a feature here */
function check_forms()
{
    const forms = JSON.parse(fs.readFileSync(path.join(ROOT, "gen/isa_forms.json"), "utf8"));
    const names = new Set(FEATURES.map(f => f.name));
    for(const isa of Object.keys(forms.counts)) assert.ok(names.has(isa), "gen/isa_forms.json: no feature for " + isa);
    return forms;
}

/** Each feature's bit is set in the contract exactly where it is open */
function check_contract()
{
    const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/platform/cpu-contract.json"), "utf8"));
    const problems = [];
    for(const f of FEATURES)
    {
        const [leaf, subleaf, register, bit] = f.cpuid;
        const key = "0x" + leaf.toString(16).padStart(8, "0") + "." + subleaf;
        for(const [cpu_type, profiles] of Object.entries(CONTRACT_PROFILES))
        {
            const expected = (f.open || []).includes(cpu_type);
            for(const profile of profiles)
            {
                const values = contract.profiles[profile].cpuid[key];
                assert.ok(values, `cpu-contract.json: ${profile} has no CPUID ${key}`);
                const set = (parseInt(values[REGISTERS.indexOf(register)], 16) >>> bit & 1) === 1;
                if(set !== expected) problems.push(`${f.name}: CPUID ${key} ${register}[${bit}] is ${+set} in ${profile}, expected ${+expected}`);
            }
        }
    }
    assert.deepEqual(problems, [], "CPUID contract and gen/cpu_features.js disagree");
}

function main()
{
    // (nothing is generated from this table yet: `--check` and a plain run
    // both validate it)
    validate();
    const forms = check_forms();
    check_contract();
    const open = FEATURES.filter(f => (f.open || []).length && f.milestone !== "existing").map(f => f.name);
    console.log(`${FEATURES.length} features, ${forms.total} forms; open: ${open.length ? open.join(" ") : "none"} (contract agrees)`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url))
{
    main();
}
