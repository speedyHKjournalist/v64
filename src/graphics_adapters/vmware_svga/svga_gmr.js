// Guest Memory Regions: guest RAM the driver lends the device, as lists of
// physical pages. GMR1 is defined through registers (a chain of
// SVGAGuestMemDescriptor pages), GMR2 through FIFO commands (DEFINE_GMR2,
// REMAP_GMR2). SVGAGuestPtr { gmrId, offset } addresses them; two ids are
// special: SVGA_GMR_FRAMEBUFFER (the frame buffer) and SVGA_GMR_NULL.

import * as C from "./svga_constants.js";

// For Types Only
import { GraphicsMachine } from "../machine.js";

const PAGE = 4096;

/** What the device reports and enforces */
export const GMR_MAX_IDS = 64;
export const GMR_MAX_PAGES = 1 << 18;           // 1 GiB of 4 KiB pages
export const GMR_MAX_DESCRIPTOR_LENGTH = 4096;

/**
 * @constructor
 * @param {GraphicsMachine} machine
 * @param {function():!Uint8Array} vram the frame buffer's memory
 */
export function GMRTable(machine, vram)
{
    this.machine = machine;
    this.vram = vram;
    /** @type {!Map<number, !Float64Array>} the guest physical page number of each page */
    this.regions = new Map();
}

GMRTable.prototype.reset = function()
{
    this.regions.clear();
};

/**
 * GMR1: SVGA_REG_GMR_DESCRIPTOR written for the id in SVGA_REG_GMR_ID
 * @param {number} id
 * @param {number} ppn of the first descriptor page, 0 to undefine
 * @return {boolean} whether the descriptor was valid
 */
GMRTable.prototype.define_gmr1 = function(id, ppn)
{
    if(id >= GMR_MAX_IDS) return false;
    if(!ppn)
    {
        this.regions.delete(id);
        return true;
    }
    const pages = [];
    for(let descriptor_pages = 0; ppn && descriptor_pages < GMR_MAX_DESCRIPTOR_LENGTH; descriptor_pages++)
    {
        const page = new DataView(this.machine.read_physical(ppn * PAGE, PAGE).slice().buffer);
        let next = 0;
        for(let at = 0; at < PAGE; at += 8)
        {
            const entry_ppn = page.getUint32(at, true), count = page.getUint32(at + 4, true);
            if(!count)
            {
                // no pages: the next descriptor page, or (ppn 0) the end
                next = entry_ppn;
                break;
            }
            if(pages.length + count > GMR_MAX_PAGES) return false;
            for(let i = 0; i < count; i++) pages.push(entry_ppn + i);
        }
        ppn = next;
    }
    this.regions.set(id, Float64Array.from(pages));
    return true;
};

/**
 * DEFINE_GMR2: a region of num_pages unmapped pages (0 undefines it)
 * @param {number} id
 * @param {number} num_pages
 */
GMRTable.prototype.define_gmr2 = function(id, num_pages)
{
    if(id >= GMR_MAX_IDS || num_pages > GMR_MAX_PAGES) return false;
    if(!num_pages) this.regions.delete(id);
    else this.regions.set(id, new Float64Array(num_pages));
    return true;
};

/**
 * REMAP_GMR2: pages offset..offset+count of a region get the given PPNs
 * @param {number} id
 * @param {number} flags SVGA_REMAP_GMR2_*
 * @param {number} offset first page
 * @param {number} count pages
 * @param {function(number):number} ppn the i-th page number of the command
 * @return {boolean}
 */
GMRTable.prototype.remap_gmr2 = function(id, flags, offset, count, ppn)
{
    const region = this.regions.get(id);
    if(!region || offset + count > region.length) return false;
    for(let i = 0; i < count; i++)
    {
        region[offset + i] = flags & C.SVGA_REMAP_GMR2_SINGLE_PPN ? ppn(0) : ppn(i);
    }
    return true;
};

/**
 * The number of dwords of a REMAP_GMR2 command after its header
 * @param {number} flags
 * @param {number} count
 * @return {number}
 */
export function remap_gmr2_payload(flags, count)
{
    if(flags & C.SVGA_REMAP_GMR2_VIA_GMR) return 2;     // an SVGAGuestPtr to the list
    const entry = flags & C.SVGA_REMAP_GMR2_PPN64 ? 2 : 1;
    return flags & C.SVGA_REMAP_GMR2_SINGLE_PPN ? entry : entry * count;
}

/**
 * The guest physical runs behind [offset, offset + length) of a list of pages
 * @param {!Float64Array} pages guest physical page numbers
 * @param {number} offset
 * @param {number} length
 * @return {Array<{address: number, length: number}>} null if out of the pages
 */
export function page_runs(pages, offset, length)
{
    if(offset < 0 || length < 0 || offset + length > pages.length * PAGE) return null;
    const runs = [];
    let at = offset, left = length;
    while(left > 0)
    {
        const page = Math.floor(at / PAGE), within = at % PAGE;
        const take = Math.min(left, PAGE - within);
        const address = pages[page] * PAGE + within;
        const last = runs[runs.length - 1];
        if(last && last.address + last.length === address) last.length += take;
        else runs.push({ address, length: take });
        at += take;
        left -= take;
    }
    return runs;
}

/**
 * Read from a list of pages
 * @param {GraphicsMachine} machine
 * @param {!Float64Array} pages
 * @param {number} offset
 * @param {number} length
 * @return {Uint8Array} a copy, or null if the range is not in the pages
 */
export function read_pages(machine, pages, offset, length)
{
    const runs = page_runs(pages, offset, length);
    if(!runs) return null;
    if(runs.length === 1) return machine.read_physical(runs[0].address, length).slice();
    const out = new Uint8Array(length);
    let at = 0;
    for(const run of runs)
    {
        out.set(machine.read_physical(run.address, run.length), at);
        at += run.length;
    }
    return out;
}

/**
 * Write into a list of pages
 * @param {GraphicsMachine} machine
 * @param {!Float64Array} pages
 * @param {number} offset
 * @param {!Uint8Array} bytes
 * @return {boolean}
 */
export function write_pages(machine, pages, offset, bytes)
{
    const runs = page_runs(pages, offset, bytes.length);
    if(!runs) return false;
    let at = 0;
    for(const run of runs)
    {
        machine.write_physical(bytes.subarray(at, at + run.length), run.address);
        at += run.length;
    }
    return true;
}

/**
 * Read through an SVGAGuestPtr
 * @param {number} id
 * @param {number} offset
 * @param {number} length
 * @return {Uint8Array} a copy, or null if the range is not in the region
 */
GMRTable.prototype.read = function(id, offset, length)
{
    if(id === C.SVGA_GMR_FRAMEBUFFER)
    {
        const vram = this.vram();
        if(offset < 0 || offset + length > vram.length) return null;
        return vram.slice(offset, offset + length);
    }
    const region = this.regions.get(id);
    return region ? read_pages(this.machine, region, offset, length) : null;
};

/**
 * Write through an SVGAGuestPtr
 * @param {number} id
 * @param {number} offset
 * @param {!Uint8Array} bytes
 * @return {boolean}
 */
GMRTable.prototype.write = function(id, offset, bytes)
{
    if(id === C.SVGA_GMR_FRAMEBUFFER)
    {
        const vram = this.vram();
        if(offset < 0 || offset + bytes.length > vram.length) return false;
        vram.set(bytes, offset);
        return true;
    }
    const region = this.regions.get(id);
    return region ? write_pages(this.machine, region, offset, bytes) : false;
};

GMRTable.prototype.get_state = function()
{
    const state = [];
    for(const [id, pages] of this.regions) state.push(id, pages);
    return state;
};

GMRTable.prototype.set_state = function(state)
{
    this.regions.clear();
    for(let i = 0; i < state.length; i += 2) this.regions.set(state[i], Float64Array.from(state[i + 1]));
};
