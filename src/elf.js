import { dbg_log, LOG_LEVEL } from "./log.js";

// A minimal elf parser for loading 32 bit, x86, little endian, executable elf files

const ELF_MAGIC = 0x464C457F;

const types = DataView.prototype;
const U8 = { size: 1, get: types.getUint8, set: types.setUint8, };
const U16 = { size: 2, get: types.getUint16, set: types.setUint16, };
const U32 = { size: 4, get: types.getUint32, set: types.setUint32, };
const pad = function(size)
{
    return {
        size,
        get: offset => -1,
    };
};

const Header = create_struct([
    { magic: U32, },

    { class: U8, },
    { data: U8, },
    { version0: U8, },
    { osabi: U8, },

    { abiversion: U8, },
    { pad0: pad(7) },

    { type: U16, },
    { machine: U16, },

    { version1: U32, },
    { entry: U32, },
    { phoff: U32, },
    { shoff: U32, },
    { flags: U32, },

    { ehsize: U16, },
    { phentsize: U16, },
    { phnum: U16, },
    { shentsize: U16, },
    { shnum: U16, },
    { shstrndx: U16, },
]);
console.assert(Header.reduce((a, entry) => a + entry.size, 0) === 52);

const ProgramHeader = create_struct([
    { type: U32, },
    { offset: U32, },
    { vaddr: U32, },
    { paddr: U32, },
    { filesz: U32, },
    { memsz: U32, },
    { flags: U32, },
    { align: U32, },
]);
console.assert(ProgramHeader.reduce((a, entry) => a + entry.size, 0) === 32);

const SectionHeader = create_struct([
    { name: U32, },
    { type: U32, },
    { flags: U32, },
    { addr: U32, },
    { offset: U32, },
    { size: U32, },
    { link: U32, },
    { info: U32, },
    { addralign: U32, },
    { entsize: U32, },
]);
console.assert(SectionHeader.reduce((a, entry) => a + entry.size, 0) === 40);


// From [{ name: type }, ...] to [{ name, type, size, get, set }, ...]
function create_struct(struct)
{
    return struct.map(function(entry)
    {
        const keys = Object.keys(entry);
        console.assert(keys.length === 1);
        const name = keys[0];
        const type = entry[name];

        console.assert(type.size > 0);

        return {
            name,
            type,
            size: type.size,
            get: type.get,
            set: type.set,
        };
    });
}

/**
 * Why a direct-boot ELF image cannot be loaded (only 32-bit little-endian
 * i386 executables can), or null.
 * @param {ArrayBuffer} buffer
 */
export function elf_unsupported_reason(buffer)
{
    if(buffer.byteLength < 52) return "truncated header";
    const view = new DataView(buffer);
    if(view.getUint32(0, true) !== ELF_MAGIC) return "bad magic";
    // 1, 2 in EI_CLASS: 32 or 64 bit
    if(view.getUint8(4) === 2) return "64-bit ELF (x86-64 kernels boot from a BIOS disk or ISO, or through a 32-bit multiboot entry)";
    if(view.getUint8(4) !== 1) return "unknown ELF class";
    if(view.getUint8(5) !== 1) return "big endian";
    if(view.getUint8(6) !== 1 || view.getUint32(20, true) !== 1) return "bad version";
    // 1, 2, 3, 4 specify whether the object is relocatable, executable,
    // shared, or core, respectively.
    if(view.getUint16(16, true) !== 2) return "not an executable";
    // EM_386
    if(view.getUint16(18, true) !== 3) return "not an i386 image (machine " + view.getUint16(18, true) + ")";
    if(view.getUint16(40, true) !== 52 || view.getUint16(42, true) !== 32 ||
        view.getUint16(46, true) !== 40 && view.getUint16(48, true) !== 0) return "bad header sizes";
    return null;
}

/** @param {ArrayBuffer} buffer */
export function read_elf(buffer)
{
    const view = new DataView(buffer);

    const [header, offset] = read_struct(view, Header);
    console.assert(offset === 52);

    if(DEBUG)
    {
        for(const key of Object.keys(header))
        {
            dbg_log(key + ": 0x" + (header[key].toString(16) >>> 0));
        }
    }

    const reason = elf_unsupported_reason(buffer);
    if(reason) throw new Error("Unsupported ELF image: " + reason);

    const [program_headers, ph_offset] = read_structs(
        view_slice(view, header.phoff, header.phentsize * header.phnum),
        ProgramHeader,
        header.phnum);

    const [sections_headers, sh_offset] = read_structs(
        view_slice(view, header.shoff, header.shentsize * header.shnum),
        SectionHeader,
        header.shnum);

    if(DEBUG && LOG_LEVEL)
    {
        console.log("%d program headers:", program_headers.length);
        for(const program of program_headers)
        {
            console.log(
                "type=%s offset=%s vaddr=%s paddr=%s " +
                "filesz=%s memsz=%s flags=%s align=%s",
                program.type.toString(16),
                program.offset.toString(16),
                program.vaddr.toString(16),
                program.paddr.toString(16),
                program.filesz.toString(16),
                program.memsz.toString(16),
                program.flags.toString(16),
                program.align.toString(16)
            );
        }

        console.log("%d section headers:", sections_headers.length);
        for(const section of sections_headers)
        {
            console.log(
                "name=%s type=%s flags=%s addr=%s offset=%s " +
                "size=%s link=%s info=%s addralign=%s entsize=%s",
                section.name.toString(16),
                section.type.toString(16),
                section.flags.toString(16),
                section.addr.toString(16),
                section.offset.toString(16),
                section.size.toString(16),
                section.link.toString(16),
                section.info.toString(16),
                section.addralign.toString(16),
                section.entsize.toString(16)
            );
        }
    }

    return {
        header,
        program_headers,
        sections_headers,
    };
}

function read_struct(view, Struct)
{
    const result = {};
    let offset = 0;
    const LITTLE_ENDIAN = true; // big endian not supported yet

    for(const entry of Struct)
    {
        const value = entry.get.call(view, offset, LITTLE_ENDIAN);
        console.assert(result[entry.name] === undefined);
        result[entry.name] = value;
        offset += entry.size;
    }

    return [result, offset];
}

function read_structs(view, Struct, count)
{
    const result = [];
    let offset = 0;

    for(var i = 0; i < count; i++)
    {
        const [s, size] = read_struct(view_slice(view, offset), Struct);
        result.push(s);
        offset += size;
    }

    return [result, offset];
}

/** @param {number=} length */
function view_slice(view, offset, length)
{
    return new DataView(view.buffer, view.byteOffset + offset, length);
}
