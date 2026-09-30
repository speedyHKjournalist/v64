// The boundary between a guest display device and whatever presents its
// output: a canvas, a terminal, nothing (node), or the CPU Worker transport.
// See docs/display-design.md.

// For Types Only
import { BusConnector } from "./bus.js";

/** Text cell flag: the cell blinks. */
export const DISPLAY_FLAG_BLINKING = 0x01;

/** Text cell flag: the glyph comes from font page B rather than A. */
export const DISPLAY_FLAG_FONT_PAGE_B = 0x02;

/**
 * What a display device drives. Every presenter implements all of it, so a
 * device never needs to know which one it is talking to.
 * @interface
 */
export function DisplaySink() {}

/** @param {boolean} graphical */
DisplaySink.prototype.set_mode = function(graphical) {};

/**
 * @param {number} cols
 * @param {number} rows
 */
DisplaySink.prototype.set_size_text = function(cols, rows) {};

/**
 * @param {number} width
 * @param {number} height
 * @param {number} buffer_width
 * @param {number} buffer_height
 */
DisplaySink.prototype.set_size_graphical = function(width, height, buffer_width, buffer_height) {};

/**
 * @param {number} row
 * @param {number} col
 * @param {number} chr
 * @param {number} flags DISPLAY_FLAG_*
 * @param {number} bg_color 0xRRGGBB
 * @param {number} fg_color 0xRRGGBB
 */
DisplaySink.prototype.put_char = function(row, col, chr, flags, bg_color, fg_color) {};

/**
 * @param {number} row
 * @param {number} col
 */
DisplaySink.prototype.update_cursor = function(row, col) {};

/**
 * @param {number} start
 * @param {number} end
 * @param {boolean} enabled
 */
DisplaySink.prototype.update_cursor_scanline = function(start, end, enabled) {};

/**
 * @param {number} height font height, 1..32px
 * @param {boolean} width_9px
 * @param {boolean} width_dbl 16px wide, overrides width_9px
 * @param {boolean} copy_8th_col duplicate the 8th column into the 9th for 0xC0-0xDF
 * @param {Uint8Array} bitmap VGA plane 2, 32 bytes per glyph
 * @param {boolean} bitmap_changed
 */
DisplaySink.prototype.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed) {};

/**
 * @param {number} page_a
 * @param {number} page_b
 */
DisplaySink.prototype.set_font_page = function(page_a, page_b) {};

DisplaySink.prototype.clear_screen = function() {};

/**
 * Forget the text geometry and fonts, so that a restored state redraws from
 * scratch even if its dimensions match the current ones.
 */
DisplaySink.prototype.clear_text_state = function() {};

/**
 * Draw rectangles of a pixel buffer. Each layer is
 * { pixels, screen_x, screen_y, buffer_x, buffer_y, buffer_width, buffer_height },
 * where pixels is { data, width, height }: RGBA bytes like ImageData's, but a
 * plain view (possibly of shared memory), since ImageData is a browser type.
 * @param {!Array<!Object>} layers
 */
DisplaySink.prototype.update_buffer = function(layers) {};

DisplaySink.prototype.pause = function() {};

DisplaySink.prototype.continue = function() {};

DisplaySink.prototype.destroy = function() {};

/**
 * @param {number} s_x
 * @param {number} s_y
 */
DisplaySink.prototype.set_scale = function(s_x, s_y) {};

/** @return {!Array<string>} */
DisplaySink.prototype.get_text_screen = function() {};

/**
 * @param {number} y
 * @return {string}
 */
DisplaySink.prototype.get_text_row = function(y) {};

/**
 * A guest device that produces a picture.
 * @interface
 */
export function DisplaySource() {}

/**
 * The length of one refresh of the current mode.
 * @return {number} milliseconds
 */
DisplaySource.prototype.vblank_period = function() {};

/** Called at the start of each vertical retrace, in machine time. */
DisplaySource.prototype.on_vblank = function() {};

/** Send the pixels that changed since the last call to the sink. */
DisplaySource.prototype.render = function() {};

/** The next render sends every pixel: the sink lost its copy. */
DisplaySource.prototype.invalidate = function() {};

/**
 * Sits between the display devices and the sink. Devices call it instead of
 * the sink; it keeps the refresh timing on the machine clock (so retrace no
 * longer depends on the host drawing frames) and tells the embedder about
 * screen changes on the bus.
 * @constructor
 * @param {BusConnector} bus
 * @param {DisplaySink} sink
 */
export function DisplayHub(bus, sink)
{
    this.bus = bus;
    this.sink = sink;

    /** @type {DisplaySource} */
    this.source = null;

    /** machine time of the most recent and the next vertical retrace */
    this.last_vblank = 0;
    this.next_vblank = 0;
    this.frame_count = 0;
}

/**
 * Make a device the one whose picture is shown. The first one registered wins
 * until something (a driver taking over a newer device) switches it.
 * @param {DisplaySource} source
 */
DisplayHub.prototype.add_source = function(source)
{
    if(!this.source)
    {
        this.source = source;
    }
};

/**
 * Advance the refresh schedule to `now`, signalling each retrace that passed.
 * A long gap (a paused machine) signals only one: nothing can observe the rest.
 * @param {number} now
 * @return {number} milliseconds until the next retrace
 */
DisplayHub.prototype.timer = function(now)
{
    const source = this.source;
    if(!source)
    {
        return 100;
    }
    if(now < this.last_vblank)
    {
        // The machine clock went back (restored state)
        this.last_vblank = this.next_vblank = now;
    }
    if(now >= this.next_vblank)
    {
        const period = source.vblank_period();
        const behind = Math.floor((now - this.next_vblank) / period);
        this.last_vblank = this.next_vblank + behind * period;
        this.next_vblank = this.last_vblank + period;
        this.frame_count++;
        source.on_vblank();
    }
    return this.next_vblank - now;
};

/**
 * @param {number} now
 * @return {number} milliseconds since the start of the current retrace
 */
DisplayHub.prototype.time_since_vblank = function(now)
{
    this.timer(now);
    return now - this.last_vblank;
};

/**
 * The presenter wants a new picture
 * @param {boolean=} full every pixel, not only those that changed
 */
DisplayHub.prototype.request_frame = function(full)
{
    if(this.source)
    {
        if(full)
        {
            this.source.invalidate();
        }
        this.source.render();
    }
};

/** @param {boolean} graphical */
DisplayHub.prototype.set_mode = function(graphical)
{
    this.sink.set_mode(graphical);
};

/**
 * @param {number} cols
 * @param {number} rows
 */
DisplayHub.prototype.set_size_text = function(cols, rows)
{
    this.sink.set_size_text(cols, rows);
    this.bus.send("screen-set-size", [cols, rows, 0]);
};

/**
 * @param {number} width
 * @param {number} height
 * @param {number} buffer_width
 * @param {number} buffer_height
 * @param {number} bpp
 */
DisplayHub.prototype.set_size_graphical = function(width, height, buffer_width, buffer_height, bpp)
{
    this.sink.set_size_graphical(width, height, buffer_width, buffer_height);
    this.bus.send("screen-set-size", [width, height, bpp]);
};

/**
 * @param {number} row
 * @param {number} col
 * @param {number} chr
 * @param {number} flags
 * @param {number} bg_color
 * @param {number} fg_color
 */
DisplayHub.prototype.put_char = function(row, col, chr, flags, bg_color, fg_color)
{
    this.bus.send("screen-put-char", [row, col, chr]);
    this.sink.put_char(row, col, chr, flags, bg_color, fg_color);
};

/**
 * @param {number} row
 * @param {number} col
 */
DisplayHub.prototype.update_cursor = function(row, col)
{
    this.sink.update_cursor(row, col);
};

/**
 * @param {number} start
 * @param {number} end
 * @param {boolean} enabled
 */
DisplayHub.prototype.update_cursor_scanline = function(start, end, enabled)
{
    this.sink.update_cursor_scanline(start, end, enabled);
};

/**
 * @param {number} height
 * @param {boolean} width_9px
 * @param {boolean} width_dbl
 * @param {boolean} copy_8th_col
 * @param {Uint8Array} bitmap
 * @param {boolean} bitmap_changed
 */
DisplayHub.prototype.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed)
{
    this.sink.set_font_bitmap(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed);
};

/**
 * @param {number} page_a
 * @param {number} page_b
 */
DisplayHub.prototype.set_font_page = function(page_a, page_b)
{
    this.sink.set_font_page(page_a, page_b);
};

DisplayHub.prototype.clear_screen = function()
{
    this.sink.clear_screen();
};

DisplayHub.prototype.clear_text_state = function()
{
    this.sink.clear_text_state();
};

/** @param {!Array<!Object>} layers */
DisplayHub.prototype.update_buffer = function(layers)
{
    this.sink.update_buffer(layers);
};

/**
 * Records the device-facing calls so they can cross the CPU Worker boundary,
 * where DISPLAY_SINK_REPLAY applies them to the real presenter. update_buffer
 * is not recorded: pixels travel as frames, which the worker copies itself.
 * @constructor
 * @implements {DisplaySink}
 * @param {function(string, !Array)} record
 * @param {function(!Array<!Object>)} update_buffer
 */
export function DisplaySinkRecorder(record, update_buffer)
{
    this.record = record;
    this.update_buffer = update_buffer;
}

/** @override */
DisplaySinkRecorder.prototype.set_mode = function(graphical)
{
    this.record("set_mode", [graphical]);
};

/** @override */
DisplaySinkRecorder.prototype.set_size_text = function(cols, rows)
{
    this.record("set_size_text", [cols, rows]);
};

/** @override */
DisplaySinkRecorder.prototype.set_size_graphical = function(width, height, buffer_width, buffer_height)
{
    this.record("set_size_graphical", [width, height, buffer_width, buffer_height]);
};

/** @override */
DisplaySinkRecorder.prototype.put_char = function(row, col, chr, flags, bg_color, fg_color)
{
    this.record("put_char", [row, col, chr, flags, bg_color, fg_color]);
};

/** @override */
DisplaySinkRecorder.prototype.update_cursor = function(row, col)
{
    this.record("update_cursor", [row, col]);
};

/** @override */
DisplaySinkRecorder.prototype.update_cursor_scanline = function(start, end, enabled)
{
    this.record("update_cursor_scanline", [start, end, enabled]);
};

/** @override */
DisplaySinkRecorder.prototype.set_font_bitmap = function(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed)
{
    // The bitmap aliases guest-visible memory; snapshot it before the CPU continues
    this.record("set_font_bitmap", [height, width_9px, width_dbl, copy_8th_col, bitmap.slice(), bitmap_changed]);
};

/** @override */
DisplaySinkRecorder.prototype.set_font_page = function(page_a, page_b)
{
    this.record("set_font_page", [page_a, page_b]);
};

/** @override */
DisplaySinkRecorder.prototype.clear_screen = function()
{
    this.record("clear_screen", []);
};

/** @override */
DisplaySinkRecorder.prototype.clear_text_state = function()
{
    this.record("clear_text_state", []);
};

/** @override */
DisplaySinkRecorder.prototype.pause = function() {};

/** @override */
DisplaySinkRecorder.prototype.continue = function() {};

/** @override */
DisplaySinkRecorder.prototype.destroy = function() {};

/** @override */
DisplaySinkRecorder.prototype.set_scale = function(s_x, s_y) {};

/** @override */
DisplaySinkRecorder.prototype.get_text_screen = function()
{
    // The text lives on the presenting side of the worker boundary
    return [];
};

/** @override */
DisplaySinkRecorder.prototype.get_text_row = function(y)
{
    return "";
};

/**
 * Applies calls recorded by DisplaySinkRecorder. Keyed by the quoted names the
 * recorder uses, and each entry calls the method directly, so the table stays
 * correct when Closure renames the methods.
 * @const {!Object<string, function(!DisplaySink, !Array)>}
 */
export const DISPLAY_SINK_REPLAY = {
    "set_mode": (s, a) => s.set_mode(a[0]),
    "set_size_text": (s, a) => s.set_size_text(a[0], a[1]),
    "set_size_graphical": (s, a) => s.set_size_graphical(a[0], a[1], a[2], a[3]),
    "put_char": (s, a) => s.put_char(a[0], a[1], a[2], a[3], a[4], a[5]),
    "update_cursor": (s, a) => s.update_cursor(a[0], a[1]),
    "update_cursor_scanline": (s, a) => s.update_cursor_scanline(a[0], a[1], a[2]),
    "set_font_bitmap": (s, a) => s.set_font_bitmap(a[0], a[1], a[2], a[3], a[4], a[5]),
    "set_font_page": (s, a) => s.set_font_page(a[0], a[1]),
    "clear_screen": (s, a) => s.clear_screen(),
    "clear_text_state": (s, a) => s.clear_text_state(),
};
