import { dbg_assert } from "../log.js";
import { get_charmap } from "../lib.js";

// For Types Only
import { DisplaySink } from "../display.js";

const CHARACTER_INDEX = 0;
const FLAGS_INDEX = 1;
const BG_COLOR_INDEX = 2;
const FG_COLOR_INDEX = 3;
const TEXT_BUF_COMPONENT_SIZE = 4;

/**
 * Shows nothing and remembers the text screen. Used where there is no screen
 * (node), and the base of presenters that only need the text.
 * @implements {DisplaySink}
 */
export class DummyScreenAdapter
{
    /** @param {Object=} options */
    constructor(options)
    {
        /** 8-bit text to Unicode */
        this.charmap = get_charmap(options?.encoding);

        /** @type {!Int32Array} character, flags, background, foreground per cell */
        this.text = new Int32Array(0);
        this.text_width = 0;
        this.text_height = 0;

        this.cursor_row = 0;
        this.cursor_col = 0;

        this.graphical = false;
        this.graphical_width = 0;
        this.graphical_height = 0;

        this.set_size_text(80, 25);
    }

    /** @override */
    put_char(row, col, chr, flags, bg_color, fg_color)
    {
        dbg_assert(row >= 0 && row < this.text_height);
        dbg_assert(col >= 0 && col < this.text_width);
        dbg_assert(chr >= 0 && chr < 0x100);

        const p = TEXT_BUF_COMPONENT_SIZE * (row * this.text_width + col);
        this.text[p + CHARACTER_INDEX] = chr;
        this.text[p + FLAGS_INDEX] = flags;
        this.text[p + BG_COLOR_INDEX] = bg_color;
        this.text[p + FG_COLOR_INDEX] = fg_color;
    }

    /** @override */
    destroy() {}

    /** @override */
    pause() {}

    /** @override */
    continue() {}

    /** @override */
    clear_text_state()
    {
        this.text_width = 0;
        this.text_height = 0;
    }

    /** @override */
    set_mode(graphical)
    {
        this.graphical = graphical;
    }

    /** @override */
    set_font_bitmap(height, width_9px, width_dbl, copy_8th_col, bitmap, bitmap_changed) {}

    /** @override */
    set_font_page(page_a, page_b) {}

    /** @override */
    clear_screen() {}

    /** @override */
    set_size_text(cols, rows)
    {
        if(cols === this.text_width && rows === this.text_height)
        {
            return;
        }

        this.text = new Int32Array(cols * rows * TEXT_BUF_COMPONENT_SIZE);
        this.text_width = cols;
        this.text_height = rows;
    }

    /** @override */
    set_size_graphical(width, height, buffer_width, buffer_height)
    {
        this.graphical_width = width;
        this.graphical_height = height;
    }

    /** @override */
    set_scale(s_x, s_y) {}

    /** @override */
    update_cursor_scanline(start, end, enabled) {}

    /** @override */
    update_cursor(row, col)
    {
        this.cursor_row = row;
        this.cursor_col = col;
    }

    /** @override */
    update_buffer(layers) {}

    /** @override */
    get_text_screen()
    {
        const screen = [];

        for(let i = 0; i < this.text_height; i++)
        {
            screen.push(this.get_text_row(i));
        }

        return screen;
    }

    /** @override */
    get_text_row(y)
    {
        let row = "";
        for(let col = 0; col < this.text_width; col++)
        {
            row += this.charmap[this.get_cell(y, col, CHARACTER_INDEX)];
        }
        return row;
    }

    /**
     * @param {number} row
     * @param {number} col
     * @param {number} component CHARACTER_INDEX .. FG_COLOR_INDEX
     * @return {number}
     */
    get_cell(row, col, component)
    {
        return this.text[TEXT_BUF_COMPONENT_SIZE * (row * this.text_width + col) + component];
    }
}

export { CHARACTER_INDEX as DUMMY_SCREEN_CHARACTER, BG_COLOR_INDEX as DUMMY_SCREEN_BG_COLOR, FG_COLOR_INDEX as DUMMY_SCREEN_FG_COLOR };
