// The EDID virtio-gpu gives the guest for a display (GET_EDID): an EDID 1.4
// base block whose preferred timing is the display's size, plus the usual
// established and standard timings, a range limits descriptor wide enough for
// custom resolutions, and a name.

/** EDID's limit for the preferred mode's active pixels (12 bits) */
const MAX_ACTIVE = 4095;

// Standard timings: width, aspect code (0 16:10, 1 4:3, 2 5:4, 3 16:9), at 60 Hz
const STANDARD_TIMINGS = [
    [1280, 3], [1280, 0], [1280, 2], [1440, 0], [1600, 3], [1680, 0], [1920, 3], [1600, 1],
];

/**
 * Three letters as EDID's manufacturer ID
 * @param {string} name
 * @return {number}
 */
function manufacturer(name)
{
    const letter = i => name.charCodeAt(i) - 64;
    return letter(0) << 10 | letter(1) << 5 | letter(2);
}

/**
 * A detailed timing descriptor (reduced blanking, 60 Hz)
 * @param {!Uint8Array} out
 * @param {number} at
 * @param {number} width
 * @param {number} height
 * @param {number} width_mm
 * @param {number} height_mm
 */
function detailed_timing(out, at, width, height, width_mm, height_mm)
{
    const h_front = 48, h_sync = 32, h_blank = 160;
    const v_front = 3, v_sync = 6, v_blank = Math.max(23, Math.ceil(height * 0.0083 / (1 - 0.0083)) + 9);
    // in 10 kHz
    const clock = Math.round((width + h_blank) * (height + v_blank) * 60 / 10000);
    out[at] = clock & 0xFF;
    out[at + 1] = clock >> 8;
    out[at + 2] = width & 0xFF;
    out[at + 3] = h_blank & 0xFF;
    out[at + 4] = (width >> 8) << 4 | h_blank >> 8;
    out[at + 5] = height & 0xFF;
    out[at + 6] = v_blank & 0xFF;
    out[at + 7] = (height >> 8) << 4 | v_blank >> 8;
    out[at + 8] = h_front & 0xFF;
    out[at + 9] = h_sync & 0xFF;
    out[at + 10] = (v_front & 0xF) << 4 | v_sync & 0xF;
    out[at + 11] = (h_front >> 8) << 6 | (h_sync >> 8) << 4 | (v_front >> 4) << 2 | v_sync >> 4;
    out[at + 12] = width_mm & 0xFF;
    out[at + 13] = height_mm & 0xFF;
    out[at + 14] = (width_mm >> 8) << 4 | height_mm >> 8;
    // digital separate sync, +hsync -vsync (CVT reduced blanking)
    out[at + 17] = 0x1A;
}

/**
 * A text descriptor (name 0xFC, serial 0xFF)
 * @param {!Uint8Array} out
 * @param {number} at
 * @param {number} tag
 * @param {string} text
 */
function text_descriptor(out, at, tag, text)
{
    out[at + 3] = tag;
    const bytes = Array.from(text.slice(0, 13), c => c.charCodeAt(0));
    if(bytes.length < 13) bytes.push(0x0A);
    while(bytes.length < 13) bytes.push(0x20);
    out.set(bytes, at + 5);
}

/**
 * @param {number} width the preferred mode
 * @param {number} height
 * @param {number} serial
 * @return {!Uint8Array} 128 bytes
 */
export function make_edid(width, height, serial)
{
    width = Math.max(640, Math.min(MAX_ACTIVE, width));
    height = Math.max(480, Math.min(MAX_ACTIVE, height));
    const out = new Uint8Array(128);
    out.set([0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
    // manufacturer "VEM" (big-endian), product 0x1050, serial
    const id = manufacturer("VEM");
    out[8] = id >> 8;
    out[9] = id & 0xFF;
    out[10] = 0x50;
    out[11] = 0x10;
    out[12] = serial & 0xFF;
    out[13] = serial >> 8 & 0xFF;
    out[14] = serial >> 16 & 0xFF;
    out[15] = serial >>> 24;
    // week 0, 2026; EDID 1.4
    out[16] = 0;
    out[17] = 2026 - 1990;
    out[18] = 1;
    out[19] = 4;
    // digital, 8 bits per colour, DisplayPort
    out[20] = 0xA5;
    // the size, in cm, at 96 pixels per inch
    const width_mm = Math.round(width * 25.4 / 96), height_mm = Math.round(height * 25.4 / 96);
    out[21] = Math.min(255, Math.round(width_mm / 10));
    out[22] = Math.min(255, Math.round(height_mm / 10));
    // gamma 2.2
    out[23] = 120;
    // RGB 4:4:4, sRGB, the preferred timing is native, continuous frequency
    out[24] = 0x07;
    // sRGB chromaticity (10-bit coordinates)
    const [rx, ry, gx, gy, bx, by, wx, wy] = [0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290].map(v => Math.round(v * 1024));
    out[25] = (rx & 3) << 6 | (ry & 3) << 4 | (gx & 3) << 2 | gy & 3;
    out[26] = (bx & 3) << 6 | (by & 3) << 4 | (wx & 3) << 2 | wy & 3;
    out.set([rx >> 2, ry >> 2, gx >> 2, gy >> 2, bx >> 2, by >> 2, wx >> 2, wy >> 2], 27);
    // established: 640x480@60, 800x600@60, 1024x768@60
    out[35] = 0x21;
    out[36] = 0x08;
    out[37] = 0;
    STANDARD_TIMINGS.forEach(([w, aspect], i) => {
        out[38 + 2 * i] = w / 8 - 31;
        out[39 + 2 * i] = aspect << 6;
    });
    detailed_timing(out, 54, width, height, width_mm, height_mm);
    // range limits: 50-75 Hz, 30-250 kHz, up to 1270 MHz (default GTF)
    out.set([0, 0, 0, 0xFD, 0, 50, 75, 30, 250, 127, 0x00, 0x0A, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20], 72);
    text_descriptor(out, 90, 0xFC, "v86 virtio");
    text_descriptor(out, 108, 0xFF, "V86-" + serial.toString(16).toUpperCase());
    let sum = 0;
    for(let i = 0; i < 127; i++) sum += out[i];
    out[127] = -sum & 0xFF;
    return out;
}
