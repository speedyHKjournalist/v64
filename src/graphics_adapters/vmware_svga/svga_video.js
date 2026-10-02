// VMware SVGA II's video overlay (SVGA_FIFO_CAP_VIDEO; svga_overlay.h):
// 32 overlay units, set by SVGA_CMD_ESCAPE's SVGA_ESCAPE_VMWARE_VIDEO_SET_REGS
// and shown by SVGA_ESCAPE_VMWARE_VIDEO_FLUSH. A unit shows a YV12, YUY2 or
// UYVY frame from a GMR (or VRAM), its source rectangle scaled to a
// destination rectangle of the desktop, where the desktop has the unit's
// color key if it has one. Like the cursor, the overlay is drawn over the
// device's picture, never into guest memory: each unit keeps a patch, the
// desktop under its rectangle with the video where it shows, made again when
// a frame comes or the picture under it changes.

import * as C from "./svga_constants.js";

const NUM_UNITS = 32;
const REG = {
    ENABLED: 0, FLAGS: 1, DATA_OFFSET: 2, FORMAT: 3, COLORKEY: 4, SIZE: 5, WIDTH: 6, HEIGHT: 7,
    SRC_X: 8, SRC_Y: 9, SRC_WIDTH: 10, SRC_HEIGHT: 11, DST_X: 12, DST_Y: 13, DST_WIDTH: 14, DST_HEIGHT: 15,
    PITCH_1: 16, PITCH_2: 17, PITCH_3: 18, DATA_GMRID: 19, DST_SCREEN_ID: 20,
};
const NUM_REGS = 21;
const FLAG_COLORKEY = 1;
const COLORKEY_MASK = 0x00FFFFFF;
export const ESCAPE_VIDEO = 0x00020000;
const ESCAPE_VIDEO_SET_REGS = 0x00020001;
const ESCAPE_VIDEO_FLUSH = 0x00020002;
const FOURCC_YV12 = 0x32315659, FOURCC_YUY2 = 0x32595559, FOURCC_UYVY = 0x59565955;
/** The largest destination rectangle a unit draws (pixels) */
const MAX_PIXELS = 4096 * 4096;

/**
 * @constructor
 * @param {function(number, number, number):Uint8Array} read guest memory
 *     through an SVGAGuestPtr (GMR id, offset, length)
 * @param {function(number):?{x: number, y: number}} screen a screen's place on
 *     the desktop, by id
 */
export function VideoOverlay(read, screen)
{
    this.read = read;
    this.screen = screen;
    /** @type {!Array<!Uint32Array>} */
    this.units = [];
    /** @type {!Array<?{x: number, y: number, w: number, h: number, video: !Uint8ClampedArray, key: number, patch: Uint8ClampedArray}>}
     * each unit's frame as last flushed: RGBA of the destination rectangle */
    this.frames = [];
    /** @type {!Array<!Array<number>>} the rectangles drawn last, to put the picture back */
    this.drawn = [];
    this.changed = false;
    this.stats = { flushes: 0, escapes: 0 };
    this.reset();
}

VideoOverlay.prototype.reset = function()
{
    this.units = [];
    for(let i = 0; i < NUM_UNITS; i++)
    {
        const regs = new Uint32Array(NUM_REGS);
        regs[REG.DATA_GMRID] = C.SVGA_GMR_FRAMEBUFFER;
        regs[REG.DST_SCREEN_ID] = C.SVGA_ID_INVALID;
        this.units.push(regs);
    }
    this.frames = new Array(NUM_UNITS).fill(null);
    this.changed = this.drawn.length > 0;
};

/** Whether any unit shows something */
VideoOverlay.prototype.active = function()
{
    return this.frames.some(f => f) || this.drawn.length > 0;
};

/**
 * SVGA_CMD_ESCAPE in the VMware namespace: a video command (command, unit,
 * then for SET_REGS register and value pairs)
 * @param {!Uint32Array} words the escape's payload
 * @return {boolean} whether it was one
 */
VideoOverlay.prototype.escape = function(words)
{
    if(words.length < 2 || (words[0] & 0xFFFF0000) !== ESCAPE_VIDEO) return false;
    const command = words[0], unit = words[1];
    this.stats.escapes++;
    if(unit >= NUM_UNITS) return true;
    const regs = this.units[unit];
    if(command === ESCAPE_VIDEO_SET_REGS)
    {
        for(let i = 2; i + 1 < words.length; i += 2)
        {
            if(words[i] < NUM_REGS) regs[words[i]] = words[i + 1];
        }
        // (switched off: gone at once; on: from the next flush)
        if(!regs[REG.ENABLED] && this.frames[unit])
        {
            this.frames[unit] = null;
            this.changed = true;
        }
    }
    else if(command === ESCAPE_VIDEO_FLUSH)
    {
        this.flush(unit);
    }
    return true;
};

/** FLUSH: the unit's frame, read and converted now */
VideoOverlay.prototype.flush = function(unit)
{
    const r = this.units[unit];
    this.stats.flushes++;
    this.changed = true;
    this.frames[unit] = null;
    if(!r[REG.ENABLED]) return;
    const w = r[REG.DST_WIDTH], h = r[REG.DST_HEIGHT], width = r[REG.WIDTH], height = r[REG.HEIGHT];
    if(!w || !h || !width || !height || w * h > MAX_PIXELS) return;
    const data = r[REG.SIZE] ? this.read(r[REG.DATA_GMRID], r[REG.DATA_OFFSET], r[REG.SIZE]) : null;
    if(!data) return;
    const sx = Math.min(r[REG.SRC_X], width - 1), sy = Math.min(r[REG.SRC_Y], height - 1);
    const sw = Math.max(1, Math.min(r[REG.SRC_WIDTH] || width, width - sx));
    const sh = Math.max(1, Math.min(r[REG.SRC_HEIGHT] || height, height - sy));
    const sample = sampler(r[REG.FORMAT], data, width, height, r[REG.PITCH_1], r[REG.PITCH_2], r[REG.PITCH_3]);
    if(!sample) return;
    const video = new Uint8ClampedArray(w * h * 4);
    const yuv = [0, 0, 0];
    for(let y = 0; y < h; y++)
    {
        const row = sy + Math.floor(y * sh / h);
        for(let x = 0; x < w; x++)
        {
            sample(sx + Math.floor(x * sw / w), row, yuv);
            // BT.601, video range
            const c = 1.164 * (yuv[0] - 16), d = yuv[1] - 128, e = yuv[2] - 128, at = (y * w + x) * 4;
            video[at] = c + 1.596 * e;
            video[at + 1] = c - 0.391 * d - 0.813 * e;
            video[at + 2] = c + 2.018 * d;
            video[at + 3] = 255;
        }
    }
    // (on a screen: its coordinates; else the desktop's)
    const place = r[REG.DST_SCREEN_ID] !== C.SVGA_ID_INVALID ? this.screen(r[REG.DST_SCREEN_ID]) : null;
    this.frames[unit] = {
        x: (r[REG.DST_X] | 0) + (place ? place.x : 0), y: (r[REG.DST_Y] | 0) + (place ? place.y : 0), w, h, video,
        key: r[REG.FLAGS] & FLAG_COLORKEY ? r[REG.COLORKEY] & COLORKEY_MASK : -1, patch: null,
    };
};

/**
 * How to read a pixel's Y, U and V from a frame in its format
 * @return {?function(number, number, !Array<number>)}
 */
function sampler(format, data, width, height, pitch1, pitch2, pitch3)
{
    const at = i => i < data.length ? data[i] : 0;
    switch(format)
    {
        case FOURCC_YUY2:
        case FOURCC_UYVY:
        {
            const pitch = pitch1 || width * 2, uyvy = format === FOURCC_UYVY;
            return (x, y, out) => {
                const pair = y * pitch + (x & ~1) * 2;
                out[0] = at(pair + (uyvy ? 1 : 0) + (x & 1) * 2);
                out[1] = at(pair + (uyvy ? 0 : 1));
                out[2] = at(pair + (uyvy ? 2 : 3));
            };
        }
        case FOURCC_YV12:
        {
            // Y, then V, then U (half size each way)
            const py = pitch1 || width, pv = pitch2 || (width + 1 >> 1), pu = pitch3 || pv;
            const v_at = py * height, u_at = v_at + pv * (height + 1 >> 1);
            return (x, y, out) => {
                out[0] = at(y * py + x);
                out[1] = at(u_at + (y >> 1) * pu + (x >> 1));
                out[2] = at(v_at + (y >> 1) * pv + (x >> 1));
            };
        }
    }
    return null;
}

const intersects = (a, x, y, w, h) => a[0] < x + w && x < a[0] + a[2] && a[1] < y + h && y < a[1] + a[3];

/**
 * The layers to send after the picture's own, before the cursor's: the units'
 * patches, made again where a frame came or the picture changed under them,
 * and the picture again where a unit no longer shows
 * @param {function(number, number):?{data: !Uint8ClampedArray, at: number}} under the
 *     picture's pixel at a point (the layers' coordinates)
 * @param {function(number, number, number, number):!Array<!Object>} region the
 *     picture's layers that cover a rectangle
 * @param {!Array<!Object>} sent the picture's layers this time
 * @param {number} ox where the layers' origin is on the desktop
 * @param {number} oy
 * @return {!Array<!Object>}
 */
VideoOverlay.prototype.layers = function(under, region, sent, ox, oy)
{
    const out = [];
    const rects = [];
    for(const f of this.frames) if(f) rects.push([f.x - ox, f.y - oy, f.w, f.h]);
    // where units were and are no more (or moved): the picture again
    if(this.changed)
    {
        for(const d of this.drawn)
        {
            if(!rects.some(r => r[0] === d[0] && r[1] === d[1] && r[2] === d[2] && r[3] === d[3])) out.push(...region(d[0], d[1], d[2], d[3]));
        }
    }
    for(const f of this.frames)
    {
        if(!f) continue;
        const x = f.x - ox, y = f.y - oy;
        const stale = !f.patch || this.changed || sent.some(l => intersects([l.screen_x, l.screen_y, l.buffer_width, l.buffer_height], x, y, f.w, f.h));
        if(!stale) continue;
        if(!f.patch) f.patch = new Uint8ClampedArray(f.w * f.h * 4);
        const patch = f.patch, video = f.video, key = f.key;
        const kr = key >> 16 & 0xFF, kg = key >> 8 & 0xFF, kb = key & 0xFF;
        for(let py = 0; py < f.h; py++)
        {
            for(let px = 0; px < f.w; px++)
            {
                const p = (py * f.w + px) * 4;
                const pixel = under(x + px, y + py);
                if(!pixel)
                {
                    patch[p + 3] = 0;
                    continue;
                }
                const { data, at } = pixel;
                // (a color key: the video only where the picture has it)
                const show = key < 0 || data[at] === kr && data[at + 1] === kg && data[at + 2] === kb;
                const source = show ? video : data, s = show ? p : at;
                patch[p] = source[s]; patch[p + 1] = source[s + 1]; patch[p + 2] = source[s + 2]; patch[p + 3] = 255;
            }
        }
        out.push(...this.patch_layers(f, x, y, x, y, f.w, f.h));
    }
    this.drawn = rects;
    this.changed = false;
    return out;
};

/**
 * A unit's patch where it covers a rectangle (layer coordinates)
 * @return {!Array<!Object>}
 */
VideoOverlay.prototype.patch_layers = function(f, x, y, rx, ry, rw, rh)
{
    const x0 = Math.max(x, rx), y0 = Math.max(y, ry), x1 = Math.min(x + f.w, rx + rw), y1 = Math.min(y + f.h, ry + rh);
    if(!f.patch || x0 >= x1 || y0 >= y1) return [];
    return [{
        pixels: { data: f.patch, width: f.w, height: f.h },
        screen_x: x0, screen_y: y0, buffer_x: x0 - x, buffer_y: y0 - y, buffer_width: x1 - x0, buffer_height: y1 - y0,
    }];
};

/**
 * The picture with the overlay, for the cursor: a unit's patch pixel at a
 * point (layer coordinates), else the picture's
 */
VideoOverlay.prototype.under = function(under, ox, oy)
{
    return (x, y) => {
        for(let i = this.frames.length - 1; i >= 0; i--)
        {
            const f = this.frames[i];
            if(!f || !f.patch) continue;
            const px = x - (f.x - ox), py = y - (f.y - oy);
            if(px >= 0 && py >= 0 && px < f.w && py < f.h && f.patch[(py * f.w + px) * 4 + 3]) return { data: f.patch, at: (py * f.w + px) * 4 };
        }
        return under(x, y);
    };
};

/** The picture's layers of a rectangle, with the overlay over them (to erase the cursor) */
VideoOverlay.prototype.region = function(region, ox, oy)
{
    return (x, y, w, h) => {
        const out = region(x, y, w, h);
        for(const f of this.frames) if(f) out.push(...this.patch_layers(f, f.x - ox, f.y - oy, x, y, w, h));
        return out;
    };
};

VideoOverlay.prototype.get_state = function()
{
    // (the frames are read again from guest memory on a restore)
    return [this.units.map(r => Array.from(r)), this.frames.map(f => f ? 1 : 0)];
};

VideoOverlay.prototype.set_state = function(state)
{
    this.reset();
    if(!state) return;
    state[0].forEach((regs, i) => { if(this.units[i]) this.units[i].set(regs.slice(0, NUM_REGS)); });
    state[1].forEach((shown, i) => { if(shown) this.flush(i); });
    this.stats.flushes = 0;
};
