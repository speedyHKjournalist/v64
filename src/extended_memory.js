// The host store of extended RAM (docs/x86-64.md):
// guest RAM beyond the wasm32 backing store, at guest physical 4 GiB plus
// high_memory_size. The CPU caches its pages in frames of the wasm heap
// (src/rust/x64/extended.rs) and copies a page in or out through the
// imports extended_load and extended_store. The pages are kept in buffers of
// at most 1 GiB, shared with vCPU workers (SharedArrayBuffer) where the host
// has them; a bitmap marks pages ever written, so that power-on and
// snapshots skip the rest.

export const EXTENDED_PAGE_SIZE = 4096;
export const EXTENDED_CHUNK_PAGES = 1 << 18;

export class ExtendedStore
{
    /**
     * @param {number} pages
     * @param {Array<!ArrayBuffer|!SharedArrayBuffer>=} chunks the buffers of another store (a vCPU worker's view)
     * @param {(!ArrayBuffer|!SharedArrayBuffer)=} touched its bitmap
     */
    constructor(pages, chunks, touched)
    {
        const shared = typeof SharedArrayBuffer === "function";
        const allocate = bytes => shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
        this.pages = pages;
        this.shared = shared;
        if(!chunks)
        {
            chunks = [];
            for(let first = 0; first < pages; first += EXTENDED_CHUNK_PAGES)
            {
                chunks.push(allocate(Math.min(EXTENDED_CHUNK_PAGES, pages - first) * EXTENDED_PAGE_SIZE));
            }
            touched = allocate(Math.ceil(pages / 8));
        }
        /** @type {!Array<!Uint8Array>} */
        this.chunks = chunks.map(buffer => new Uint8Array(buffer));
        this.touched = new Uint8Array(touched);
    }

    /** The buffers, for a vCPU worker's store */
    transfer()
    {
        return { "pages": this.pages, "chunks": this.chunks.map(chunk => chunk.buffer), "touched": this.touched.buffer };
    }

    /** @param {number} page @return {!Uint8Array} its bytes in the store */
    page(page)
    {
        const offset = (page % EXTENDED_CHUNK_PAGES) * EXTENDED_PAGE_SIZE;
        return this.chunks[Math.floor(page / EXTENDED_CHUNK_PAGES)].subarray(offset, offset + EXTENDED_PAGE_SIZE);
    }

    is_touched(page)
    {
        return (this.touched[page >> 3] >> (page & 7) & 1) !== 0;
    }

    touch(page)
    {
        if(this.is_touched(page)) return;
        if(this.shared) Atomics.or(this.touched, page >> 3, 1 << (page & 7));
        else this.touched[page >> 3] |= 1 << (page & 7);
    }

    /** extended_load: a page into a frame at `pointer` of the wasm memory */
    load(page, memory, pointer)
    {
        new Uint8Array(memory.buffer, pointer, EXTENDED_PAGE_SIZE).set(this.page(page));
    }

    /** extended_store: a frame back into the store */
    store(page, memory, pointer)
    {
        this.touch(page);
        this.page(page).set(new Uint8Array(memory.buffer, pointer, EXTENDED_PAGE_SIZE));
    }

    /** Write a page (snapshot restore) */
    write(page, bytes)
    {
        this.touch(page);
        this.page(page).set(bytes);
    }

    /** Power-on: every page reads as zero again (every CPU is stopped) */
    clear()
    {
        for(let byte = 0; byte < this.touched.length; byte++)
        {
            if(!this.touched[byte]) continue;
            for(let bit = 0; bit < 8; bit++)
            {
                if(this.touched[byte] & 1 << bit) this.page(byte * 8 + bit).fill(0);
            }
            this.touched[byte] = 0;
        }
    }

    /** @param {number} page @return {boolean} whether it holds only zeros */
    is_zero(page)
    {
        if(!this.is_touched(page)) return true;
        const bytes = this.page(page);
        const words = new Int32Array(bytes.buffer, bytes.byteOffset, EXTENDED_PAGE_SIZE / 4);
        for(let i = 0; i < words.length; i++) if(words[i]) return false;
        return true;
    }
}
