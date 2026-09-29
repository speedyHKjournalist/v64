// Reference state for a nasm test from QEMU TCG instead of gdb, for hosts
// that cannot run the i386 test binaries natively (macOS, arm64): the image
// (a multiboot ELF) runs as the kernel of qemu-system-i386; at the final HLT
// the QMP monitor's "info registers" and "pmemsave" give the state that
// gdb-extract-def records at the `loop` label, and the fixture is written in
// the same format (run.js reads either). An exception is taken from the
// "-d int" log: its vector and faulting EIP, with the same "(signal ...)"
// markers gdb prints (only these are compared for such tests).
//
// The tests are written for Linux user mode; under QEMU they run at CPL 0
// without paging, which gives the same results for everything run.js
// compares (the arithmetic flags only, not IF/IOPL).
//
// Hardware sets the sign/exponent of an x87 register to 0xFFFF when an MMX
// instruction writes it; QEMU only writes the low 64 bits. The stub fills
// the eight physical registers with SENTINEL before FNINIT (which keeps
// their contents), so a register still carrying the sentinel exponent was
// written by MMX (reported with 0xFFFF) or not at all (reported as the zero
// a new Linux process has). Where QEMU itself differs from hardware (x87
// stack faults, some undefined flags and #UD cases), the fixture says
// "Reference: QEMU" and run.js applies the list in QEMU_DEVIATIONS.
//
// QEMU 10 TCG zeroes the operand of RCL/RCR with an immediate count that is
// a nonzero multiple of the operand width + 1; on hardware the masked count
// (COUNT AND 1FH) MOD 9 or 17 is then 0: operand and CF unchanged, OF
// undefined (Intel SDM, RCL/RCR/ROL/ROR). The image QEMU runs has such
// instructions replaced by NOPs of the same length (from a nasm listing of
// the test's source).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SIGNALS = { 0: "SIGFPE", 6: "SIGILL", 13: "SIGSEGV", 14: "SIGSEGV", 17: "SIGBUS" };
// (a generator that exits without reaching `finally` must not leave QEMU running)
const children = new Set();
process.on("exit", () => { for(const child of children) child.kill("SIGKILL"); });
const BSS = 0x100000, MEMORY_BYTES = 0x2000;
const SENTINEL = { mantissa: 0xC0DE5EED1234ABCDn, exponent: 0x2ACE };
const NASM_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
export const QEMU_MARKER = "Reference: QEMU (tests/nasm/qemu_oracle.js)";

function qmp(child)
{
    let buffer = "";
    const waiting = [];
    child.stdout.on("data", data => {
        buffer += data;
        for(let newline; (newline = buffer.indexOf("\n")) >= 0;)
        {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let message;
            try { message = JSON.parse(line); } catch(e) { continue; }
            if(("return" in message || "error" in message) && waiting.length) waiting.shift()(message);
        }
    });
    return (execute, args) => new Promise(resolve => {
        waiting.push(resolve);
        child.stdin.write(JSON.stringify(args ? { execute, arguments: args } : { execute }) + "\n");
    });
}

const hex = (text, name) => {
    const match = text.match(new RegExp(`\\b${name}=\\s*([0-9a-f]+)`, "i"));
    if(!match) throw new Error(`qemu oracle: no ${name} in:\n${text}`);
    return match[1];
};
const int32 = value => value | 0;

/** 80-bit extended (64-bit mantissa with explicit integer bit, 16-bit sign/exponent) as the nearest double */
function extended_to_double(mantissa, exponent_sign)
{
    const sign = exponent_sign & 0x8000 ? -1 : 1;
    const exponent = exponent_sign & 0x7FFF;
    if(exponent === 0x7FFF)
    {
        return (mantissa & 0x7FFFFFFFFFFFFFFFn) === 0n ? sign * Infinity : NaN;
    }
    if(mantissa === 0n) return sign * 0;
    // mantissa * 2^(exponent - 16383 - 63), rounded once through a 53-bit significand
    let shift = 0;
    let m = mantissa;
    while(m >= 1n << 53n) { m >>= 1n; shift++; }
    // round to nearest even on the dropped bits
    const dropped = mantissa - (m << BigInt(shift));
    const half = shift ? 1n << BigInt(shift - 1) : 0n;
    if(shift && (dropped > half || dropped === half && (m & 1n))) m++;
    return sign * Number(m) * Math.pow(2, exponent - 16383 - 63 + shift);
}

/** The tag gdb computes from an fxsave image (i387_tag): 0 valid, 1 zero,
 * 2 special; empty registers are 3. gdb-extract-def prints registers tagged
 * 2 as "invalid", and run.js reads 0xAAAA (all eight written by MMX) as
 * "compare the MMX registers" */
function tag(mantissa, exponent_sign)
{
    const exponent = exponent_sign & 0x7FFF;
    if(exponent === 0 && mantissa === 0n) return 1;                             // zero
    if(exponent === 0x7FFF || exponent === 0 || !(mantissa >> 63n)) return 2;   // special
    return 0;
}

function format_double(x)
{
    if(Number.isNaN(x)) return "nan";
    if(x === Infinity) return "inf";
    if(x === -Infinity) return "-inf";
    return x.toExponential(20).replace("e+", "e+");
}

/** Address of a section of an ELF32 image, by name */
function section_address(elf, name)
{
    const shoff = elf.readUInt32LE(32), shentsize = elf.readUInt16LE(46), shnum = elf.readUInt16LE(48);
    const strings = elf.readUInt32LE(shoff + elf.readUInt16LE(50) * shentsize + 16);
    for(let i = 0; i < shnum; i++)
    {
        const at = shoff + i * shentsize;
        const start = strings + elf.readUInt32LE(at);
        if(elf.toString("latin1", start, elf.indexOf(0, start)) === name) return elf.readUInt32LE(at + 12);
    }
    throw new Error("qemu oracle: no section " + name);
}

/**
 * The .text offsets and lengths of RCL/RCR instructions with an immediate
 * count that QEMU 10 mishandles (see above), from a nasm listing of the source
 * @param {string} source
 * @return {!Array<{offset: number, length: number}>}
 */
export function rotate_through_carry_noops(source)
{
    const text = fs.readFileSync(source, "utf8");
    if(!/^\s*rc[lr]\b.*,\s*(?!cl\b)\w+\s*$/im.test(text)) return [];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "v86-nasm-list-"));
    try
    {
        const listing = path.join(scratch, "listing");
        const result = spawnSync("nasm", ["-felf32", "-l", listing, "-o", path.join(scratch, "object"), path.resolve(source)],
            { cwd: NASM_DIRECTORY, encoding: "utf8" });
        if(result.status !== 0) throw new Error("qemu oracle: nasm " + source + "\n" + result.stderr);
        const widths = { byte: 8, word: 16, dword: 32 };
        const register_width = r => /^[abcd][lh]$/.test(r) ? 8 : /^(ax|bx|cx|dx|sp|bp|si|di)$/.test(r) ? 16 : 32;
        const found = [];
        let section = "";
        for(const line of fs.readFileSync(listing, "utf8").split("\n"))
        {
            const directive = line.match(/^\s*\d+\s+(?:<\d+>\s+)?section\s+(\.\w+)/i);
            if(directive) { section = directive[1]; continue; }
            const code = line.match(/^\s*\d+\s+(?:<\d+>\s+)?([0-9A-F]{8}) ([0-9A-F]+)\s+(.*)$/);
            if(!code || section !== ".text") continue;
            const rotate = code[3].trim().match(/^rc[lr]\s+(?:(byte|word|dword)\s+\[[^\]]*\]|([a-z]+))\s*,\s*(0x[0-9a-f]+|[0-9][0-9a-f]*h|\d+)$/i);
            if(!rotate) continue;
            const width = rotate[1] ? widths[rotate[1].toLowerCase()] : register_width(rotate[2].toLowerCase());
            const literal = rotate[3].toLowerCase();
            const count = (literal.endsWith("h") ? parseInt(literal, 16) : Number(literal)) & 31;
            if(count && count % (width + 1) === 0) found.push({ offset: parseInt(code[1], 16), length: code[2].length / 2 });
        }
        return found;
    }
    finally
    {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

/**
 * The test's ELF as a flat multiboot kernel (a header with address fields,
 * then the segments' bytes): QEMU loads that form regardless of how the
 * linker laid out the ELF.
 * @param {!Buffer} elf
 * @param {!Array<{offset: number, length: number}>=} noops .text ranges to replace by NOPs
 * @return {!Buffer}
 */
export function flat_multiboot(elf, noops = [])
{
    const entry = elf.readUInt32LE(24), phoff = elf.readUInt32LE(28);
    const phentsize = elf.readUInt16LE(42), phnum = elf.readUInt16LE(44);
    const segments = [];
    for(let i = 0; i < phnum; i++)
    {
        const at = phoff + i * phentsize;
        if(elf.readUInt32LE(at) !== 1 || !elf.readUInt32LE(at + 16)) continue; // PT_LOAD with bytes in the file
        segments.push({ offset: elf.readUInt32LE(at + 4), address: elf.readUInt32LE(at + 12), file: elf.readUInt32LE(at + 16) });
    }
    // The loader copies one contiguous range and would also clear any gap,
    // which must not reach the VGA/BIOS area at 640 KiB: segments below it
    // are loaded in place, the ones above 1 MiB (the tests' .data) are
    // staged after them and copied by the stub. (The BSS at 1 MiB is zero
    // RAM at boot.)
    const low_segments = segments.filter(s => s.address + s.file <= 0xA0000);
    const high_segments = segments.filter(s => s.address >= 0x100000);
    if(low_segments.length + high_segments.length !== segments.length) throw new Error("qemu oracle: a segment in the BIOS area");
    const low = Math.min(...low_segments.map(s => s.address));
    let staging = Math.max(...low_segments.map(s => s.address + s.file)) + 15 & ~15;
    const copies = high_segments.map(s => { const from = staging; staging += s.file + 15 & ~15; return { ...s, from }; });
    const load_end = staging;
    if(load_end > 0xA0000) throw new Error("qemu oracle: image too large for low memory");
    // the stub: the FPU/SSE state of a Linux process (CR0.MP/NE, no EM/TS;
    // CR4.OSFXSR/OSXMMEXCPT; FNINIT), the staged copies, then the entry
    const imm = v => [v & 0xFF, v >> 8 & 0xFF, v >> 16 & 0xFF, v >>> 24];
    // (FLD TBYTE of the sentinel eight times, then FNINIT), the staged
    // copies, then the entry; the sentinel's ten bytes follow the stub
    const code = sentinel_address => [0x0F, 0x20, 0xC0, 0x25, 0xF3, 0xFF, 0xFF, 0xFF, 0x83, 0xC8, 0x22, 0x0F, 0x22, 0xC0,
        0x0F, 0x20, 0xE0, 0x0D, 0x00, 0x06, 0x00, 0x00, 0x0F, 0x22, 0xE0,
        ...Array(8).fill([0xDB, 0x2D, ...imm(sentinel_address)]).flat(), 0xDB, 0xE3, 0xFC,
        ...copies.flatMap(c => [0xBE, ...imm(c.from), 0xBF, ...imm(c.address), 0xB9, ...imm(c.file), 0xF3, 0xA4]),
        0xB8, ...imm(entry), 0xFF, 0xE0];
    const sentinel = Buffer.alloc(10);
    sentinel.writeBigUInt64LE(SENTINEL.mantissa);
    sentinel.writeUInt16LE(SENTINEL.exponent, 8);
    const code_length = code(0).length;
    const HEADER = 32 + code_length + 10 + 15 & ~15, header_address = low - HEADER;
    const stub = code(header_address + 32 + code_length);
    const image = Buffer.alloc(HEADER + load_end - low);
    const flags = 0x10000;
    [0x1BADB002, flags, -(0x1BADB002 + flags) >>> 0, header_address, header_address, load_end, 0, header_address + 32]
        .forEach((value, i) => image.writeUInt32LE(value >>> 0, i * 4));
    Buffer.from(stub).copy(image, 32);
    sentinel.copy(image, 32 + code_length);
    for(const s of low_segments) elf.copy(image, HEADER + s.address - low, s.offset, s.offset + s.file);
    for(const c of copies) elf.copy(image, HEADER + c.from - low, c.offset, c.offset + c.file);
    if(noops.length)
    {
        const text = section_address(elf, ".text");
        for(const { offset, length } of noops) image.fill(0x90, HEADER + text + offset - low, HEADER + text + offset - low + length);
    }
    return image;
}

/**
 * @param {string} image path of the test's .img
 * @return {Promise<string>} fixture text
 */
export async function qemu_fixture(image)
{
    // generated tests keep their source next to the image, the others one directory up
    const name = path.basename(image, ".img") + ".asm";
    const source = [path.join(path.dirname(image), name), path.join(path.dirname(image), "..", name)].find(p => fs.existsSync(p));
    const noops = source ? rotate_through_carry_noops(source) : [];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "v86-nasm-"));
    const log = path.join(scratch, "int.log"), dump = path.join(scratch, "memory.bin");
    const kernel = path.join(scratch, "kernel.bin");
    fs.writeFileSync(kernel, flat_multiboot(fs.readFileSync(image), noops));
    const child = spawn(process.env.QEMU_I386 || "qemu-system-i386", ["-machine", "pc,accel=tcg", "-cpu", "max", "-m", "32",
        "-display", "none", "-serial", "none", "-monitor", "none", "-qmp", "stdio", "-no-reboot", "-no-shutdown",
        "-d", "int", "-D", log, "-kernel", kernel], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let stderr = "", exited = false;
    child.stderr.on("data", data => { stderr += data; });
    child.on("exit", () => { exited = true; });
    const command = qmp(child);
    try
    {
        await command("qmp_capabilities");
        const deadline = Date.now() + 20000;
        let registers;
        for(;;)
        {
            if(Date.now() > deadline || exited) throw new Error("qemu oracle: " + image + (exited ? " exited" : " did not halt") + "\n" + stderr);
            const status = (await command("query-status")).return?.status;
            registers = (await command("human-monitor-command", { "command-line": "info registers" })).return || "";
            if(status === "shutdown" || /\bHLT=1\b/.test(registers)) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const exception = first_exception(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
        await command("pmemsave", { val: BSS, size: MEMORY_BYTES, filename: dump });
        const memory = fs.existsSync(dump) ? fs.readFileSync(dump) : Buffer.alloc(MEMORY_BYTES);
        // registers stored by FSAVE/FXSAVE that were never written: zero, as in a new process
        const sentinel = Buffer.alloc(10);
        sentinel.writeBigUInt64LE(SENTINEL.mantissa);
        sentinel.writeUInt16LE(SENTINEL.exponent, 8);
        for(let at; (at = memory.indexOf(sentinel)) >= 0;) memory.fill(0, at, at + 10);
        return fixture(registers, memory, exception);
    }
    finally
    {
        child.kill("SIGKILL");
        children.delete(child);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

/** The first CPU exception in QEMU's interrupt log: { vector, eip } */
function first_exception(text)
{
    for(const line of text.split("\n"))
    {
        const match = line.match(/^\s*\d+: v=([0-9a-f]+) .*?pc=([0-9a-f]+)/i);
        if(match && parseInt(match[1], 16) < 32) return { vector: parseInt(match[1], 16), eip: parseInt(match[2], 16) };
    }
    return null;
}

function fixture(registers, memory, exception)
{
    const values = [];
    for(const name of ["EAX", "ECX", "EDX", "EBX", "ESP", "EBP", "ESI", "EDI"]) values.push(int32(parseInt(hex(registers, name), 16)));
    // gdb stops at `loop`, before the HLT QEMU has executed; after an
    // exception, at the faulting instruction
    const eip = exception ? exception.eip : parseInt(hex(registers, "EIP"), 16) - 1;
    values.push(int32(eip));

    const fsw = parseInt(hex(registers, "FSW"), 16);
    const abridged = parseInt(hex(registers, "FTW"), 16);
    const physical = [];
    for(let i = 0; i < 8; i++)
    {
        const match = registers.match(new RegExp(`FPR${i}=([0-9a-f]{16}) ([0-9a-f]{4})`, "i"));
        if(!match) throw new Error("qemu oracle: FPR" + i + "\n" + registers);
        let mantissa = BigInt("0x" + match[1]), exponent = parseInt(match[2], 16);
        if(exponent === SENTINEL.exponent)
        {
            // untouched: the zero of a new process; else written by MMX
            const untouched = mantissa === SENTINEL.mantissa;
            if(untouched) mantissa = 0n;
            exponent = untouched ? 0 : 0xFFFF;
        }
        physical.push({ mantissa, exponent });
    }
    let tags = 0;
    for(let i = 0; i < 8; i++)
    {
        const t = abridged >> i & 1 ? tag(physical[i].mantissa, physical[i].exponent) : 3;
        tags |= t << 2 * i;
    }
    const top = fsw >> 11 & 7;
    const st = [];
    for(let i = 0; i < 8; i++)
    {
        const r = (top + i) & 7;
        st.push((tags >> 2 * r & 3) === 2 ? "\"invalid\"" : format_double(extended_to_double(physical[r].mantissa, physical[r].exponent)));
    }
    const mmx = [];
    for(let i = 0; i < 8; i++)
    {
        mmx.push(int32(Number(physical[i].mantissa & 0xFFFFFFFFn)), int32(Number(physical[i].mantissa >> 32n)));
    }
    const xmm = [];
    for(let i = 0; i < 8; i++)
    {
        // "XMM0i=<high qword> <low qword>"
        const match = registers.match(new RegExp(`XMM0${i}=([0-9a-f]{16}) ([0-9a-f]{16})`, "i"));
        if(!match) throw new Error("qemu oracle: XMM" + i + "\n" + registers);
        const text = match[1] + match[2];
        for(let lane = 0; lane < 4; lane++) xmm.push(int32(parseInt(text.slice(24 - 8 * lane, 32 - 8 * lane), 16)));
    }
    const words = [];
    for(let i = 0; i < MEMORY_BYTES; i += 4) words.push(memory.readInt32LE(i));
    const eflags = parseInt(hex(registers, "EFL"), 16);
    const lines = [
        QEMU_MARKER,
        ...(exception ? [`Program received signal (signal ${SIGNALS[exception.vector] || "SIGSEGV"}), vector ${exception.vector}`] : []),
        "---BEGIN JSON---", "[",
        ...values.map(v => `    ${v},`), "",
        ...st.map(v => `    ${v},`), "",
        ...mmx.map(v => `    ${v},`), "",
        ...xmm.map(v => `    ${v},`), "",
    ];
    for(let i = 0; i < words.length; i += 8) lines.push("    " + words.slice(i, i + 8).join(", ") + ",");
    lines.push("", `    ${eflags},`, `    ${tags},`, `    ${fsw}`, "]", "---END JSON---", "");
    return lines.join("\n");
}
