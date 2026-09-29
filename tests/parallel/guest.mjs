// Helpers for the host-parallel tests: linux4 (Linux 4.16, 32-bit, the CD's
// own kernel booted directly) and a serial shell on it.
import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";

export const ROOT = url.fileURLToPath(new URL("../../", import.meta.url));
export const PARALLEL_WASM = process.env.V86_PARALLEL_WASM || ROOT + "build/v86-parallel.wasm";

/** A file of an ISO9660 image, by its path of directory names */
export function iso_file(path, names)
{
    const iso = fs.readFileSync(path);
    let extent = iso.readUInt32LE(16 * 2048 + 156 + 2);
    let size = iso.readUInt32LE(16 * 2048 + 156 + 10);
    for(const name of names)
    {
        let found = false;
        for(let at = extent * 2048; at < extent * 2048 + size;)
        {
            const length = iso[at];
            if(!length) { at = (Math.floor(at / 2048) + 1) * 2048; continue; }
            const id = iso.toString("latin1", at + 33, at + 33 + iso[at + 32]).replace(/;1$/, "").replace(/\.$/, "");
            if(id === name)
            {
                extent = iso.readUInt32LE(at + 2);
                size = iso.readUInt32LE(at + 10);
                found = true;
                break;
            }
            at += length;
        }
        assert.ok(found, name + " in " + path);
    }
    return iso.buffer.slice(iso.byteOffset + extent * 2048, iso.byteOffset + extent * 2048 + size);
}

export function linux4_options()
{
    const iso = ROOT + "images/linux4.iso";
    return {
        bios: { url: ROOT + "bios/seabios.bin" },
        vga_bios: { url: ROOT + "bios/vgabios.bin" },
        cdrom: { url: iso },
        bzimage: { buffer: iso_file(iso, ["BOOT", "BZIMAGE"]) },
        cmdline: "root=/dev/sr0 nokaslr",
        acpi: true,
        autostart: true,
        log_level: 0,
    };
}

const PROMPT = /~% $/;

/** A serial console shell on a V86 instance */
export class Shell
{
    constructor(emulator, name)
    {
        this.emulator = emulator;
        this.name = name;
        this.serial = "";
        this.waiter = null;
        emulator.add_listener("serial0-output-byte", byte => {
            this.serial += String.fromCharCode(byte);
            if(this.waiter && this.waiter.pattern.test(this.serial))
            {
                const { resolve } = this.waiter;
                this.waiter = null;
                resolve(this.serial);
            }
        });
    }
    wait(pattern, what, timeout_ms)
    {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(this.name + ": timed out waiting for " + what + "\n" + this.serial.slice(-2000))), timeout_ms);
            this.waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
            if(pattern.test(this.serial))
            {
                this.waiter = null;
                clearTimeout(timer);
                resolve(this.serial);
            }
        });
    }
    async boot(timeout_ms = 300000)
    {
        await this.wait(PROMPT, "the shell", timeout_ms);
    }
    /** Run a command; its output without the echoed command line */
    async run(command, timeout_ms = 120000)
    {
        this.serial = "";
        this.emulator.serial0_send(command + "\n");
        const output = await this.wait(PROMPT, JSON.stringify(command), timeout_ms);
        return output.slice(command.length);
    }
}

export function value_of(output, key)
{
    const match = output.match(new RegExp(key + "=(\\S+)"));
    assert.ok(match, "no " + key + "= in " + JSON.stringify(output));
    return match[1];
}
