// Guest-backed objects (SVGA_CAP_GBOBJECTS, level gb9 and up; plan section
// 5.9): memory objects (MOBs) and the object tables that list the guest's
// MOBs, surfaces, contexts, shaders and screen targets.
//
// A MOB is guest memory the driver names by an id: a page table of one of
// the SVGAMobFormat shapes, walked once when the MOB is defined. Objects
// keep their contents in MOBs (a surface's image, a shader's bytecode, a
// query's result); svga3d.js moves them between the MOBs and the GPU.
//
// The object tables are guest memory too, but the device owns their
// contents: it writes an entry when an object is defined and clears it when
// the object goes. A driver that set a table up again after a reset, with
// validSizeInBytes covering entries, gets those objects back (load_otable).

import { LOG_VGA } from "../../const.js";
import { dbg_log } from "../../log.js";
import * as C from "./svga_constants.js";
import { read_pages, write_pages } from "./svga_gmr.js";

// For Types Only
import { GraphicsMachine } from "../machine.js";

const PAGE = 4096;

/** The largest MOB taken (SVGA_REG_MOB_MAX_SIZE) */
export const MOB_MAX_SIZE = 256 << 20;
/** How much guest memory the driver should give GB objects, in KiB */
export const GB_MEMORY_KB = 1 << 20;

/** Bytes per entry of each SVGAOTableType */
export const OTABLE_ENTRY_BYTES = [16, 64, 8, 16, 64, 8];
export const OTABLE_TYPES = OTABLE_ENTRY_BYTES.length;

/**
 * The pages behind a page table (SVGAMobFormat)
 * @param {GraphicsMachine} machine
 * @param {number} format
 * @param {number} base page number: of the data (PT_0, RANGE) or of the table
 * @param {number} size in bytes
 * @return {Float64Array} null if the format or size is invalid
 */
export function mob_pages(machine, format, base, size)
{
    if(size > MOB_MAX_SIZE) return null;
    const count = Math.ceil(size / PAGE);
    const pages = new Float64Array(count);
    switch(format)
    {
        case C.SVGA3D_MOBFMT_EMPTY:
            return count === 0 ? pages : null;
        case C.SVGA3D_MOBFMT_RANGE:
        case C.SVGA3D_MOBFMT_PT_0:
        case C.SVGA3D_MOBFMT_PT64_0:
            // the data itself (depth 0 is one page; more is taken as a run)
            for(let i = 0; i < count; i++) pages[i] = base + i;
            return pages;
        case C.SVGA3D_MOBFMT_PT_1:
        case C.SVGA3D_MOBFMT_PT64_1:
        case C.SVGA3D_MOBFMT_PT_2:
        case C.SVGA3D_MOBFMT_PT64_2:
        {
            const wide = format >= C.SVGA3D_MOBFMT_PT64_0;
            const per_page = wide ? PAGE / 8 : PAGE / 4;
            const depth = format === C.SVGA3D_MOBFMT_PT_1 || format === C.SVGA3D_MOBFMT_PT64_1 ? 1 : 2;
            if(count > (depth === 1 ? per_page : per_page * per_page)) return null;
            const table = ppn => {
                const view = new DataView(machine.read_physical(ppn * PAGE, PAGE).slice().buffer);
                return wide ? i => view.getUint32(i * 8, true) + view.getUint32(i * 8 + 4, true) * 0x100000000 :
                    i => view.getUint32(i * 4, true);
            };
            if(depth === 1)
            {
                const entry = table(base);
                for(let i = 0; i < count; i++) pages[i] = entry(i);
            }
            else
            {
                const top = table(base);
                for(let t = 0; t * per_page < count; t++)
                {
                    const entry = table(top(t));
                    for(let i = t * per_page; i < Math.min(count, (t + 1) * per_page); i++) pages[i] = entry(i - t * per_page);
                }
            }
            return pages;
        }
    }
    return null;
}

/**
 * The guest's MOBs, by id. read and write are those of GMRTable, so the
 * code that copies images works on either.
 * @constructor
 * @param {GraphicsMachine} machine
 */
export function MOBTable(machine)
{
    this.machine = machine;
    /** @type {!Map<number, {format: number, base: number, size: number, pages: !Float64Array}>} */
    this.mobs = new Map();
}

MOBTable.prototype.reset = function()
{
    this.mobs.clear();
};

/**
 * @return {boolean} whether the page table was valid
 */
MOBTable.prototype.define = function(id, format, base, size)
{
    const pages = mob_pages(this.machine, format, base, size);
    if(!pages)
    {
        dbg_log("svga: invalid MOB " + id + " (format " + format + ", " + size + " bytes)", LOG_VGA);
        return false;
    }
    this.mobs.set(id, { format, base, size, pages });
    return true;
};

MOBTable.prototype.destroy = function(id)
{
    this.mobs.delete(id);
};

/**
 * @return {number} the size of a MOB in bytes, -1 if there is none
 */
MOBTable.prototype.size = function(id)
{
    const mob = this.mobs.get(id);
    return mob ? mob.size : -1;
};

/**
 * @return {Uint8Array} a copy, or null if not inside the MOB
 */
MOBTable.prototype.read = function(id, offset, length)
{
    const mob = this.mobs.get(id);
    if(!mob || offset < 0 || offset + length > mob.size) return null;
    return read_pages(this.machine, mob.pages, offset, length);
};

/**
 * @param {!Uint8Array} bytes
 * @return {boolean}
 */
MOBTable.prototype.write = function(id, offset, bytes)
{
    const mob = this.mobs.get(id);
    if(!mob || offset < 0 || offset + bytes.length > mob.size) return false;
    return write_pages(this.machine, mob.pages, offset, bytes);
};

/**
 * A dword of a MOB (0 outside of it)
 */
MOBTable.prototype.read32 = function(id, offset)
{
    const bytes = this.read(id, offset, 4);
    return bytes ? (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0 : 0;
};

MOBTable.prototype.write32 = function(id, offset, value)
{
    return this.write(id, offset, new Uint8Array(Uint32Array.of(value).buffer));
};

MOBTable.prototype.get_state = function()
{
    const state = [];
    for(const [id, mob] of this.mobs) state.push([id, mob.format, mob.base, mob.size, mob.pages]);
    return state;
};

MOBTable.prototype.set_state = function(state)
{
    this.mobs.clear();
    for(const [id, format, base, size, pages] of state)
    {
        this.mobs.set(id, { format, base, size, pages: Float64Array.from(pages) });
    }
};

/**
 * The object tables (SET_OTABLE_BASE): where each is, in guest memory
 * @constructor
 * @param {GraphicsMachine} machine
 */
export function OTables(machine)
{
    this.machine = machine;
    /** @type {!Array<?{format: number, base: number, size: number, pages: !Float64Array}>} */
    this.tables = [];
    this.reset();
}

OTables.prototype.reset = function()
{
    this.tables = new Array(OTABLE_TYPES).fill(null);
};

/**
 * SET_OTABLE_BASE(64) and GROW_OTABLE
 * @return {boolean}
 */
OTables.prototype.set = function(type, format, base, size)
{
    if(type >= OTABLE_TYPES) return false;
    if(!size)
    {
        this.tables[type] = null;
        return true;
    }
    const pages = mob_pages(this.machine, format, base, size);
    if(!pages) return false;
    this.tables[type] = { format, base, size, pages };
    return true;
};

/**
 * The number of entries a table has room for
 */
OTables.prototype.capacity = function(type)
{
    const table = this.tables[type];
    return table ? Math.floor(table.size / OTABLE_ENTRY_BYTES[type]) : 0;
};

/**
 * @return {Uint8Array} the entry, or null if the table is not that big
 */
OTables.prototype.read_entry = function(type, index)
{
    const table = this.tables[type], bytes = OTABLE_ENTRY_BYTES[type];
    if(!table || (index + 1) * bytes > table.size) return null;
    return read_pages(this.machine, table.pages, index * bytes, bytes);
};

/**
 * Write an entry (shorter `bytes` are padded with zeros); a cleared entry is
 * all zeros
 * @param {Uint8Array} bytes null to clear it
 */
OTables.prototype.write_entry = function(type, index, bytes)
{
    const table = this.tables[type], size = OTABLE_ENTRY_BYTES[type];
    if(!table || (index + 1) * size > table.size) return false;
    const entry = new Uint8Array(size);
    if(bytes) entry.set(bytes.subarray(0, size));
    return write_pages(this.machine, table.pages, index * size, entry);
};

OTables.prototype.get_state = function()
{
    return this.tables.map(t => t && [t.format, t.base, t.size, t.pages]);
};

OTables.prototype.set_state = function(state)
{
    this.reset();
    state.forEach((t, type) => {
        if(t) this.tables[type] = { format: t[0], base: t[1], size: t[2], pages: Float64Array.from(t[3]) };
    });
};

/**
 * The dwords of an entry, as a little-endian view
 * @param {!Uint8Array} bytes
 * @return {!DataView}
 */
export function entry_view(bytes)
{
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
