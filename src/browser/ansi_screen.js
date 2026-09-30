import { DummyScreenAdapter, DUMMY_SCREEN_CHARACTER, DUMMY_SCREEN_BG_COLOR, DUMMY_SCREEN_FG_COLOR } from "./dummy_screen.js";

const ANSI_RESET = "\x1B[0m";

/**
 * @param {number} color 0xRRGGBB
 * @return {string}
 */
function hex_to_ansi_truecolor(color)
{
    const
        RED   = (color & 0xFF0000) >> 16,
        GREEN = (color & 0x00FF00) >> 8,
        BLUE  = (color & 0x0000FF);

    return `2;${RED};${GREEN};${BLUE}`;
}

/**
 * The text screen as rows of ANSI truecolor escape sequences
 */
export class ANSIScreenAdapter extends DummyScreenAdapter
{
    /** @param {Object=} options */
    constructor(options)
    {
        super(options);
    }

    /** @override */
    get_text_row(y)
    {
        let previous_bg = null;
        let previous_fg = null;
        let row = "";
        for(let col = 0; col < this.text_width; col++)
        {
            const chr = this.charmap[this.get_cell(y, col, DUMMY_SCREEN_CHARACTER)];
            const bg_color = this.get_cell(y, col, DUMMY_SCREEN_BG_COLOR);
            const fg_color = this.get_cell(y, col, DUMMY_SCREEN_FG_COLOR);

            let ansi_code = "";
            // combine previous colors with current ones if possible
            if(previous_bg !== bg_color)
            {
                ansi_code += `\x1B[48;${hex_to_ansi_truecolor(bg_color)}m`;
                previous_bg = bg_color;
            }
            if(previous_fg !== fg_color)
            {
                ansi_code += `\x1B[38;${hex_to_ansi_truecolor(fg_color)}m`;
                previous_fg = fg_color;
            }
            row += ansi_code + chr;
        }
        return row + ANSI_RESET;
    }
}
