#!/usr/bin/env node
// x86_64 Linux (Alpine 3.24, the official virt ISO) on a display adapter:
// installs Mesa and the GPU test programs from build/x64-linux/gpu-repo.tar
// (tools/alpine_gpu_repo.mjs), loads the adapter's DRM driver and runs the
// steps of a scenario on the serial console, saving screenshots.
//
//     GPU_ADAPTER=bochs_vga node tests/x64/linux_gpu.mjs
//
// GPU_ADAPTER: bochs_vga (default), vmware_svga, virtio_gpu
// GPU_SCENARIO: the steps below (default: drm)
// GPU_LEVEL: pins the adapter's level (graphics_adapter_test), e.g. 2d or 2d-full;
// vgpu9 records the 3D batches into <out>/trace.bin (tests/x64/gpu_trace.mjs),
// or with GPU_RENDERER=chrome draws them on the GPU of a headless Chrome
// GPU_OUT: the output directory (default build/x64-linux/gpu-<adapter>[-<level>]/)
// SHOW_LOGS=1: echo the serial console; LINUX_GPU_TIMEOUT: ms (default 900000)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deflateSync as deflate_sync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { create_trace_renderer } from "./gpu_trace.mjs";
import { create_remote_renderer } from "./gpu_remote_renderer.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = root + "build/x64-linux/";
const adapter = process.env.GPU_ADAPTER || "bochs_vga";
const scenario = process.env.GPU_SCENARIO || "drm";
const out = process.env.GPU_OUT || path.join(directory, "gpu-" + adapter + (process.env.GPU_LEVEL ? "-" + process.env.GPU_LEVEL : ""));
fs.mkdirSync(out, { recursive: true });

const iso = directory + "alpine-virt-3.24.0-x86_64.iso";
const repo = directory + "gpu-repo.tar";
for(const file of [iso, directory + "boot/vmlinuz-virt", directory + "boot/initramfs-virt"])
{
    assert.ok(fs.existsSync(file), file + " is missing: run tests/x64/linux_boot.mjs once (X64_LINUX_PREPARE_ONLY=1)");
}
assert.ok(fs.existsSync(repo), repo + " is missing: run tools/alpine_gpu_repo.mjs");

const DRIVER = { bochs_vga: "bochs", vmware_svga: "vmwgfx", virtio_gpu: "virtio_gpu" }[adapter];
assert.ok(DRIVER, "GPU_ADAPTER is bochs_vga, vmware_svga or virtio_gpu");

const APK = "apk add --no-network --repository /mnt/repo/main --repository /mnt/repo/community";
const SCENARIOS = {
    // KMS through the adapter's DRM driver: modes, a test pattern, kmscube
    drm: [
        ["mkdir -p /mnt/repo && tar -xf /dev/sda -C /mnt/repo && echo STEP_REPO_OK", /STEP_REPO_OK/],
        [APK + " kmscube libdrm-tests mesa-dri-gallium mesa-utils >/tmp/apk.log 2>&1; echo STEP_APK_RC=$?; tail -15 /tmp/apk.log", /STEP_APK_RC=0/],
        [`modprobe ${DRIVER} && sleep 2 && ls /dev/dri && echo STEP_DRM_OK`, /STEP_DRM_OK/],
        [`dmesg | grep -i -E '${DRIVER}|drm' | tail -40; echo STEP_DMESG_DONE`, /STEP_DMESG_DONE/],
        ["modetest -c 2>&1 | head -30; echo STEP_MODES_DONE", /STEP_MODES_DONE/],
        ["SCREENSHOT console", null],
        // (a screenshot 20 s into the command, while it draws)
        // (with 3D the 400 frames take seconds, not a minute)
        ["kmscube -c 400 2>&1 | grep -E 'Rendered|renderer'", /Rendered [1-9]\d* frames/,
            { screenshot: "kmscube", after: process.env.GPU_LEVEL === "vgpu9" ? 2500 : 20000 }],
    ],
};
const steps = SCENARIOS[scenario];
assert.ok(steps, "unknown GPU_SCENARIO " + scenario);

/**
 * A presenter that keeps the guest's picture, for screenshots in node
 */
class PictureSink
{
    constructor() { this.width = 0; this.height = 0; this.rgba = new Uint8Array(0); this.graphical = false; this.text = []; }
    set_mode(graphical) { this.graphical = graphical; }
    set_size_text(cols, rows) { this.text = Array.from({ length: rows }, () => " ".repeat(cols)); }
    set_size_graphical(width, height) { this.width = width; this.height = height; this.rgba = new Uint8Array(width * height * 4); }
    put_char(row, col, chr) { const line = this.text[row]; if(line !== undefined) this.text[row] = line.slice(0, col) + String.fromCharCode(chr) + line.slice(col + 1); }
    update_cursor() {}
    update_cursor_scanline() {}
    set_font_bitmap() {}
    set_font_page() {}
    clear_screen() {}
    clear_text_state() {}
    update_buffer(layers)
    {
        for(const layer of layers)
        {
            const { pixels } = layer;
            for(let y = 0; y < layer.buffer_height; y++)
            {
                const sy = layer.buffer_y + y, dy = layer.screen_y + y;
                if(dy >= this.height) break;
                const from = (sy * pixels.width + layer.buffer_x) * 4;
                const count = Math.min(layer.buffer_width, this.width - layer.screen_x) * 4;
                this.rgba.set(pixels.data.subarray(from, from + count), (dy * this.width + layer.screen_x) * 4);
            }
        }
    }
    pause() {}
    continue() {}
    destroy() {}
    set_scale() {}
    get_text_screen() { return this.text; }
    get_text_row(y) { return this.text[y] || ""; }
}

function save_png(sink, name)
{
    const { width, height, rgba } = sink;
    if(!width) return null;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for(let y = 0; y < height; y++)
    {
        for(let x = 0; x < width; x++)
        {
            const s = (y * width + x) * 4, d = y * (width * 3 + 1) + 1 + x * 3;
            raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
        }
    }
    const crc = data => { let c = 0xFFFFFFFF; for(const byte of data) { c ^= byte; for(let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (tag, data) => { const body = Buffer.concat([Buffer.from(tag), data]), b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); body.copy(b, 4); b.writeUInt32BE(crc(body), b.length - 4); return b; };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const file = path.join(out, name + ".png");
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate_sync(raw)), chunk("IEND", Buffer.alloc(0))]));
    return file;
}

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const sink = new PictureSink();
// A 3D level needs a renderer: the real one in a headless Chrome
// (GPU_RENDERER=chrome, tests/x64/gpu_remote_renderer.mjs), or one that
// records the batches into a trace (tests/x64/gpu_trace.mjs) and renders nothing
const remote = process.env.GPU_LEVEL === "vgpu9" && process.env.GPU_RENDERER === "chrome" ? await create_remote_renderer() : null;
const trace = process.env.GPU_LEVEL === "vgpu9" && !remote ?
    create_trace_renderer(path.join(out, "trace.bin"), { adapter, level: process.env.GPU_LEVEL, scenario }) : null;
const emulator = new V86({
    graphics_adapter: adapter,
    wasm_path: process.env.WASM_PATH,
    bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
    bzimage: { url: directory + "boot/vmlinuz-virt" }, initrd: { url: directory + "boot/initramfs-virt" },
    cdrom: { url: iso }, hda: { url: repo },
    cmdline: "console=ttyS0,115200 loglevel=4 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage",
    memory_size: Number(process.env.LINUX_GPU_MEMORY || 1024) << 20, acpi: true, autostart: false,
    disable_jit: !!+process.env.LINUX_GPU_NO_JIT, experimental_smp_jit: !+process.env.LINUX_GPU_NO_JIT,
    log_level: 0, net_device: { type: "none" }, screen_adapter: sink,
    ...(process.env.VRAM_SIZE ? { vram_size: Number(process.env.VRAM_SIZE) } : {}),
    ...(process.env.GPU_LEVEL ? { graphics_adapter_test: { level: process.env.GPU_LEVEL, renderer: remote ? remote.renderer : trace && trace.renderer } } : {}),
});

let serial = "";
// the guest drivers' logs through the VMware backdoor (vmwgfx's host log)
emulator.add_listener("vmware-log", text => console.log("guest-log: " + String(text).trim()));
emulator.add_listener("serial0-output-byte", byte => {
    const c = String.fromCharCode(byte);
    serial += c;
    if(+process.env.SHOW_LOGS) process.stdout.write(c);
});

const started = performance.now();
const elapsed = () => ((performance.now() - started) / 1000).toFixed(0) + "s";
const deadline = started + Number(process.env.LINUX_GPU_TIMEOUT || 900000);

async function wait_for(pattern, from)
{
    while(performance.now() < deadline)
    {
        const tail = serial.slice(from);
        if(pattern.test(tail)) return tail;
        if(/Kernel panic/.test(serial)) throw new Error("Kernel panic");
        await delay(20);
    }
    throw new Error("timed out waiting for " + pattern);
}

/** A step's third element: { screenshot, after } */
const arguments_of = step => step[2] || {};

let failed = false;
try
{
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    const cpu = emulator.v86.cpu;
    cpu.wm.exports.set_x64_test_capabilities(1);
    emulator.run();
    // GPU_DEBUG_BLITS=n: the first n BLIT_SURFACE_TO_SCREEN commands and what came of them
    const svga3d_debug = cpu.devices.graphics_adapter && cpu.devices.graphics_adapter.device["svga"]?.svga3d;
    if(svga3d_debug && +process.env.GPU_DEBUG_BLITS)
    {
        let left = +process.env.GPU_DEBUG_BLITS;
        const blit = svga3d_debug.blit_surface_to_screen.bind(svga3d_debug), to_desktop = svga3d_debug.to_desktop.bind(svga3d_debug);
        svga3d_debug.blit_surface_to_screen = p => { if(left > 0) console.log("BLIT_SURFACE_TO_SCREEN " + Array.from(p).join(" ")); blit(p); };
        svga3d_debug.to_desktop = (...args) => {
            if(left-- > 0)
            {
                const [surface] = args;
                console.log("to_desktop format=" + surface.format + " sizes=" + JSON.stringify(surface.sizes) + " " + args.slice(1).map(a => JSON.stringify(a)).join(" ") +
                    " screens=" + JSON.stringify([...svga3d_debug.device.screens.screens.values()].map(s => [s.id, s.x, s.y, s.width, s.height])));
            }
            to_desktop(...args);
        };
    }

    await wait_for(/localhost login:/, 0);
    emulator.serial0_send("root\n");
    await wait_for(/localhost:~# /, 0);
    console.log(`[${elapsed()}] logged in`);

    for(const step of steps)
    {
        const [command, expect] = step;
        if(command.startsWith("SCREENSHOT "))
        {
            // nothing presents in node: ask for a whole frame first
            cpu.devices.display.request_frame(true);
            const file = save_png(sink, command.slice(11));
            console.log(`[${elapsed()}] screenshot ${file || "(text mode)"}`);
            continue;
        }
        const from = serial.length;
        emulator.serial0_send(command + "\n");
        const options = arguments_of(step);
        if(options.screenshot)
        {
            await delay(options.after);
            cpu.devices.display.request_frame(true);
            console.log(`[${elapsed()}] screenshot ${save_png(sink, options.screenshot)}`);
        }
        // the command is done when the prompt comes back after its output
        const tail = await wait_for(/\n[^\n]*localhost:~# /, from + command.length);
        console.log(`[${elapsed()}] $ ${command}\n` + tail.replace(/\r/g, "").split("\n").slice(1, -1).join("\n"));
        if(!expect.test(tail)) throw new Error("step failed: " + command);
    }
    console.log("LINUX_GPU_DONE " + adapter + " " + scenario);
}
catch(error)
{
    failed = true;
    console.error("LINUX_GPU_FAIL " + adapter + ": " + error.message + "\n" + error.stack);
    emulator.v86 && emulator.v86.cpu.devices.display && emulator.v86.cpu.devices.display.request_frame(true);
    save_png(sink, "failure");
}
finally
{
    fs.writeFileSync(path.join(out, "serial.log"), serial);
    const svga3d = emulator.v86 && emulator.v86.cpu.devices.graphics_adapter && emulator.v86.cpu.devices.graphics_adapter.device["svga"]?.svga3d;
    if(svga3d) console.log("svga3d commands: " + JSON.stringify(svga3d.counts));
    if(remote)
    {
        remote.close();
        console.log("renderer: " + JSON.stringify(remote.stats));
    }
    if(trace)
    {
        trace.close();
        console.log("trace: " + JSON.stringify(trace.stats) + " in " + path.join(out, "trace.bin"));
    }
    emulator.destroy();
}
process.exit(failed ? 1 : 0);
