#!/usr/bin/env node
// Generate src/graphics_adapters/vmware_svga/svga_constants.js from the
// VMware SVGA headers in third_party/vmware-svga (see third_party/README.md):
// every object-like #define with a numeric value and every enumerator,
// as `export const NAME = value;`. Run after updating the headers.
//
//     node tools/gen_svga_constants.js

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const HEADERS = path.join(ROOT, "third_party/vmware-svga");
const OUTPUT = path.join(ROOT, "src/graphics_adapters/vmware_svga/svga_constants.js");

// In dependency order, so that a value can refer to an earlier header's names
const FILES = [
    "vm_basic_types.h", "svga_reg.h", "svga_escape.h", "svga_overlay.h",
    "svga3d_limits.h", "svga3d_types.h", "svga3d_devcaps.h", "svga3d_shaderdefs.h",
    "svga3d_cmd.h", "svga3d_dx.h", "VGPU10ShaderTokens.h",
];

// Function-like macros the values use
const MACROS = {
    SVGA_MAKE_ID: ver => "(" + "SVGA_MAGIC << 8 | (" + ver + "))",
    SVGA3D_MAKE_HWVERSION: (major, minor) => "(((" + major + ") << 16) | ((" + minor + ") & 0xFF))",
    CONST64U: x => x,
    KBYTES_2_BYTES: x => "((" + x + ") << 10)",
    MBYTES_2_BYTES: x => "((" + x + ") << 20)",
};

const values = new Map();
const order = [];
const skipped = [];

function strip_comments(text)
{
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

/**
 * Evaluate a C integer expression over the names known so far
 * @return {number|undefined}
 */
function evaluate(expression)
{
    let e = expression.trim();
    if(!e) return undefined;
    // function-like macros
    for(let changed = true; changed;)
    {
        changed = false;
        for(const [name, f] of Object.entries(MACROS))
        {
            const match = new RegExp("\\b" + name + "\\s*\\(").exec(e);
            if(!match) continue;
            let depth = 0, i = match.index + match[0].length - 1, start = i + 1;
            const args = [];
            for(; i < e.length; i++)
            {
                if(e[i] === "(") depth++;
                else if(e[i] === ")") { if(--depth === 0) { args.push(e.slice(start, i)); break; } }
                else if(e[i] === "," && depth === 1) { args.push(e.slice(start, i)); start = i + 1; }
            }
            e = e.slice(0, match.index) + f(...args) + e.slice(i + 1);
            changed = true;
        }
    }
    // casts and integer suffixes
    // (uint32) of a negative or complemented value is that value modulo 2^32
    const unsigned32 = /\(\s*(?:uint32|uint|unsigned(?:\s+int)?)\s*\)/.test(e);
    e = e.replace(/\(\s*(?:u?int(?:8|16|32|64)|uint|int|unsigned(?:\s+int)?|SVGA\w+|PPN\w*)\s*\)(?=\s*[\w(~-])/g, "");
    e = e.replace(/\b(0x[0-9a-fA-F]+|\d+)(?:[uU]?[lL]{0,2}|[lL]{1,2}[uU]?)\b/g, "$1");
    if(/[^\w\s()|&^~<>+\-*/%,?:]/.test(e)) return undefined;
    // names, then BigInt arithmetic: C's unsigned shifts and masks of 32 bits
    // and more, which JS's 32-bit signed operators would turn negative
    let unknown = false;
    e = e.replace(/\b[A-Za-z_]\w*\b/g, name => {
        if(values.has(name)) return "(" + values.get(name) + ")";
        unknown = true;
        return name;
    });
    if(unknown) return undefined;
    e = e.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, "$1n");
    let value;
    try
    {
        value = Function("return (" + e + ");")();
    }
    catch(error)
    {
        return undefined;
    }
    if(typeof value !== "bigint") return undefined;
    if(value < 0n && unsigned32) value = BigInt.asUintN(32, value);
    if(value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
    return Number(value);
}

function define(name, value, source)
{
    if(values.has(name))
    {
        if(values.get(name) !== value) throw new Error(name + " has two values: " + values.get(name) + ", " + value);
        return;
    }
    values.set(name, value);
    order.push([name, value, source]);
}

// Every macro name defined in an active region, numeric or not (for defined())
const defined_names = new Set();

/**
 * Drop the lines in inactive #if/#ifdef/#else regions. Nothing is
 * predefined (VMX86_SERVER etc.): the headers' defaults are the guest's view.
 * @param {string} text
 * @return {string}
 */
function preprocess(text)
{
    const out = [];
    // each entry: { active, taken }
    const stack = [];
    const active = () => stack.every(level => level.active);
    const condition = expression => {
        const e = expression.replace(/\bdefined\s*\(?\s*([A-Za-z_]\w*)\s*\)?/g,
            (_, name) => defined_names.has(name) ? "1" : "0");
        const value = evaluate(e);
        return value !== undefined && value !== 0;
    };
    for(const line of text.split("\n"))
    {
        const m = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif|define)\b\s*(.*)$/.exec(line);
        if(m)
        {
            const [, directive, rest] = m;
            if(directive === "ifdef" || directive === "ifndef")
            {
                const name = rest.trim().split(/\s/)[0];
                const value = defined_names.has(name) === (directive === "ifdef");
                stack.push({ active: value, taken: value });
                continue;
            }
            if(directive === "if")
            {
                const value = active() && condition(rest);
                stack.push({ active: value, taken: value });
                continue;
            }
            if(directive === "elif")
            {
                const top = stack[stack.length - 1];
                top.active = !top.taken && condition(rest);
                top.taken = top.taken || top.active;
                continue;
            }
            if(directive === "else")
            {
                const top = stack[stack.length - 1];
                top.active = !top.taken;
                top.taken = true;
                continue;
            }
            if(directive === "endif")
            {
                stack.pop();
                continue;
            }
            if(directive === "define" && active())
            {
                defined_names.add(rest.trim().split(/[\s(]/)[0]);
            }
        }
        if(active()) out.push(line);
    }
    return out.join("\n");
}

// Defines and enumerators in source order; a value may refer to a name that
// comes later (C expands macros lazily), so unresolved ones are retried
const pending = [];
for(const file of FILES)
{
    const text = preprocess(strip_comments(fs.readFileSync(path.join(HEADERS, file), "utf8")).replace(/\\\r?\n/g, " "));
    const items = [];

    // #define NAME value
    for(const match of text.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(?![\w(])[ \t]*(.*)$/gm))
    {
        if(match[2].trim()) items.push({ at: match.index, name: match[1], expression: match[2], file });
    }

    // enum { ... }: an enumerator without a value follows the previous one
    for(const match of text.matchAll(/\benum\b\s*\w*\s*\{([^}]*)\}/g))
    {
        // split at top-level commas only: values may call macros
        const entries = [];
        let depth = 0, start = 0;
        const body = match[1];
        for(let i = 0; i < body.length; i++)
        {
            if(body[i] === "(") depth++;
            else if(body[i] === ")") depth--;
            else if(body[i] === "," && depth === 0) { entries.push(body.slice(start, i)); start = i + 1; }
        }
        entries.push(body.slice(start));
        let previous = null;
        for(const entry of entries)
        {
            const item = entry.trim();
            if(!item) continue;
            const m = /^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(item);
            if(!m) { skipped.push(item); continue; }
            const expression = m[2] !== undefined ? m[2] : previous === null ? "0" : "(" + previous + ") + 1";
            items.push({ at: match.index, name: m[1], expression, file });
            previous = m[1];
        }
    }

    items.sort((a, b) => a.at - b.at);
    for(const item of items)
    {
        const value = evaluate(item.expression);
        if(value === undefined) pending.push(item);
        else define(item.name, value, item.file);
    }
}
for(let progress = true; progress && pending.length;)
{
    progress = false;
    for(let i = 0; i < pending.length; i++)
    {
        const value = evaluate(pending[i].expression);
        if(value === undefined) continue;
        define(pending[i].name, value, pending[i].file);
        pending.splice(i--, 1);
        progress = true;
    }
}
skipped.push(...pending.map(item => item.name));

const hex = value => value < 0 ? String(value) : value > 9 ? "0x" + value.toString(16).toUpperCase() : String(value);
let out = "// Generated by tools/gen_svga_constants.js from third_party/vmware-svga\n" +
    "// (VMware SVGA II and SVGA3D, GPL-2.0 OR MIT, used under MIT). Do not edit.\n" +
    "";
let last = "";
for(const [name, value, source] of order)
{
    if(source !== last) { out += "\n// " + source + "\n"; last = source; }
    out += "export const " + name + " = " + hex(value) + ";\n";
}
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, out);
console.log("Wrote " + order.length + " constants to " + path.relative(ROOT, OUTPUT) +
    (skipped.length ? "; not numeric or not resolvable: " + skipped.length : ""));
if(process.env.VERBOSE) console.log(skipped.join(" "));
