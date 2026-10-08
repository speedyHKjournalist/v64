// GPU traces (docs/gpu-devices.md, "Tests"): what a display adapter's device
// sends its 3D renderer, recorded so the renderer can be run on it again
// without the guest (tests/glbridge/svga_trace_replay_browser_test.html). A
// batch is self-contained, so a trace is the batches in order.
//
// File: "V86GTRC1", then records of (u32 type, u32 length, bytes):
//   type 1: a D9WG batch, as the device submitted it
//   type 2: a JSON note (what made the trace)

import fs from "node:fs";
import { setImmediate as set_immediate } from "node:timers";

const MAGIC = "V86GTRC1";
export const TRACE_BATCH = 1;
export const TRACE_NOTE = 2;

/**
 * A renderer for the device's channel that renders nothing: it records each
 * batch and answers at once, readbacks with zeros and queries with 0. The
 * guest then runs as if its frames were black.
 * @param {string} file where the trace goes, or null to keep none
 * @param {Object} note written first
 */
export function create_trace_renderer(file, note)
{
    const fd = file ? fs.openSync(file, "w") : -1;
    const write = (type, bytes) => {
        if(fd < 0) return;
        const header = Buffer.alloc(8);
        header.writeUInt32LE(type, 0);
        header.writeUInt32LE(bytes.length, 4);
        fs.writeSync(fd, header);
        fs.writeSync(fd, bytes);
    };
    if(fd >= 0)
    {
        fs.writeSync(fd, Buffer.from(MAGIC));
        write(TRACE_NOTE, Buffer.from(JSON.stringify(note || {})));
    }
    let to_device = null;
    const stats = { batches: 0, bytes: 0, readbacks: 0, queries: 0 };
    const renderer = {
        "post": message => {
            if(message["type"] !== "submit") return;
            const bytes = message["bytes"];
            stats.batches++;
            stats.bytes += bytes.length;
            write(TRACE_BATCH, bytes);
            const answers = [];
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for(let at = 32; at < 32 + view.getUint32(20, true);)
            {
                const opcode = view.getUint16(at, true), size = view.getUint32(at + 4, true), p = at + 16;
                if(opcode === 12)
                {
                    // READBACK_SURFACE: zeros, as many as asked for
                    const count = view.getUint32(p + 36, true);
                    const answer = new Uint8Array(16 + count);
                    const a = new DataView(answer.buffer);
                    a.setUint32(0, view.getUint32(p + 44, true), true);
                    a.setUint32(4, count, true);
                    a.setUint32(12, 1, true);
                    answers.push({ "type": "write", "offset": view.getUint32(p + 40, true), "bytes": answer });
                    stats.readbacks++;
                }
                else if(opcode === 0x401)
                {
                    // END_QUERY: no samples
                    const answer = new Uint32Array([view.getUint32(p + 12, true), 0, 0, 1]);
                    answers.push({ "type": "write", "offset": view.getUint32(p + 8, true), "bytes": new Uint8Array(answer.buffer) });
                    stats.queries++;
                }
                at += size;
            }
            const seq = message["seq"];
            // later, as a renderer would answer
            set_immediate(() => {
                for(const answer of answers) to_device(answer);
                to_device({ "type": "done", "seq": seq });
            });
        },
        "listen": handler => { to_device = handler; },
    };
    return { renderer, stats, close: () => fd >= 0 && fs.closeSync(fd) };
}

/**
 * @param {!Uint8Array} bytes a trace file
 * @return {{note: Object, batches: !Array<!Uint8Array>}}
 */
export function read_trace(bytes)
{
    if(Buffer.from(bytes.subarray(0, 8)).toString() !== MAGIC) throw new Error("not a GPU trace");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let note = null;
    const batches = [];
    for(let at = 8; at + 8 <= bytes.length;)
    {
        const type = view.getUint32(at, true), length = view.getUint32(at + 4, true);
        const body = bytes.subarray(at + 8, at + 8 + length);
        if(type === TRACE_NOTE) note = JSON.parse(Buffer.from(body).toString());
        else if(type === TRACE_BATCH) batches.push(body);
        at += 8 + length;
    }
    return { note, batches };
}
