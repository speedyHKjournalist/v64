#!/usr/bin/env node

// The display boundary (src/display.js): the CPU Worker transport covers every
// device-facing call, and every presenter survives a text-mode save/restore.

import assert from "assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

if(!TEST_RELEASE_BUILD)
{
    const { DisplaySinkRecorder, DISPLAY_SINK_REPLAY } = await import("../../src/display.js");

    const recorded = [];
    const recorder = new DisplaySinkRecorder((name, args) => recorded.push([name, args]), () => {});
    const font = new Uint8Array(65536).fill(7);
    const calls = [
        ["set_mode", [true]],
        ["set_size_text", [80, 25]],
        ["set_size_graphical", [640, 480, 1024, 768]],
        ["put_char", [1, 2, 65, 3, 0x112233, 0x445566]],
        ["update_cursor", [4, 5]],
        ["update_cursor_scanline", [13, 14, true]],
        ["set_font_bitmap", [16, true, false, true, font, true]],
        ["set_font_page", [1, 2]],
        ["clear_screen", []],
        ["clear_text_state", []],
    ];
    for(const [name, args] of calls) recorder[name](...args);

    assert.deepEqual(recorded.map(([name]) => name).sort(), Object.keys(DISPLAY_SINK_REPLAY).sort(),
        "every recorded call has a replay entry and vice versa");
    assert.notEqual(recorded.find(([name]) => name === "set_font_bitmap")[1][4], font,
        "the font bitmap is snapshotted, not aliased");

    const replayed = [];
    const sink = new Proxy({}, { get: (_, name) => (...args) => replayed.push([name, args]) });
    for(const [name, args] of recorded) DISPLAY_SINK_REPLAY[name](sink, args);
    assert.deepEqual(replayed, calls, "replay applies each call with its arguments");

    console.log("PASS: display sink recorder and replay table agree");
}

for(const [name, screen] of [["dummy", undefined], ["ansi", { ansi: true }]])
{
    const emulator = new V86({
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        fda: { url: __dirname + "/../../images/freedos722.img" },
        screen,
        autostart: true,
        memory_size: 32 * 1024 * 1024,
        net_device: { type: "none" },
        disable_speaker: true,
        log_level: 0,
    });
    await new Promise(resolve => emulator.add_listener("emulator-ready", resolve));

    const booted = await emulator.wait_until_vga_screen_contains(/FreeDOS|SeaBIOS/, { timeout_msec: 60000 });
    assert.ok(booted, name + ": text appears on screen");
    const before = emulator.screen_adapter.get_text_screen().join("\n");

    const state = await emulator.save_state();
    await emulator.restore_state(state);
    const after = emulator.screen_adapter.get_text_screen().join("\n");
    assert.equal(after, before, name + ": the text screen survives a text-mode save/restore");
    if(name === "ansi") assert.match(after, /\x1B\[48;2;/, "ansi: rows carry truecolor escapes");

    await emulator.destroy();
    console.log("PASS: " + name + " presenter restores a text-mode state");
}

// Vertical retrace comes from the CRTC timing on the machine clock, not from
// the host drawing frames: in node nothing draws, and a program waiting for
// retrace must still see 70 of them per second (60 in 640x480 modes).
//
//     xor ax, ax / mov ds, ax / mov ax, MODE / int 0x10 / sti
//     mov bx, [0x46c] / mov cx, 70
//   frame: mov dx, 0x3da
//   .end:   in al, dx / test al, 8 / jnz .end     ; current retrace ends
//   .start: in al, dx / test al, 8 / jz .start    ; next one starts
//     loop frame
//     mov ax, [0x46c] / sub ax, bx                ; BIOS ticks (18.2 Hz) elapsed
//     serial: 'R', ticks, 'D' / hlt
const RETRACE_PROGRAM = [
    0x31, 0xc0, 0x8e, 0xd8, 0xb8, 0x13, 0x00, 0xcd, 0x10, 0xfb, 0x8b, 0x1e,
    0x6c, 0x04, 0xb9, 0x46, 0x00, 0xba, 0xda, 0x03, 0xec, 0xa8, 0x08, 0x75,
    0xfb, 0xec, 0xa8, 0x08, 0x74, 0xfb, 0xe2, 0xf1, 0xa1, 0x6c, 0x04, 0x29,
    0xd8, 0x88, 0xc3, 0xba, 0xf8, 0x03, 0xb0, 0x52, 0xee, 0x88, 0xd8, 0xee,
    0xb0, 0x44, 0xee, 0xf4, 0xeb, 0xfd,
];
const RETRACE_PROGRAM_MODE_OFFSET = 5;

async function count_retrace_ticks(mode, cpu_clock)
{
    const floppy = new Uint8Array(1474560);
    floppy.set(RETRACE_PROGRAM);
    floppy[RETRACE_PROGRAM_MODE_OFFSET] = mode;
    floppy[510] = 0x55;
    floppy[511] = 0xAA;

    const emulator = new V86({
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        fda: { buffer: floppy.buffer },
        boot_order: 0x321,
        autostart: true,
        memory_size: 32 * 1024 * 1024,
        net_device: { type: "none" },
        disable_speaker: true,
        cpu_clock,
        log_level: 0,
    });
    const output = [];
    const done = new Promise(resolve => emulator.add_listener("serial0-output-byte", byte => {
        output.push(byte);
        if(byte === 0x44 && output.length >= 3 && output[output.length - 3] === 0x52) resolve();
    }));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(
        "mode " + mode.toString(16) + ": the program never saw 70 retraces")), 120000));
    await Promise.race([done, timeout]);
    await emulator.destroy();
    return output[output.length - 2];
}

for(const [mode, hz] of [[0x03, 70], [0x13, 70], [0x12, 60]])
{
    const ticks = await count_retrace_ticks(mode);
    const expected = 70 / hz * 18.2065;
    assert.ok(Math.abs(ticks - expected) <= 4,
        `mode ${mode.toString(16)}: 70 retraces took ${ticks} ticks, expected about ${expected.toFixed(1)}`);
    console.log(`PASS: mode ${mode.toString(16)} retraces at about ${hz} Hz (${ticks} ticks for 70)`);
}

{
    const deterministic = { mode: "deterministic" };
    const first = await count_retrace_ticks(0x13, deterministic);
    const second = await count_retrace_ticks(0x13, deterministic);
    assert.equal(first, second, "deterministic clock: retrace timing is reproducible");
    assert.ok(Math.abs(first - 18.2) <= 4, `deterministic clock: ${first} ticks for 70 retraces`);
    console.log(`PASS: deterministic clock reproduces retrace timing (${first} ticks twice)`);
}
