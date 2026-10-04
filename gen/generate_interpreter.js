#!/usr/bin/env node


import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import x86_table, { opcode_map, opcode_prefix, opcode_family } from "./x86_table.js";
import * as rust_ast from "./rust_ast.js";
import { hex, get_switch_value, get_switch_exist, finalize_table_rust } from "./util.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "src/rust/gen/");

fs.mkdirSync(OUT_DIR, { recursive: true });

const table_arg = get_switch_value("--table");
const gen_all = get_switch_exist("--all");
const to_generate = {
    interpreter: gen_all || table_arg === "interpreter",
    interpreter0f: gen_all || table_arg === "interpreter0f",
    interpreter0f38: gen_all || table_arg === "interpreter0f38",
    interpreter0f3a: gen_all || table_arg === "interpreter0f3a",
};

assert(
    Object.keys(to_generate).some(k => to_generate[k]),
    "Pass --table [interpreter|interpreter0f|interpreter0f38|interpreter0f3a] or --all to pick which tables to generate"
);

gen_table();

function wrap_imm_call(imm)
{
    return `match ${imm} { Ok(o) => o, Err(()) => return }`;
}

function gen_read_imm_call(op, size_variant)
{
    let size = (op.os || op.opcode % 2 === 1) ? size_variant : 8;

    if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8)
        {
            return wrap_imm_call("read_imm8()");
        }
        else if(op.imm8s)
        {
            return wrap_imm_call("read_imm8s()");
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                return wrap_imm_call("read_moffs()");
            }
            else
            {
                assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    return wrap_imm_call("read_imm16()");
                }
                else
                {
                    assert(op.imm1632 && size === 32 || op.imm32);
                    return wrap_imm_call("read_imm32s()");
                }
            }
        }
    }
    else
    {
        return undefined;
    }
}

function gen_call(name, args)
{
    args = args || [];
    return `${name}(${args.join(", ")});`;
}

/*
 * Current naming scheme:
 * instr(16|32|)_(66|F2|F3)?(0F|0F38|0F3A)?[0-9a-f]{2}(_[0-7])?(_mem|_reg|)
 */
function make_instruction_name(encoding, size)
{
    const map = opcode_map(encoding.opcode);
    if(map === "0F38" || map === "0F3A")
    {
        const prefix = opcode_prefix(encoding.opcode);
        const fixed_g = encoding.fixed_g === undefined ? "" : `_${encoding.fixed_g}`;
        return `instructions_${map.toLowerCase()}::instr${encoding.os ? String(size) : ""}_${prefix ? hex(prefix, 2) : ""}${map}${hex(encoding.opcode & 0xFF, 2)}${fixed_g}`;
    }
    const suffix = encoding.os ? String(size) : "";
    const opcode_hex = hex(encoding.opcode & 0xFF, 2);
    const first_prefix = (encoding.opcode & 0xFF00) === 0 ? "" : hex(encoding.opcode >> 8 & 0xFF, 2);
    const second_prefix = (encoding.opcode & 0xFF0000) === 0 ? "" : hex(encoding.opcode >> 16 & 0xFF, 2);
    const fixed_g_suffix = encoding.fixed_g === undefined ? "" : `_${encoding.fixed_g}`;
    const module = first_prefix === "0F" || second_prefix === "0F" ? "instructions_0f" : "instructions";

    assert(first_prefix === "" || first_prefix === "0F" || first_prefix === "F2" || first_prefix === "F3");
    assert(second_prefix === "" || second_prefix === "66" || second_prefix === "F2" || second_prefix === "F3");

    return `${module}::instr${suffix}_${second_prefix}${first_prefix}${opcode_hex}${fixed_g_suffix}`;
}

function gen_instruction_body(encodings, size)
{
    const encoding = encodings[0];

    let has_66 = [];
    let has_f2 = [];
    let has_f3 = [];
    let no_prefix = [];

    for(let e of encodings)
    {
        const prefix = opcode_prefix(e.opcode);
        if(prefix === 0x66) has_66.push(e);
        else if(prefix === 0xF2) has_f2.push(e);
        else if(prefix === 0xF3) has_f3.push(e);
        else no_prefix.push(e);
    }

    if(has_66.length)
    {
        assert(opcode_map(encoding.opcode) !== "");
    }

    const code = [];

    if(encoding.e)
    {
        code.push(`let modrm_byte = ${wrap_imm_call("read_imm8()")};`);
    }

    // Prefixes and the escapes only collect decode state. Validate once the
    // actual opcode and (where present) ModRM are known, before EA/operand I/O.
    const base_opcode = opcode_family(encoding.opcode);
    if(!encoding.escape && ![0x0F, 0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3].includes(base_opcode))
    {
        code.push({
            type: "if-else",
            if_blocks: [{
                condition: `*prefixes & prefix::PREFIX_LOCK != 0 && !crate::decode_rules::lock_allowed(0x${base_opcode.toString(16)}, ${encoding.e ? "Some(modrm_byte as u8)" : "None"})`,
                body: ["trigger_ud();", "return;"],
            }],
        });
    }

    // The prefixes that select instructions here (all three in the SSE maps,
    // F2/F3 at MOVBE/CRC32): one without a row of its own is #UD
    // (decode_rules::mandatory_variant)
    const refining_all = encodings.some(e => e.sse || e.refining === 1);
    const refining_rep = encodings.some(e => e.refining === "rep");
    const refining = refining_all ? "crate::decode_rules::REFINING_ALL" : refining_rep ? "crate::decode_rules::REFINING_REP" : "0";

    if(has_66.length || has_f2.length || has_f3.length || refining_all || refining_rep)
    {
        const cases = [];
        const variant = "crate::decode_rules::Variant::";

        if(has_66.length) {
            cases.push({ conditions: [variant + "Prefixed(prefix::PREFIX_66)"], body: gen_instruction_body_after_prefix(has_66, size) });
        }
        if(has_f2.length) {
            cases.push({ conditions: [variant + "Prefixed(prefix::PREFIX_F2)"], body: gen_instruction_body_after_prefix(has_f2, size) });
        }
        if(has_f3.length) {
            cases.push({ conditions: [variant + "Prefixed(prefix::PREFIX_F3)"], body: gen_instruction_body_after_prefix(has_f3, size) });
        }
        cases.push({
            conditions: [variant + "Plain"],
            body: no_prefix.length ? gen_instruction_body_after_prefix(no_prefix, size) : ["trigger_ud();"],
        });

        // a row whose CPUID feature is absent is not available
        const terms = [[has_66, "prefix::PREFIX_66"], [has_f2, "prefix::PREFIX_F2"], [has_f3, "prefix::PREFIX_F3"]]
            .filter(([rows]) => rows.length)
            .map(([rows, mask]) => rows.every(e => e.feature) && new Set(rows.map(e => e.feature)).size === 1 ?
                `if ${feature_test(rows[0].feature)} { ${mask} } else { 0 }` : mask);
        const available = terms.length > 1 ? terms.map(t => t.startsWith("if ") ? `(${t})` : t).join(" | ") : terms[0] || "0";

        return [].concat(
            "let prefixes_ = *prefixes;",
            code,
            {
                type: "switch",
                condition: `crate::decode_rules::mandatory_variant(prefixes_, ${available}, ${refining})`,
                cases,
                default_case: { body: ["trigger_ud();"] },
            }
        );
    }
    else {
        return [].concat(
            code,
            gen_instruction_body_after_prefix(encodings, size)
        );
    }
}

function gen_instruction_body_after_prefix(encodings, size)
{
    const encoding = encodings[0];

    if(encoding.fixed_g !== undefined)
    {
        assert(encoding.e);

        // instruction with modrm byte where the middle 3 bits encode the instruction

        // group by opcode without prefix plus middle bits of modrm byte
        let cases = encodings.reduce((cases_by_opcode, case_) => {
            assert(typeof case_.fixed_g === "number");
            cases_by_opcode[case_.opcode & 0xFFFF | case_.fixed_g << 16] = case_;
            return cases_by_opcode;
        }, Object.create(null));
        cases = Object.values(cases).sort((e1, e2) => e1.fixed_g - e2.fixed_g);

        return [
            {
                type: "switch",
                condition: "modrm_byte >> 3 & 7",
                cases: cases.map(case_ => {
                    const fixed_g = case_.fixed_g;
                    const body = gen_instruction_body_after_fixed_g(case_, size);

                    return {
                        conditions: [fixed_g],
                        body,
                    };
                }),

                default_case: {
                    varname: "x",
                    body: [
                        `dbg_log!("#ud ${encoding.opcode.toString(16).toUpperCase()}/{} at {:x}", x, *instruction_pointer);`,
                        "trigger_ud();",
                    ],
                }
            },
        ];
    }
    else {
        assert(encodings.length === 1);
        return gen_instruction_body_after_fixed_g(encodings[0], size);
    }
}

/** The test whether the machine has a feature of gen/cpu_features.js */
function feature_test(feature)
{
    return `crate::cpu::features::has(crate::cpu::features::${feature.replace(".", "_")})`;
}

function gen_instruction_body_after_fixed_g(encoding, size)
{
    const instruction_prefix = [];

    // without its feature the row does not exist, and its semantics may come
    // later (docs/simd-xsave-plan.md): #UD after the ModRM byte, before the
    // task-switch test, EA and immediate
    if(encoding.unimplemented)
    {
        return ["trigger_ud();"];
    }
    if(encoding.feature)
    {
        instruction_prefix.push({
            type: "if-else",
            if_blocks: [{ condition: "!" + feature_test(encoding.feature), body: ["trigger_ud();", "return;"] }],
        });
    }
    const instruction_postfix =
        (encoding.block_boundary && !encoding.no_block_boundary_in_interpreted) ||
        (!encoding.custom && encoding.e) ?
        ["after_block_boundary();"] : [];

    if(encoding.task_switch_test || encoding.sse)
    {
        instruction_prefix.push(
            {
                type: "if-else",
                if_blocks: [
                    {
                        condition: encoding.sse ? "!task_switch_test_mmx()" : "!task_switch_test()",
                        body: ["return;"],
                    }
                ],
            });
    }

    const imm_read = gen_read_imm_call(encoding, size);
    const instruction_name = make_instruction_name(encoding, size);

    if(encoding.e)
    {
        // instruction with modrm byte

        const imm_read = gen_read_imm_call(encoding, size);

        if(encoding.ignore_mod)
        {
            assert(!imm_read, "Unexpected instruction (ignore mod with immediate value)");

            // Has modrm byte, but the 2 mod bits are ignored and both
            // operands are always registers (0f20-0f24)

            return [].concat(
                instruction_prefix,
                gen_call(instruction_name, ["modrm_byte & 7", "modrm_byte >> 3 & 7"]),
                instruction_postfix
            );
        }
        else
        {
            let mem_args;

            if(encoding.custom_modrm_resolve)
            {
                // requires special handling around modrm_resolve
                mem_args = ["modrm_byte"];
            }
            else
            {
                mem_args = ["match modrm_resolve(modrm_byte) { Ok(a) => a, Err(()) => return }"];
            }

            const reg_args = ["modrm_byte & 7"];

            if(encoding.fixed_g === undefined)
            {
                mem_args.push("modrm_byte >> 3 & 7");
                reg_args.push("modrm_byte >> 3 & 7");
            }

            if(imm_read)
            {
                mem_args.push(imm_read);
                reg_args.push(imm_read);
            }

            return [].concat(
                instruction_prefix,
                {
                    type: "if-else",
                    if_blocks: [
                        {
                            condition: "modrm_byte < 0xC0",
                            body: [].concat(
                                gen_call(`${instruction_name}_mem`, mem_args)
                            ),
                        }
                    ],
                    else_block: {
                        body: [gen_call(`${instruction_name}_reg`, reg_args)],
                    },
                },
                instruction_postfix
            );
        }
    }
    else
    {
        const args = [];

        if(imm_read)
        {
            args.push(imm_read);
        }

        if(encoding.extra_imm16)
        {
            assert(imm_read);
            args.push(wrap_imm_call("read_imm16()"));
        }
        else if(encoding.extra_imm8)
        {
            assert(imm_read);
            args.push(wrap_imm_call("read_imm8()"));
        }

        return [].concat(
            instruction_prefix,
            gen_call(instruction_name, args),
            instruction_postfix
        );
    }
}

function gen_table()
{
    let by_opcode = Object.create(null);
    let by_opcode0f = Object.create(null);
    const by_map = { "0F38": Object.create(null), "0F3A": Object.create(null) };

    // (VEX rows: src/rust/cpu/vex.rs decodes the VEX prefix and selects them)
    for(let o of x86_table.filter(o => !o.vex))
    {
        const map = opcode_map(o.opcode);
        const table = map === "0F" ? by_opcode0f : map === "" ? by_opcode : by_map[map];
        const opcode = o.opcode & 0xFF;
        table[opcode] = table[opcode] || [];
        table[opcode].push(o);
    }

    let cases = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode[opcode];
        assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);
        let opcode_high_hex = hex(opcode | 0x100, 2);

        if(encoding[0].os)
        {
            cases.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases.push({
                conditions: [`0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            cases.push({
                conditions: [`0x${opcode_hex}`, `0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, undefined),
            });
        }
    }
    const table = {
        type: "switch",
        condition: "opcode",
        cases,
        default_case: {
            body: ["assert!(false);"]
        },
    };
    if(to_generate.interpreter)
    {
        const code = [
            "#![cfg_attr(rustfmt, rustfmt_skip)]",

            "use crate::cpu::cpu::{after_block_boundary, modrm_resolve};",
            "use crate::cpu::cpu::{read_imm8, read_imm8s, read_imm16, read_imm32s, read_moffs};",
            "use crate::cpu::cpu::{task_switch_test, trigger_ud};",
            "use crate::cpu::instructions;",
            "use crate::cpu::global_pointers::{instruction_pointer, prefixes};",
            "use crate::prefix;",

            "pub unsafe fn run(opcode: u32) {",
            table,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "interpreter.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }

    const cases0f = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode0f[opcode];

        assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);
        let opcode_high_hex = hex(opcode | 0x100, 2);

        if(encoding[0].os)
        {
            cases0f.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases0f.push({
                conditions: [`0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            let block = {
                conditions: [`0x${opcode_hex}`, `0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, undefined),
            };
            cases0f.push(block);
        }
    }

    const table0f = {
        type: "switch",
        condition: "opcode",
        cases: cases0f,
        default_case: {
            body: ["assert!(false);"]
        },
    };

    if(to_generate.interpreter0f)
    {
        const code = [
            "#![cfg_attr(rustfmt, rustfmt_skip)]",

            "use crate::cpu::cpu::{after_block_boundary, modrm_resolve};",
            "use crate::cpu::cpu::{read_imm8, read_imm16, read_imm32s};",
            "use crate::cpu::cpu::{task_switch_test, task_switch_test_mmx, trigger_ud};",
            "use crate::cpu::instructions_0f;",
            "use crate::cpu::global_pointers::{instruction_pointer, prefixes};",
            "use crate::prefix;",

            "pub unsafe fn run(opcode: u32) {",
            table0f,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "interpreter0f.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }

    // The three-byte maps: an opcode byte without a row is #UD
    for(const map of ["0F38", "0F3A"])
    {
        const name = "interpreter" + map.toLowerCase();
        if(!to_generate[name]) continue;
        const cases = [];
        for(let opcode = 0; opcode < 0x100; opcode++)
        {
            const encoding = by_map[map][opcode];
            if(!encoding) continue;
            if(encoding[0].os)
            {
                cases.push({ conditions: [`0x${hex(opcode, 2)}`], body: gen_instruction_body(encoding, 16) });
                cases.push({ conditions: [`0x${hex(opcode | 0x100, 2)}`], body: gen_instruction_body(encoding, 32) });
            }
            else
            {
                cases.push({ conditions: [`0x${hex(opcode, 2)}`, `0x${hex(opcode | 0x100, 2)}`], body: gen_instruction_body(encoding, undefined) });
            }
        }
        const code = [
            "#![cfg_attr(rustfmt, rustfmt_skip)]",
            "#![allow(unused_imports)]",

            "use crate::cpu::cpu::{after_block_boundary, modrm_resolve};",
            "use crate::cpu::cpu::{read_imm8, read_imm16, read_imm32s};",
            "use crate::cpu::cpu::{task_switch_test, task_switch_test_mmx, trigger_ud};",
            "use crate::cpu::global_pointers::{instruction_pointer, prefixes};",
            "use crate::prefix;",

            `/// The opcode map ${map.slice(0, 2)} ${map.slice(2)}: opcode is the third opcode byte, with 0x100 for a 32-bit operand size`,
            "pub unsafe fn run(opcode: u32) {",
            { type: "switch", condition: "opcode", cases, default_case: { body: ["trigger_ud();"] } },
            "}",
        ];
        finalize_table_rust(
            OUT_DIR,
            name + ".rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }
}
