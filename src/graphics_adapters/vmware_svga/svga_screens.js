// Screen Objects (SVGA_FIFO_CAP_SCREEN_OBJECT, SVGA_CAP_SCREEN_OBJECT_2):
// monitors the driver defines, each with a position on the virtual desktop.
// A screen with no backing store (screen object 2) keeps its picture here;
// the driver fills it with BLIT_GMRFB_TO_SCREEN from a GMRFB (an image in a
// GMR) and reads it back with BLIT_SCREEN_TO_GMRFB. A screen backed by the
// frame buffer shows VRAM, converted when UPDATE covers it.

import * as C from "./svga_constants.js";

/**
 * One screen object
 * @constructor
 */
function Screen(id, flags, width, height, x, y, backing)
{
    this.id = id;
    this.flags = flags;
    this.width = width;
    this.height = height;
    this.x = x;
    this.y = y;
    /** @type {?{gmr: number, offset: number, pitch: number}} */
    this.backing = backing;
    /** RGBA, row after row */
    this.rgba = new Uint8ClampedArray(width * height * 4);
    // rows changed since the last render
    this.dirty_min = 0;
    this.dirty_max = height;
}

/**
 * @param {number} top
 * @param {number} bottom (exclusive)
 */
Screen.prototype.mark = function(top, bottom)
{
    if(this.dirty_min >= this.dirty_max)
    {
        this.dirty_min = top;
        this.dirty_max = bottom;
    }
    else
    {
        this.dirty_min = Math.min(this.dirty_min, top);
        this.dirty_max = Math.max(this.dirty_max, bottom);
    }
};

/**
 * @constructor
 * @param {{read: function(number, number, number):Uint8Array, write: function(number, number, !Uint8Array):boolean}} gmrs
 */
export function ScreenObjects(gmrs)
{
    this.gmrs = gmrs;
    /** @type {!Map<number, !Screen>} */
    this.screens = new Map();
    /** The image BLIT_* commands read and write: SVGA_CMD_DEFINE_GMRFB */
    this.gmrfb = { gmr: C.SVGA_GMR_NULL, offset: 0, pitch: 0, bpp: 32, depth: 24 };
    // The desktop's bounding box changed: the display needs a new size
    this.layout_changed = true;
}

ScreenObjects.prototype.reset = function()
{
    this.screens.clear();
    this.gmrfb = { gmr: C.SVGA_GMR_NULL, offset: 0, pitch: 0, bpp: 32, depth: 24 };
    this.layout_changed = true;
};

/**
 * DEFINE_SCREEN: an SVGAScreenObject, structSize bytes from its first dword
 * @param {function(number):number} read the structure's dwords
 * @param {number} dwords how many there are
 * @return {boolean}
 */
ScreenObjects.prototype.define = function(read, dwords)
{
    const id = read(1) >>> 0, flags = read(2) >>> 0;
    const width = read(3) >>> 0, height = read(4) >>> 0;
    const x = read(5) | 0, y = read(6) | 0;
    if(!width || !height || width > C.SVGA_MAX_SCREEN_SIZE || height > C.SVGA_MAX_SCREEN_SIZE ||
        id >= C.SVGA_MAX_DISPLAYS)
    {
        return false;
    }
    let backing = null;
    if(dwords >= 10)
    {
        const gmr = read(7) >>> 0;
        if(gmr !== C.SVGA_GMR_NULL) backing = { gmr, offset: read(8) >>> 0, pitch: read(9) >>> 0 };
    }
    if(flags & C.SVGA_SCREEN_DEACTIVATE)
    {
        this.screens.delete(id);
    }
    else
    {
        const old = this.screens.get(id);
        const screen = new Screen(id, flags, width, height, x, y, backing);
        // a moved or resized screen keeps what it can of its picture
        if(old && !backing)
        {
            const w = Math.min(old.width, width) * 4;
            for(let row = 0; row < Math.min(old.height, height); row++)
            {
                screen.rgba.set(old.rgba.subarray(row * old.width * 4, row * old.width * 4 + w), row * width * 4);
            }
        }
        if(backing) this.convert_backing(screen, 0, 0, width, height);
        this.screens.set(id, screen);
    }
    this.layout_changed = true;
    return true;
};

/** @param {number} id */
ScreenObjects.prototype.destroy = function(id)
{
    this.screens.delete(id);
    this.layout_changed = true;
};

ScreenObjects.prototype.define_gmrfb = function(gmr, offset, pitch, format)
{
    this.gmrfb = { gmr, offset, pitch, bpp: format & 0xFF, depth: format >> 8 & 0xFF };
};

/**
 * Bytes of one GMRFB pixel, or 0 for a format this device does not take
 * @return {number}
 */
ScreenObjects.prototype.gmrfb_bytes = function()
{
    const { bpp } = this.gmrfb;
    return bpp === 32 ? 4 : bpp === 16 ? 2 : 0;
};

/**
 * Convert one row of GMRFB pixels into RGBA
 * @param {!Uint8Array} source
 * @param {!Uint8ClampedArray} target
 * @param {number} at in target
 * @param {number} count pixels
 */
ScreenObjects.prototype.to_rgba = function(source, target, at, count)
{
    if(this.gmrfb.bpp === 32)
    {
        for(let i = 0, s = 0; i < count; i++, s += 4)
        {
            target[at++] = source[s + 2];
            target[at++] = source[s + 1];
            target[at++] = source[s];
            target[at++] = 255;
        }
    }
    else
    {
        const r5g6b5 = this.gmrfb.depth !== 15;
        for(let i = 0, s = 0; i < count; i++, s += 2)
        {
            const v = source[s] | source[s + 1] << 8;
            if(r5g6b5)
            {
                target[at++] = (v >> 11 & 31) * 255 / 31;
                target[at++] = (v >> 5 & 63) * 255 / 63;
            }
            else
            {
                target[at++] = (v >> 10 & 31) * 255 / 31;
                target[at++] = (v >> 5 & 31) * 255 / 31;
            }
            target[at++] = (v & 31) * 255 / 31;
            target[at++] = 255;
        }
    }
};

/**
 * Clip a rectangle to a screen: [left, top, right, bottom) or null
 */
function clip(screen, left, top, right, bottom)
{
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, screen.width);
    bottom = Math.min(bottom, screen.height);
    return left < right && top < bottom ? [left, top, right, bottom] : null;
}

/**
 * BLIT_GMRFB_TO_SCREEN: destRect is in the screen's coordinates, the source
 * starts at srcOrigin of the GMRFB
 * @return {boolean}
 */
ScreenObjects.prototype.blit_to_screen = function(src_x, src_y, left, top, right, bottom, screen_id)
{
    const screen = this.screens.get(screen_id);
    const bytes = this.gmrfb_bytes();
    if(!screen || !bytes) return false;
    const rect = clip(screen, left, top, right, bottom);
    if(!rect) return true;
    const [l, t, r, b] = rect;
    src_x += l - left;
    src_y += t - top;
    const { gmr, offset, pitch } = this.gmrfb;
    for(let row = t; row < b; row++)
    {
        const from = offset + (src_y + row - t) * pitch + src_x * bytes;
        const pixels = this.gmrs.read(gmr, from, (r - l) * bytes);
        if(!pixels) return false;
        this.to_rgba(pixels, screen.rgba, (row * screen.width + l) * 4, r - l);
    }
    if(screen.backing)
    {
        // the backing store holds the screen's picture too
        this.copy_to_backing(screen, l, t, r, b);
    }
    screen.mark(t, b);
    return true;
};

/**
 * BLIT_SCREEN_TO_GMRFB: srcRect in the screen's coordinates, into the GMRFB
 * at destOrigin (32 bpp only)
 * @return {boolean}
 */
ScreenObjects.prototype.blit_from_screen = function(dst_x, dst_y, left, top, right, bottom, screen_id)
{
    const screen = this.screens.get(screen_id);
    if(!screen || this.gmrfb.bpp !== 32) return false;
    const rect = clip(screen, left, top, right, bottom);
    if(!rect) return true;
    const [l, t, r, b] = rect;
    dst_x += l - left;
    dst_y += t - top;
    const { gmr, offset, pitch } = this.gmrfb;
    const row_bytes = new Uint8Array((r - l) * 4);
    for(let row = t; row < b; row++)
    {
        const from = (row * screen.width + l) * 4;
        for(let i = 0; i < r - l; i++)
        {
            row_bytes[i * 4] = screen.rgba[from + i * 4 + 2];
            row_bytes[i * 4 + 1] = screen.rgba[from + i * 4 + 1];
            row_bytes[i * 4 + 2] = screen.rgba[from + i * 4];
            row_bytes[i * 4 + 3] = 0;
        }
        if(!this.gmrs.write(gmr, offset + (dst_y + row - t) * pitch + dst_x * 4, row_bytes)) return false;
    }
    return true;
};

/**
 * Screens backed by the frame buffer (or a GMR): bring the picture in a
 * rectangle of the screen up to date from the backing store
 */
ScreenObjects.prototype.convert_backing = function(screen, left, top, right, bottom)
{
    const rect = clip(screen, left, top, right, bottom);
    if(!rect) return;
    const [l, t, r, b] = rect;
    const { gmr, offset, pitch } = screen.backing;
    for(let row = t; row < b; row++)
    {
        const pixels = this.gmrs.read(gmr, offset + row * pitch + l * 4, (r - l) * 4);
        if(!pixels) return;
        let at = (row * screen.width + l) * 4;
        for(let i = 0; i < pixels.length; i += 4)
        {
            screen.rgba[at++] = pixels[i + 2];
            screen.rgba[at++] = pixels[i + 1];
            screen.rgba[at++] = pixels[i];
            screen.rgba[at++] = 255;
        }
    }
    screen.mark(t, b);
};

/**
 * The opposite, after a blit into a backed screen
 */
ScreenObjects.prototype.copy_to_backing = function(screen, l, t, r, b)
{
    const { gmr, offset, pitch } = screen.backing;
    const row_bytes = new Uint8Array((r - l) * 4);
    for(let row = t; row < b; row++)
    {
        const from = (row * screen.width + l) * 4;
        for(let i = 0; i < r - l; i++)
        {
            row_bytes[i * 4] = screen.rgba[from + i * 4 + 2];
            row_bytes[i * 4 + 1] = screen.rgba[from + i * 4 + 1];
            row_bytes[i * 4 + 2] = screen.rgba[from + i * 4];
        }
        this.gmrs.write(gmr, offset + row * pitch + l * 4, row_bytes);
    }
};

/**
 * UPDATE in screen object mode: a rectangle of the virtual desktop
 */
ScreenObjects.prototype.update = function(x, y, width, height)
{
    for(const screen of this.screens.values())
    {
        if(screen.backing)
        {
            this.convert_backing(screen, x - screen.x, y - screen.y, x - screen.x + width, y - screen.y + height);
        }
    }
};

/**
 * The bounding box of all screens on the virtual desktop
 * @return {{x: number, y: number, width: number, height: number}}
 */
ScreenObjects.prototype.bounds = function()
{
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for(const s of this.screens.values())
    {
        x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
        x1 = Math.max(x1, s.x + s.width); y1 = Math.max(y1, s.y + s.height);
    }
    return x0 === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/**
 * The layers of everything that changed, for DisplaySink.update_buffer, and
 * forget the changes
 * @param {boolean} all every row, not only changed ones
 * @return {!Array<!Object>}
 */
ScreenObjects.prototype.take_layers = function(all)
{
    const box = this.bounds();
    const layers = [];
    for(const s of this.screens.values())
    {
        const top = all ? 0 : s.dirty_min, bottom = all ? s.height : s.dirty_max;
        if(top < bottom)
        {
            layers.push({
                pixels: { data: s.rgba, width: s.width, height: s.height },
                screen_x: s.x - box.x, screen_y: s.y - box.y + top,
                buffer_x: 0, buffer_y: top,
                buffer_width: s.width, buffer_height: bottom - top,
            });
        }
        s.dirty_min = s.dirty_max = 0;
    }
    return layers;
};

ScreenObjects.prototype.get_state = function()
{
    const screens = [];
    for(const s of this.screens.values())
    {
        screens.push([s.id, s.flags, s.width, s.height, s.x, s.y,
            s.backing ? [s.backing.gmr, s.backing.offset, s.backing.pitch] : null,
            new Uint8Array(s.rgba.buffer, s.rgba.byteOffset, s.rgba.length)]);
    }
    const g = this.gmrfb;
    return [screens, [g.gmr, g.offset, g.pitch, g.bpp, g.depth]];
};

ScreenObjects.prototype.set_state = function(state)
{
    this.screens.clear();
    for(const [id, flags, width, height, x, y, backing, rgba] of state[0])
    {
        const screen = new Screen(id, flags, width, height, x, y,
            backing ? { gmr: backing[0], offset: backing[1], pitch: backing[2] } : null);
        screen.rgba.set(rgba);
        this.screens.set(id, screen);
    }
    const [gmr, offset, pitch, bpp, depth] = state[1];
    this.gmrfb = { gmr, offset, pitch, bpp, depth };
    this.layout_changed = true;
};
