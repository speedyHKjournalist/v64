// TGSI as Mesa's virgl driver sends it: the text tgsi_dump() writes
// (virgl_encode_shader_state), parsed into a program tgsi_vgpu10.js
// translates. The syntax is tgsi_dump.c's: a processor line, PROPERTY
// lines, DCL lines, IMM lines, then numbered instructions.
//
//   VERT
//   PROPERTY NEXT_SHADER FRAG
//   DCL IN[0]
//   DCL OUT[1].xyz, GENERIC[0]
//   DCL CONST[1][0..3]
//   DCL TEMP[0..3], ARRAY(1)
//   DCL SVIEW[0], 2D, FLOAT
//   IMM[0] UINT32 {1065353216, 0, 0, 0}
//     0: MAD_SAT TEMP[0].xy, -|IN[0].xyxx|, CONST[0][ADDR[0].x+3], IMM[0].xxxx
//     1: TEX TEMP[1], TEMP[0], SAMP[0], 2D, IMM[1].xyz
//     2: UIF TEMP[2].xxxx :4
//     3: END

/** The processors, by their names in the text: [name, the program type of struct virgl's shader stages] */
export const PROCESSOR = { VERT: 0, FRAG: 1, GEOM: 2, TESS_CTRL: 3, TESS_EVAL: 4, COMP: 5 };

export class TGSIParseError extends Error {}

const SWIZZLE = { x: 0, y: 1, z: 2, w: 3 };

/**
 * One bracket of a register: "[3]", "[ADDR[0].x+3]", "[TEMP[1].y-2]", "[]"
 * @return {{index: number, rel: ?Object, empty: boolean}}
 */
function parse_index(text)
{
    if(text === "") return { index: 0, rel: null, empty: true };
    if(/^-?\d+$/.test(text)) return { index: +text, rel: null, empty: false };
    const m = /^([A-Z_]+)\[(\d+)\]\.([xyzw0-3])([+-]\d+)?$/.exec(text);
    if(!m) throw new TGSIParseError("index " + text);
    const comp = m[3] in SWIZZLE ? SWIZZLE[m[3]] : +m[3];
    return { index: m[4] ? +m[4] : 0, rel: { file: m[1], index: +m[2], comp }, empty: false };
}

/**
 * The bracket groups after a file name: "[1][ADDR[0].x+2](3)" -> ["1", "ADDR[0].x+2"], array 3
 * @return {{groups: !Array<string>, array: number, rest: string}}
 */
function brackets(text)
{
    const groups = [];
    let array = 0;
    let at = 0;
    while(text[at] === "[")
    {
        let depth = 0, end = at;
        for(; end < text.length; end++)
        {
            if(text[end] === "[") depth++;
            else if(text[end] === "]" && --depth === 0) break;
        }
        if(end >= text.length) throw new TGSIParseError("unclosed bracket in " + text);
        groups.push(text.slice(at + 1, end));
        at = end + 1;
        const m = /^\((\d+)\)/.exec(text.slice(at));
        if(m)
        {
            array = +m[1];
            at += m[0].length;
        }
    }
    return { groups, array, rest: text.slice(at) };
}

/**
 * A register operand without its modifiers: FILE[..][..] and the rest
 * (".xyzw"): its file, dimension and index (each an immediate or relative to
 * an address register: {file, index, comp}), its array id
 * @return {{reg: !Object, rest: string}}
 */
function parse_register(text)
{
    const m = /^([A-Z_]+)/.exec(text);
    if(!m) throw new TGSIParseError("operand " + text);
    const file = m[1];
    const { groups, array, rest } = brackets(text.slice(file.length));
    if(!groups.length) throw new TGSIParseError("operand without an index: " + text);
    const last = parse_index(groups[groups.length - 1]);
    const reg = { file, index: last.index, rel: last.rel, dim: 0, dim_rel: null, has_dim: groups.length > 1, array };
    if(groups.length > 1)
    {
        const first = parse_index(groups[0]);
        reg.dim = first.index;
        reg.dim_rel = first.rel;
    }
    return { reg, rest };
}

/** ".xyz" -> 0b0111 */
function parse_mask(text)
{
    if(!text) return 0xF;
    if(!/^\.[xyzw]+$/.test(text)) throw new TGSIParseError("write mask " + text);
    let mask = 0;
    for(const c of text.slice(1)) mask |= 1 << SWIZZLE[c];
    return mask;
}

/** ".xyzx" -> [0, 1, 2, 0]; ".x" -> [0, 0, 0, 0] */
function parse_swizzle(text)
{
    if(!text) return [0, 1, 2, 3];
    if(!/^\.[xyzw]{1,4}$/.test(text)) throw new TGSIParseError("swizzle " + text);
    const s = Array.from(text.slice(1), c => SWIZZLE[c]);
    while(s.length < 4) s.push(s[s.length - 1]);
    return s;
}

/** A destination: "TEMP[0].xy" */
function parse_dst(text)
{
    const { reg, rest } = parse_register(text);
    return Object.assign(reg, { mask: parse_mask(rest) });
}

/** A source: "-|CONST[0][3].xyzw|" */
function parse_src(text)
{
    let neg = false, abs = false;
    if(text[0] === "-")
    {
        neg = true;
        text = text.slice(1);
    }
    if(text[0] === "|")
    {
        if(text[text.length - 1] !== "|") throw new TGSIParseError("absolute value " + text);
        abs = true;
        text = text.slice(1, -1);
    }
    const { reg, rest } = parse_register(text);
    return Object.assign(reg, { swizzle: parse_swizzle(rest), neg, abs });
}

/** Split at the commas outside of brackets and braces */
function split_operands(text)
{
    const parts = [];
    let depth = 0, start = 0;
    for(let i = 0; i < text.length; i++)
    {
        const c = text[i];
        if(c === "[" || c === "{" || c === "(") depth++;
        else if(c === "]" || c === "}" || c === ")") depth--;
        else if(c === "," && depth === 0)
        {
            parts.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = text.slice(start).trim();
    if(last) parts.push(last);
    return parts;
}

// how many destinations an opcode has (1 if not here)
const NO_DST = new Set(["END", "RET", "KILL", "KILL_IF", "IF", "UIF", "ELSE", "ENDIF", "BGNLOOP", "ENDLOOP", "BRK", "CONT",
    "BRK", "SWITCH", "CASE", "DEFAULT", "ENDSWITCH", "EMIT", "ENDPRIM", "NOP", "BARRIER", "MEMBAR", "CAL", "BGNSUB", "ENDSUB",
    "FENCE", "STORE", "DEMOTE", "BREAKC"]);
const TWO_DST = new Set(["DFRACEXP"]);

const TEXTURE_TARGETS = new Set(["BUFFER", "1D", "2D", "3D", "CUBE", "RECT", "SHADOW1D", "SHADOW2D", "SHADOWRECT", "1D_ARRAY",
    "2D_ARRAY", "SHADOW1D_ARRAY", "SHADOW2D_ARRAY", "SHADOWCUBE", "2D_MSAA", "2D_ARRAY_MSAA", "CUBE_ARRAY", "SHADOWCUBE_ARRAY",
    "UNKNOWN"]);
const MEMORY_QUALIFIERS = new Set(["COHERENT", "RESTRICT", "VOLATILE", "STREAM_CACHE_POLICY"]);

/**
 * A declaration line, without "DCL "
 * @return {!Object}
 */
function parse_declaration(text)
{
    const parts = split_operands(text);
    const head = parts.shift();
    const m = /^([A-Z_]+)((?:\[[^\]]*\])+)(\.[xyzw]+)?$/.exec(head);
    if(!m) throw new TGSIParseError("declaration " + text);
    const file = m[1];
    const groups = m[2].slice(1, -1).split("][");
    const range = groups[groups.length - 1].split("..");
    const decl = {
        file,
        first: +range[0], last: range.length > 1 ? +range[1] : +range[0],
        // CONST[1][0..3]: the buffer; IN[][0] (2D inputs): -1
        dim: groups.length > 1 ? (groups[0] === "" ? -1 : +groups[0]) : 0,
        two_d: groups.length > 1,
        mask: parse_mask(m[3] || ""),
        array: 0, local: false, invariant: false,
        semantic: null, semantic_index: 0, stream: null,
        interpolate: null, location: "CENTER",
        // SVIEW: the target and the return types; IMAGE: target, format, writable
        target: null, return_types: null, format: null, writable: false, raw: false, atomic: false, memory: null,
    };
    for(const part of parts)
    {
        let a;
        if((a = /^ARRAY\((\d+)\)$/.exec(part))) decl.array = +a[1];
        else if(part === "LOCAL") decl.local = true;
        else if(part === "INVARIANT") decl.invariant = true;
        else if(part === "WR") decl.writable = true;
        else if(part === "RAW") decl.raw = true;
        else if(part === "ATOMIC") decl.atomic = true;
        else if(/^(GLOBAL|SHARED|PRIVATE|INPUT)$/.test(part) && file === "MEMORY") decl.memory = part;
        else if((a = /^STREAM\((.*)\)$/.exec(part))) decl.stream = a[1].split(",").map(s => +s.trim());
        else if(/^(CONSTANT|LINEAR|PERSPECTIVE|COLOR)$/.test(part) && decl.semantic !== null && file === "IN") decl.interpolate = part;
        else if(/^(CENTER|CENTROID|SAMPLE)$/.test(part) && file === "IN") decl.location = part;
        else if((file === "SVIEW" || file === "IMAGE") && decl.target === null && TEXTURE_TARGETS.has(part)) decl.target = part;
        else if(file === "SVIEW" && /^(UNORM|SNORM|SINT|UINT|FLOAT)$/.test(part)) (decl.return_types = decl.return_types || []).push(part);
        else if(file === "IMAGE" && part.startsWith("PIPE_FORMAT_")) decl.format = part;
        else if((a = /^([A-Z_0-9]+)(?:\[(\d+)\])?$/.exec(part)) && decl.semantic === null)
        {
            decl.semantic = a[1];
            decl.semantic_index = a[2] ? +a[2] : 0;
        }
        else if(/^(CONSTANT|LINEAR|PERSPECTIVE|COLOR)$/.test(part)) decl.interpolate = part;
        else throw new TGSIParseError("declaration part " + part + " in " + text);
    }
    if(decl.return_types)
    {
        while(decl.return_types.length < 4) decl.return_types.push(decl.return_types[decl.return_types.length - 1]);
    }
    return decl;
}

/** An immediate line, without "IMM[n] " */
function parse_immediate(text)
{
    const m = /^(UINT32|INT32|FLT32|FLT64|UINT64|INT64)\s*\{(.*)\}$/.exec(text.trim());
    if(!m) throw new TGSIParseError("immediate " + text);
    const type = m[1];
    const values = new Uint32Array(4);
    const f = new Float32Array(1), u = new Uint32Array(f.buffer);
    m[2].split(",").map(s => s.trim()).filter(s => s.length).forEach((s, i) => {
        if(i >= 4) return;
        if(type === "FLT32")
        {
            if(/^0x/i.test(s)) values[i] = parseInt(s, 16) >>> 0;
            else
            {
                f[0] = parseFloat(s);
                values[i] = u[0];
            }
        }
        else if(/^0x/i.test(s)) values[i] = parseInt(s, 16) >>> 0;
        else values[i] = (+s) >>> 0;
    });
    return { type, values };
}

/**
 * An instruction line, without its number
 * @return {!Object}
 */
function parse_instruction(text)
{
    let label = -1;
    const lm = /\s:(\d+)$/.exec(text);
    if(lm)
    {
        label = +lm[1];
        text = text.slice(0, lm.index);
    }
    const sp = text.search(/\s/);
    let name = sp < 0 ? text : text.slice(0, sp);
    const rest = sp < 0 ? "" : text.slice(sp + 1);
    let saturate = false, precise = false;
    if(name.endsWith("_PRECISE"))
    {
        precise = true;
        name = name.slice(0, -8);
    }
    if(name.endsWith("_SAT"))
    {
        saturate = true;
        name = name.slice(0, -4);
    }
    const parts = split_operands(rest);
    const ins = { op: name, saturate, precise, label, dst: [], src: [], target: null, offsets: [], memory: [], format: null };
    // the texture target, offsets, memory qualifiers come after the registers
    const registers = [];
    for(const part of parts)
    {
        if(TEXTURE_TARGETS.has(part) && registers.length) ins.target = part;
        else if(MEMORY_QUALIFIERS.has(part)) ins.memory.push(part);
        else if(part.startsWith("PIPE_FORMAT_")) ins.format = part;
        else if(ins.target !== null) ins.offsets.push(parse_src(part));
        else registers.push(part);
    }
    const dsts = NO_DST.has(name) ? 0 : TWO_DST.has(name) ? 2 : 1;
    // stores write their first operand (a buffer, an image, memory)
    if(name === "STORE")
    {
        ins.dst.push(parse_dst(registers[0]));
        for(const r of registers.slice(1)) ins.src.push(parse_src(r));
        return ins;
    }
    for(let i = 0; i < registers.length; i++)
    {
        if(i < dsts) ins.dst.push(parse_dst(registers[i]));
        else ins.src.push(parse_src(registers[i]));
    }
    return ins;
}

/**
 * The text of one shader
 * @param {string} text
 * @return {{processor: number, properties: !Object<string, !Array<string>>, decls: !Array<!Object>,
 *     imms: !Array<{type: string, values: !Uint32Array}>, code: !Array<!Object>}}
 */
export function parse_tgsi(text)
{
    const lines = text.split("\n");
    const program = { processor: -1, properties: {}, decls: [], imms: [], code: [] };
    for(let raw of lines)
    {
        const line = raw.trim();
        if(!line) continue;
        if(program.processor < 0)
        {
            if(!(line in PROCESSOR)) throw new TGSIParseError("processor " + line);
            program.processor = PROCESSOR[line];
            continue;
        }
        let m;
        if(line.startsWith("PROPERTY "))
        {
            const [name, ...values] = line.slice(9).trim().split(/\s+/);
            program.properties[name] = values;
        }
        else if(line.startsWith("DCL "))
        {
            program.decls.push(parse_declaration(line.slice(4).trim()));
        }
        else if((m = /^IMM\[(\d+)\]\s+(.*)$/.exec(line)))
        {
            program.imms[+m[1]] = parse_immediate(m[2]);
        }
        else if((m = /^(\d+):\s*(.*)$/.exec(line)))
        {
            program.code.push(parse_instruction(m[2].trim()));
        }
        else
        {
            throw new TGSIParseError("line " + line);
        }
    }
    if(program.processor < 0) throw new TGSIParseError("no processor");
    return program;
}
