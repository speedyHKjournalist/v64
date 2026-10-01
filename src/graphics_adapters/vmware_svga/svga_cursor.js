// The hardware cursor (SVGA_CAP_CURSOR, ALPHA_CURSOR, CURSOR_BYPASS_3),
// drawn by the device: every render sends, after the picture, a small layer
// with the cursor composed over what is under it, and the picture under its
// old place when it moved. The pictures themselves are never written, so
// blits that land under the cursor need no care.
//
// A monochrome or colour cursor (DEFINE_CURSOR) is an AND mask and an XOR
// mask: shown = (under AND and) XOR xor, which inverts where both are set.
// An alpha cursor (DEFINE_ALPHA_CURSOR) is premultiplied BGRA.

/**
 * @constructor
 */
export function SoftwareCursor()
{
    this.reset();
}

SoftwareCursor.prototype.reset = function()
{
    this.width = 0;
    this.height = 0;
    this.hot_x = 0;
    this.hot_y = 0;
    /** @type {Int32Array} per pixel: AND mask (0 or -1), or null for an alpha cursor */
    this.and = null;
    /** @type {Int32Array} XOR mask as 0xBBGGRR (DEFINE_CURSOR) or premultiplied 0xAARRGGBB */
    this.image = null;
    this.alpha = false;
    this.visible = false;
    this.x = 0;
    this.y = 0;
    // the rectangle drawn last time, in desktop coordinates: erased when it moves
    this.drawn = null;
    this.patch = null;
};

/**
 * DEFINE_CURSOR
 * @param {number} hot_x
 * @param {number} hot_y
 * @param {number} width
 * @param {number} height
 * @param {number} and_depth bits per pixel of the AND mask (1 or 32)
 * @param {number} xor_depth bits per pixel of the XOR mask (1, 8, 24 or 32)
 * @param {function(number):number} read the masks' dwords, AND mask first
 * @param {!Uint8Array} palette 256 RGB entries, for an 8-bit XOR mask
 */
SoftwareCursor.prototype.define = function(hot_x, hot_y, width, height, and_depth, xor_depth, read, palette)
{
    const and_pitch = (width * and_depth + 31) >>> 5;
    const xor_pitch = (width * xor_depth + 31) >>> 5;
    const bit = (offset, pitch, x, y, depth) => {
        const position = x * depth;
        const dword = read(offset + y * pitch + (position >>> 5)) >>> 0;
        if(depth === 1)
        {
            // most significant bit first within each byte
            const byte = dword >>> 8 * (position >>> 3 & 3) & 0xFF;
            return byte >> 7 - (x & 7) & 1;
        }
        if(depth === 8) return dword >>> 8 * (x & 3) & 0xFF;
        return dword;
    };
    this.width = width;
    this.height = height;
    this.hot_x = hot_x;
    this.hot_y = hot_y;
    this.alpha = false;
    this.and = new Int32Array(width * height);
    this.image = new Int32Array(width * height);
    const xor_offset = and_pitch * height;
    for(let y = 0; y < height; y++)
    {
        for(let x = 0; x < width; x++)
        {
            const i = y * width + x;
            const and = bit(0, and_pitch, x, y, and_depth);
            this.and[i] = and_depth === 1 ? (and ? -1 : 0) : and | 0;
            const xor = bit(xor_offset, xor_pitch, x, y, xor_depth);
            if(xor_depth === 1) this.image[i] = xor ? 0xFFFFFF : 0;
            else if(xor_depth === 8) this.image[i] = palette[xor * 3] << 16 | palette[xor * 3 + 1] << 8 | palette[xor * 3 + 2];
            else this.image[i] = xor & 0xFFFFFF;
        }
    }
};

/**
 * The number of dwords of DEFINE_CURSOR's masks
 */
export function cursor_masks_length(width, height, and_depth, xor_depth)
{
    return ((width * and_depth + 31) >>> 5) * height + ((width * xor_depth + 31) >>> 5) * height;
}

/**
 * DEFINE_ALPHA_CURSOR: width * height premultiplied 0xAARRGGBB dwords
 * @param {function(number):number} read
 */
SoftwareCursor.prototype.define_alpha = function(hot_x, hot_y, width, height, read)
{
    this.width = width;
    this.height = height;
    this.hot_x = hot_x;
    this.hot_y = hot_y;
    this.alpha = true;
    this.and = null;
    this.image = new Int32Array(width * height);
    for(let i = 0; i < width * height; i++) this.image[i] = read(i);
};

/**
 * @param {number} x of the hotspot, on the desktop
 * @param {number} y
 * @param {boolean} visible
 */
SoftwareCursor.prototype.move = function(x, y, visible)
{
    this.x = x;
    this.y = y;
    this.visible = visible && this.width > 0;
};

/**
 * The layers to send after the picture's own
 * @param {function(number, number):?{data: !Uint8ClampedArray, at: number}} under where the
 *     picture's pixel at a desktop point is, or null outside of it
 * @param {function(number, number, number, number):!Array<!Object>} region the picture's
 *     layers that cover a desktop rectangle (to erase the cursor)
 * @return {!Array<!Object>}
 */
SoftwareCursor.prototype.layers = function(under, region)
{
    const layers = [];
    const left = this.x - this.hot_x, top = this.y - this.hot_y;
    const moved = !this.drawn || this.drawn[0] !== left || this.drawn[1] !== top || !this.visible;
    if(this.drawn && moved)
    {
        layers.push(...region(this.drawn[0], this.drawn[1], this.drawn[2], this.drawn[3]));
        this.drawn = null;
    }
    if(!this.visible) return layers;

    const width = this.width, height = this.height;
    if(!this.patch || this.patch.length !== width * height * 4)
    {
        this.patch = new Uint8ClampedArray(width * height * 4);
    }
    const patch = this.patch;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for(let y = 0; y < height; y++)
    {
        for(let x = 0; x < width; x++)
        {
            const pixel = under(left + x, top + y);
            if(!pixel) continue;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
            const { data, at } = pixel, i = y * width + x, p = i * 4;
            let r = data[at], g = data[at + 1], b = data[at + 2];
            if(this.alpha)
            {
                const argb = this.image[i], a = argb >>> 24, keep = 255 - a;
                r = (argb >>> 16 & 0xFF) + (r * keep / 255 | 0);
                g = (argb >>> 8 & 0xFF) + (g * keep / 255 | 0);
                b = (argb & 0xFF) + (b * keep / 255 | 0);
            }
            else
            {
                const and = this.and[i], xor = this.image[i];
                r = r & and ^ xor >>> 16 & 0xFF;
                g = g & and ^ xor >>> 8 & 0xFF;
                b = b & and ^ xor & 0xFF;
            }
            patch[p] = r; patch[p + 1] = g; patch[p + 2] = b; patch[p + 3] = 255;
        }
    }
    if(x0 >= x1 || y0 >= y1) return layers;
    layers.push({
        pixels: { data: patch, width, height },
        screen_x: left + x0, screen_y: top + y0,
        buffer_x: x0, buffer_y: y0,
        buffer_width: x1 - x0, buffer_height: y1 - y0,
    });
    this.drawn = [left + x0, top + y0, x1 - x0, y1 - y0];
    return layers;
};

SoftwareCursor.prototype.get_state = function()
{
    return [this.width, this.height, this.hot_x, this.hot_y, this.alpha, this.and, this.image, this.visible, this.x, this.y];
};

SoftwareCursor.prototype.set_state = function(state)
{
    [this.width, this.height, this.hot_x, this.hot_y, this.alpha, this.and, this.image, this.visible, this.x, this.y] = state;
    this.and = this.and && Int32Array.from(this.and);
    this.image = this.image && Int32Array.from(this.image);
    this.drawn = null;
    this.patch = null;
};
